import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScryRepository } from "../src/repository.js";

const databaseUrl = process.env.SCRY_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;

describeDatabase("PostgreSQL persistence", () => {
  beforeAll(async () => {
    const existing = await pool!.query("SELECT to_regclass('public.projects') AS table_name");
    if (!existing.rows[0]?.table_name) {
      const migration = await readFile(
        fileURLToPath(new URL("../migrations/0001_initial.sql", import.meta.url)),
        "utf8",
      );
      await pool!.query(migration);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("preserves immutable run snapshots and append-only events", async () => {
    const project = (
      await pool!.query(
        "INSERT INTO projects(name) VALUES ($1) RETURNING id",
        [`Project ${randomUUID()}`],
      )
    ).rows[0];
    const policy = {
      policyVersion: "1",
      allowedOrigins: ["https://staging.example.com"],
      allowPrivateNetwork: false,
      allowDownloads: false,
      allowPopups: false,
      maxActions: 10,
      maxDurationMs: 10_000,
      maxNavigations: 2,
    };
    const environment = (
      await pool!.query(
        `INSERT INTO environments(project_id, name, base_origin, policy)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [project.id, `staging-${randomUUID()}`, "https://staging.example.com", policy],
      )
    ).rows[0];
    const specification = (
      await pool!.query(
        "INSERT INTO test_specifications(project_id, name) VALUES ($1, $2) RETURNING id",
        [project.id, "Signup"],
      )
    ).rows[0];
    const specificationVersion = (
      await pool!.query(
        `INSERT INTO specification_versions(specification_id, version, content)
         VALUES ($1, 1, $2) RETURNING id`,
        [specification.id, { objective: "Signup" }],
      )
    ).rows[0];
    const plan = { protocolVersion: "1", name: "Signup", steps: [] };
    const planVersion = (
      await pool!.query(
        `INSERT INTO plan_versions(specification_version_id, version, protocol_version, plan)
         VALUES ($1, 1, '1', $2) RETURNING id`,
        [specificationVersion.id, plan],
      )
    ).rows[0];
    const run = (
      await pool!.query(
        `INSERT INTO runs(
          project_id, environment_id, plan_version_id, plan_snapshot,
          environment_snapshot, policy_snapshot, execution_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          project.id,
          environment.id,
          planVersion.id,
          plan,
          { baseOrigin: "https://staging.example.com" },
          policy,
          { browser: "chromium", viewport: { width: 1280, height: 720 }, seed: 1 },
        ],
      )
    ).rows[0];
    await pool!.query("UPDATE plan_versions SET plan = $2 WHERE id = $1", [
      planVersion.id,
      { changed: true },
    ]);
    const persisted = (await pool!.query("SELECT plan_snapshot FROM runs WHERE id = $1", [run.id]))
      .rows[0];
    expect(persisted.plan_snapshot).toEqual(plan);

    const attempt = (
      await pool!.query(
        `INSERT INTO attempts(run_id, attempt_number, state) VALUES ($1, 1, 'running')
         RETURNING id`,
        [run.id],
      )
    ).rows[0];
    await pool!.query(
      `INSERT INTO run_events(attempt_id, sequence, type, payload, occurred_at)
       VALUES ($1, 1, 'attempt.started', '{}', now())`,
      [attempt.id],
    );
    await expect(
      pool!.query(
        `INSERT INTO run_events(attempt_id, sequence, type, payload, occurred_at)
         VALUES ($1, 1, 'attempt.started', '{}', now())`,
        [attempt.id],
      ),
    ).rejects.toThrow();
  });

  it("keeps the latest executable Flow visible after an incomplete revision", async () => {
    const project = (
      await pool!.query(
        "INSERT INTO projects(name) VALUES ($1) RETURNING id",
        [`Recoverable Flow ${randomUUID()}`],
      )
    ).rows[0];
    const specification = (
      await pool!.query(
        "INSERT INTO test_specifications(project_id, name) VALUES ($1, $2) RETURNING id",
        [project.id, "Credential journey"],
      )
    ).rows[0];
    const executable = (
      await pool!.query(
        `INSERT INTO specification_versions(specification_id, version, content)
         VALUES ($1, 1, $2) RETURNING id`,
        [specification.id, { objective: "Capture the generated secret" }],
      )
    ).rows[0];
    const plan = { protocolVersion: "1", name: "Credential journey", steps: [] };
    const planVersion = (
      await pool!.query(
        `INSERT INTO plan_versions(specification_version_id, version, protocol_version, plan)
         VALUES ($1, 1, '1', $2) RETURNING id`,
        [executable.id, plan],
      )
    ).rows[0];
    await pool!.query(
      `INSERT INTO specification_versions(specification_id, version, content)
       VALUES ($1, 2, $2)`,
      [specification.id, { objective: "Incomplete correction" }],
    );

    const repository = new ScryRepository({ query: pool!.query.bind(pool) } as never);
    const flows = await repository.listSpecifications({ kind: "service", subject: "scry-service" }, project.id);

    expect(flows[0]).toMatchObject({
      latestVersion: 1,
      latestContent: { objective: "Capture the generated secret" },
      latestPlanVersionId: planVersion.id,
      latestPlan: plan,
    });
  });
});
