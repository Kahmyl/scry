import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";

const databaseUrl = process.env.SCRY_M6_UPGRADE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const preM6Fingerprint = "e8231b47b9a826867621a68305fe6329a49028f13d072492fa469ed6a0468fbb";
const m6Fingerprint = "d313f0eb931d79a98310c664cd3e2a677f7d10e3d2259cefbe4e5f51018e78f9";

integration("Milestone 6 qualification authorization schema upgrade", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const migrationPath = fileURLToPath(
    new URL("../migrations/qualification-campaign-safety.sql", import.meta.url),
  );
  let database: Database;
  const ids = Object.fromEntries(
    [
      "workspace",
      "project",
      "environment",
      "mission",
      "objective",
      "agent",
      "flow",
      "revision",
      "run",
    ].map((name) => [name, randomUUID()]),
  );

  afterAll(async () => database?.onModuleDestroy());

  it("preserves historical truth, grants no capability, and rolls back atomically", async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    expect(await fingerprint()).toBe(preM6Fingerprint);
    expect(await hasCampaignTable()).toBe(false);
    await seedHistoricalRun();

    const before = await historicalTruth();
    const migration = await readFile(migrationPath, "utf8");
    await expect(
      database.transaction(async (client) => {
        await client.query(migration);
        await client.query("SELECT * FROM m6_intentional_missing_relation");
      }),
    ).rejects.toBeDefined();
    expect(await fingerprint()).toBe(preM6Fingerprint);
    expect(await hasCampaignTable()).toBe(false);
    expect(await historicalTruth()).toEqual(before);

    execFileSync("pnpm", ["--filter", "@scry/api", "db:migrate"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl! },
      stdio: "pipe",
    });

    expect(await fingerprint()).toBe(m6Fingerprint);
    expect(await hasCampaignTable()).toBe(true);
    expect(await historicalTruth()).toEqual({ ...before, campaignId: null });
    expect(
      await database.query(
        `SELECT count(*)::int AS count FROM qualification_campaign_authorizations`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
    expect(
      await database.query(
        `SELECT count(*)::int AS count FROM qualification_campaign_mutation_consumptions`,
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
    expect(
      await database.query(
        `SELECT count(*)::int AS count FROM pg_trigger
          WHERE tgrelid='runs'::regclass AND tgname='qualification_campaign_run_binding'
            AND NOT tgisinternal`,
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  async function seedHistoricalRun() {
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'M6 upgrade',$2)`, [
      ids.workspace,
      `m6-upgrade-${ids.workspace}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'M6 upgrade')`, [
      ids.project,
      ids.workspace,
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'M6 upgrade','http://127.0.0.1:45679',$3::jsonb)`,
      [
        ids.environment,
        ids.project,
        JSON.stringify({
          allowedOrigins: ["http://127.0.0.1:45679"],
          allowPrivateNetwork: true,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 20,
          maxDurationMs: 60_000,
          maxNavigations: 10,
        }),
      ],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status)
       VALUES($1,$2,'M6 upgrade','Preserve historical Run','running')`,
      [ids.mission, ids.project],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order,status)
       VALUES($1,$2,'Historical objective','[]'::jsonb,0,'running')`,
      [ids.objective, ids.mission],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key,project_id,workspace_id)
       VALUES($1,$2,'ollama','Historical M6 fixture',$3,$4,$5)`,
      [ids.agent, ids.mission, `m6-upgrade-${ids.agent}`, ids.project, ids.workspace],
    );
    await database.transaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO flows(
           id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,
           origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id
         ) VALUES($1,$2,'Historical M6 flow',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
        [ids.flow, ids.project, ids.revision, ids.mission, ids.objective, ids.agent],
      );
      await client.query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason)
         VALUES($1,$2,1,'{}','{}','{}',$3,'Historical M6 fixture')`,
        [ids.revision, ids.flow, ids.agent],
      );
    });
    await database.query(
      `INSERT INTO runs(
         id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,
         state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,
         execution_snapshot,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'failed','completed','{}','{}','{}',$8::jsonb,'{}',$9)`,
      [
        ids.run,
        ids.project,
        ids.mission,
        ids.objective,
        ids.agent,
        ids.environment,
        ids.revision,
        JSON.stringify({ schemaVersion: 1, digest: "a".repeat(64) }),
        `m6-upgrade-run-${ids.run}`,
      ],
    );
  }

  async function fingerprint() {
    const result = await database.query<{ fingerprint: string }>(
      `SELECT schema_fingerprint AS fingerprint FROM schema_baseline WHERE singleton=true`,
    );
    return result.rows[0]?.fingerprint;
  }

  async function hasCampaignTable() {
    const result = await database.query<{ present: boolean }>(
      `SELECT to_regclass('qualification_campaign_authorizations') IS NOT NULL AS present`,
    );
    return result.rows[0]?.present;
  }

  async function historicalTruth() {
    const hasColumn = await database.query<{ present: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='runs'
            AND column_name='qualification_campaign_authorization_id'
       ) AS present`,
    );
    const projection = hasColumn.rows[0]?.present
      ? `,qualification_campaign_authorization_id::text AS "campaignId"`
      : "";
    const result = await database.query<{
      id: string;
      state: string;
      phase: string;
      campaignId?: string | null;
    }>(`SELECT id::text,state,phase${projection} FROM runs WHERE id=$1`, [ids.run]);
    return result.rows[0];
  }
});
