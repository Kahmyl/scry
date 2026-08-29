import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";
import {
  expandBaselineStage,
  OPTIONAL_BASELINE_MIGRATIONS,
  type OptionalBaselineMigration,
} from "../scripts/migration-fingerprint-compatibility.js";

const databaseUrl = process.env.SCRY_M6_Q5_UPGRADE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const previous = "15b258b1b7c1f6d446d2addaab7e25f5c0e111dba3a87210679d9aea50e03237";

integration("authoritative Q5 immediate-predecessor upgrade", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  let database: Database;
  afterAll(async () => database?.onModuleDestroy());

  it("rolls back a failed migration and upgrades without creating authority", async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    const installed = await database.query<{ present: boolean }>(
      `SELECT to_regclass('schema_baseline') IS NOT NULL AS present`,
    );
    if (!installed.rows[0]?.present) {
      await database.query(await immediatePredecessorSql());
      await database.query(`INSERT INTO schema_baseline(schema_fingerprint) VALUES($1)`, [
        previous,
      ]);
    }
    expect(await fingerprint()).toBe(previous);
    expect(await relation("q5_authoritative_attempts")).toBe(false);
    const migration = await readFile(
      new URL("../migrations/authoritative-q5-qualification.sql", import.meta.url),
      "utf8",
    );
    await expect(
      database.transaction(async (client) => {
        await client.query(migration);
        await client.query("SELECT * FROM q5_intentional_missing_relation");
      }),
    ).rejects.toBeDefined();
    expect(await fingerprint()).toBe(previous);
    expect(await relation("q5_authoritative_attempts")).toBe(false);
    execFileSync("pnpm", ["--filter", "@scry/api", "db:migrate"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl! },
      stdio: "pipe",
    });
    const expected = execFileSync("node", ["scripts/schema-fingerprint.mjs"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(await fingerprint()).toBe(expected);
    expect(await relation("q5_authoritative_attempts")).toBe(true);
    expect(
      await database.query(`SELECT count(*)::int count FROM q5_authoritative_attempts`),
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  async function fingerprint() {
    const result = await database.query<{ value: string }>(
      `SELECT schema_fingerprint AS value FROM schema_baseline WHERE singleton=true`,
    );
    return result.rows[0]!.value;
  }

  async function relation(name: string) {
    const result = await database.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [name],
    );
    return result.rows[0]!.present;
  }

  async function immediatePredecessorSql() {
    const migrationRoot = new URL("../migrations/", import.meta.url);
    const baseline = await readFile(new URL("baseline.sql", migrationRoot), "utf8");
    const sources = Object.fromEntries(
      await Promise.all(
        OPTIONAL_BASELINE_MIGRATIONS.map(async (name) => [
          name,
          await readFile(new URL(name, migrationRoot), "utf8"),
        ]),
      ),
    ) as Record<OptionalBaselineMigration, string>;
    const expanded = expandBaselineStage(
      baseline,
      sources,
      OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "authoritative-q5-qualification.sql"),
    );
    const calibration = await readFile(
      new URL("calibration-foundation.sql", migrationRoot),
      "utf8",
    );
    const capsule = await readFile(new URL("protected-capsule.sql", migrationRoot), "utf8");
    return expanded
      .replace("\\ir calibration-foundation.sql", () => calibration)
      .replace("\\ir protected-capsule.sql", () => capsule);
  }
});
