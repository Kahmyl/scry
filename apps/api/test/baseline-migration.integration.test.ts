import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";
import {
  migrateBrowserBaseline,
  retainedBaselineMigrationNames,
} from "../scripts/baseline-migration.js";
import { Database } from "../src/infrastructure/database.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { seedSession } from "./fixtures/browser-session.js";

const adminUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const live =
  adminUrl && process.env.SCRY_BROWSER_ALLOW_DATABASE_CREATION === "1" ? describe : describe.skip;
const source = fileURLToPath(new URL("../baseline-schema/", import.meta.url));
const fixtureSource = fileURLToPath(new URL("./fixtures/schema-upgrades/", import.meta.url));
const currentMigrations = (await readdir(source))
  .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
  .sort();
const currentCount = currentMigrations.length;
const fixtureName = (name: string) =>
  String(currentCount + Number(name.slice(0, 4)) - 8).padStart(4, "0") + name.slice(4);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
type Context = {
  client: pg.Client;
  directory: string;
  input: { confirmation: string; databaseUrl: string; expectedDatabase: string; directory: string };
};

async function withDatabase(work: (context: Context) => Promise<void>): Promise<void> {
  const name = "scry_migration_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: adminUrl!, connectionTimeoutMillis: 5000 });
  let created = false,
    client: pg.Client | undefined,
    directory: string | undefined;
  try {
    await admin.connect();
    if (!/^scry_migration_[a-f0-9]{32}$/u.test(name)) throw new Error("fixture_identity_invalid");
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(adminUrl!);
    url.pathname = "/" + name;
    client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    await client.connect();
    directory = await mkdtemp(path.join(tmpdir(), "scry-schema-upgrade-"));
    await mkdir(path.join(directory, "compatibility"));
    for (const filename of currentMigrations)
      await copyFile(path.join(source, filename), path.join(directory, filename));
    await copyFile(
      path.join(source, "compatibility/legacy-browser-generation.sql"),
      path.join(directory, "compatibility/legacy-browser-generation.sql"),
    );
    await work({
      client,
      directory,
      input: {
        confirmation: "CREATE_EMPTY_BASELINE",
        databaseUrl: url.toString(),
        expectedDatabase: name,
        directory,
      },
    });
  } finally {
    try {
      await client?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
const probe = async (client: pg.Client) =>
  Number(
    (
      await client.query(
        "SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='workspaces' AND column_name='upgrade_probe'",
      )
    ).rows[0].n,
  );
const receipts = async (client: pg.Client) =>
  (
    await client.query<{ name: string }>(
      "SELECT name FROM scry_migration_history ORDER BY run_on,id",
    )
  ).rows.map((row) => row.name);
async function add(context: Context, fixture: string, target = fixture) {
  await copyFile(
    path.join(fixtureSource, fixture),
    path.join(context.directory, fixtureName(target)),
  );
}
async function witness(client: pg.Client) {
  const id = randomUUID();
  await client.query(
    "INSERT INTO workspaces(id,name,slug) VALUES($1,'Immutable fictional business witness',$2)",
    [id, "fixture-" + id],
  );
  return id;
}
async function assertWitness(client: pg.Client, id: string) {
  expect((await client.query("SELECT name FROM workspaces WHERE id=$1", [id])).rows[0]?.name).toBe(
    "Immutable fictional business witness",
  );
}
async function rawBaseline(context: Context) {
  await context.client.query("BEGIN");
  for (const filename of retainedBaselineMigrationNames)
    await context.client.query(await readFile(path.join(source, filename), "utf8"));
  await context.client.query(
    "INSERT INTO schema_baseline(singleton,runtime_capability_id) VALUES(true,'browser-execution')",
  );
  await context.client.query("COMMIT");
}

live("guarded existing-baseline schema upgrades", () => {
  it("atomically refuses live-owner custody cutover, preserves history and fences receipt-less old workers", () =>
    withDatabase(async (context) => {
      await runner({
        dbClient: context.client,
        dir: context.directory,
        migrationsTable: "scry_migration_history",
        direction: "up",
        count: currentMigrations.indexOf("0010-evidence-admission.sql"),
        singleTransaction: true,
        logger: quiet,
      });
      await context.client.query(
        "INSERT INTO schema_baseline(singleton,runtime_capability_id) VALUES(true,'browser-execution')",
      );
      const priorUrl = process.env.DATABASE_URL,
        priorKey = process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64;
      process.env.DATABASE_URL = context.input.databaseUrl;
      process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
      const database = new Database();
      const effects = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
      try {
        // Seed the actual historical shape, not today's session creator: the
        // adapter column did not exist before these pending migrations.
        const historicalInsert = vi
          .spyOn(effects, "createSession")
          .mockImplementation(async (input) => {
            const inserted = await database.query<
              Awaited<ReturnType<BrowserExecutionRepository["createSession"]>>
            >(
              `INSERT INTO browser_execution_sessions(
              id,run_id,project_id,mission_id,objective_id,environment_id,agent_session_id,
              authentication_commit_limit,business_commit_limit,allowed_first_party_origins,
              allowed_service_origins,runtime_capability_id,protection_key_id,
              disclosure_mode,idempotency_key,state)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'[]'::jsonb,
                    'browser-execution','default','confidential',$11,'active') RETURNING *`,
              [
                input.id,
                input.runId,
                input.projectId,
                input.missionId,
                input.objectiveId,
                input.environmentId,
                input.agentSessionId,
                input.authenticationCommitLimit,
                input.businessCommitLimit,
                JSON.stringify(input.allowedFirstPartyOrigins),
                input.idempotencyKey,
              ],
            );
            if (!inserted.rows[0]) throw new Error("historical_session_insert_failed");
            return inserted.rows[0];
          });
        const sessionId = await seedSession(database, effects, "https://upgrade.fixture.invalid");
        historicalInsert.mockRestore();
        const runId = (
          await database.query("SELECT run_id FROM browser_execution_sessions WHERE id=$1", [
            sessionId,
          ])
        ).rows[0]!.run_id;
        await database.query(
          `INSERT INTO browser_owner_generations(session_id,generation,worker_id,lease_token,fencing_token,state,lease_expires_at,runtime_capability_id)
          VALUES($1,1,'historical-worker',$2,1,'active',clock_timestamp()+interval '60 seconds','browser-execution')`,
          [sessionId, randomUUID()],
        );
        await database.query(
          "UPDATE browser_execution_sessions SET active_owner_generation=1 WHERE id=$1",
          [sessionId],
        );
        await database.query(
          `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,replay_artifact_key,retention_expires_at,completed_at)
          VALUES($1,$2,$3,'complete',$4,1,64,'local://fictional-retained-metadata',clock_timestamp()+interval '30 days',clock_timestamp())`,
          [randomUUID(), sessionId, runId, "a".repeat(64)],
        );
        const before = (
          await database.query(
            "SELECT to_jsonb(e) AS data FROM browser_evidence_streams e WHERE session_id=$1",
            [sessionId],
          )
        ).rows[0]!.data;
        const historyBefore = await receipts(context.client);
        await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
          "SCRY_BROWSER_EVIDENCE_LIVE_OWNER",
        );
        expect(await receipts(context.client)).toEqual(historyBefore);
        expect(
          (
            await database.query(
              "SELECT 1 FROM information_schema.columns WHERE table_name='browser_owner_generations' AND column_name='evidence_admission_mode'",
            )
          ).rowCount,
        ).toBe(0);
        await database.query(
          "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
          [sessionId],
        );
        expect((await migrateBrowserBaseline(context.input)).migrationsApplied).toBe(
          currentCount - historyBefore.length,
        );
        const after = (
          await database.query(
            "SELECT to_jsonb(e) AS data FROM browser_evidence_streams e WHERE session_id=$1",
            [sessionId],
          )
        ).rows[0]!.data as Record<string, unknown>;
        expect(Object.fromEntries(Object.keys(before).map((key) => [key, after[key]]))).toEqual(
          before,
        );
        expect(after.custody_mode).toBe("legacy");
        expect(after.closure_issue).toBeNull();
        await expect(
          database.query(
            "UPDATE browser_evidence_streams SET custody_mode='admitted',writer_generation=1 WHERE session_id=$1",
            [sessionId],
          ),
        ).rejects.toThrow("evidence_legacy_immutable");
        await expect(
          database.query(
            "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE session_id=$1",
            [sessionId],
          ),
        ).rejects.toThrow("evidence_owner_protocol_required");
        const next = await effects.claimOwner(sessionId, "qualified-owner", 60000);
        await expect(
          effects.openEvidenceStream(
            { sessionId, generation: next.generation, leaseToken: next.leaseToken },
            runId,
          ),
        ).rejects.toThrow("EVIDENCE_READ_ONLY");
        const second = await seedSession(database, effects, "https://upgrade-new.fixture.invalid");
        const secondRun = (
          await database.query("SELECT run_id FROM browser_execution_sessions WHERE id=$1", [
            second,
          ])
        ).rows[0]!.run_id;
        await expect(
          database.query(
            `INSERT INTO browser_owner_generations(session_id,generation,worker_id,lease_token,fencing_token,state,lease_expires_at,runtime_capability_id)
          VALUES($1,1,'old-worker',$2,1,'active',clock_timestamp()+interval '60 seconds','browser-execution')`,
            [second, randomUUID()],
          ),
        ).rejects.toThrow("evidence_owner_protocol_required");
        await expect(
          database.query(
            `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,retention_expires_at,completed_at)
          VALUES($1,$2,$3,'complete',$4,1,64,clock_timestamp()+interval '30 days',clock_timestamp())`,
            [randomUUID(), second, secondRun, "b".repeat(64)],
          ),
        ).rejects.toThrow("evidence_admitted_shape");
        const qualified = await effects.claimOwner(second, "qualified-new", 60000);
        await effects.openEvidenceStream(
          { sessionId: second, generation: qualified.generation, leaseToken: qualified.leaseToken },
          secondRun,
        );
        await expect(
          database.query(
            `UPDATE browser_evidence_streams SET state='complete',completed_at=clock_timestamp(),sealed_at=clock_timestamp(),
          capture_started_at=clock_timestamp(),capture_stopped_at=clock_timestamp(),capture_complete=true,replay_artifact_key='local://fixture-rejected',chain_head=$2,chunk_count=1,total_bytes=64 WHERE session_id=$1`,
            [second, "c".repeat(64)],
          ),
        ).rejects.toThrow("evidence_receipt_summary_mismatch");
      } finally {
        await database.onModuleDestroy();
        if (priorUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = priorUrl;
        if (priorKey === undefined) delete process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64;
        else process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = priorKey;
      }
    }));
  it("applies additive SQL once, preserves business data, and does not fingerprint applied SQL bytes", () =>
    withDatabase(async (context) => {
      expect(await migrateBrowserBaseline(context.input)).toMatchObject({
        replayed: false,
        migrationsApplied: currentCount,
      });
      const id = await witness(context.client);
      await add(context, "0009-fixture-addition.sql");
      expect((await migrateBrowserBaseline(context.input)).migrationsApplied).toBe(1);
      expect(await probe(context.client)).toBe(1);
      await add(context, "0009-fixture-formatting.sql", "0009-fixture-addition.sql");
      expect((await migrateBrowserBaseline(context.input)).migrationsApplied).toBe(0);
      expect(await receipts(context.client)).toHaveLength(currentCount + 1);
      await assertWitness(context.client, id);
    }));
  it("rolls back the complete pending DDL batch and history on SQL failure", () =>
    withDatabase(async (context) => {
      await migrateBrowserBaseline(context.input);
      const id = await witness(context.client);
      await add(context, "0009-fixture-addition.sql");
      await add(context, "0010-fixture-failure.sql");
      await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
        "SCHEMA_MIGRATION_FAILED",
      );
      expect(await probe(context.client)).toBe(0);
      expect(await receipts(context.client)).toHaveLength(currentCount);
      expect(
        (await context.client.query("SELECT to_regclass('public.upgrade_partial_change') AS value"))
          .rows[0].value,
      ).toBeNull();
      await assertWitness(context.client, id);
    }));
  it("adopts a verified retained baseline without replaying already-applied SQL", () =>
    withDatabase(async (context) => {
      await rawBaseline(context);
      const id = await witness(context.client);
      await add(context, "0009-fixture-addition.sql");
      expect(await migrateBrowserBaseline(context.input)).toMatchObject({
        adoptedBaseline: true,
        migrationsApplied: currentCount - retainedBaselineMigrationNames.length + 1,
      });
      expect(await receipts(context.client)).toHaveLength(currentCount + 1);
      await assertWitness(context.client, id);
    }));
  it("rolls back partial adoption receipts after a mid-adoption receipt failure", () =>
    withDatabase(async (context) => {
      await rawBaseline(context);
      const id = await witness(context.client);
      await runner({
        dbClient: context.client,
        dir: context.directory,
        migrationsTable: "scry_migration_history",
        direction: "up",
        fake: true,
        count: 0,
        logger: quiet,
      });
      await context.client.query(
        "CREATE FUNCTION reject_fixture_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name LIKE '0004%' THEN RAISE EXCEPTION 'fixture_receipt_failure'; END IF; RETURN NEW; END $$",
      );
      await context.client.query(
        "CREATE TRIGGER reject_fixture_history BEFORE INSERT ON scry_migration_history FOR EACH ROW EXECUTE FUNCTION reject_fixture_history()",
      );
      await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
        "SCHEMA_MIGRATION_FAILED",
      );
      expect(await receipts(context.client)).toEqual([]);
      await assertWitness(context.client, id);
      await context.client.query("DROP TRIGGER reject_fixture_history ON scry_migration_history");
      expect(await migrateBrowserBaseline(context.input)).toMatchObject({
        adoptedBaseline: true,
        migrationsApplied: currentCount - retainedBaselineMigrationNames.length,
      });
      expect(await receipts(context.client)).toHaveLength(currentCount);
    }));
  it("recovers the initialization state after DDL/history committed but readiness did not", () =>
    withDatabase(async (context) => {
      await runner({
        dbClient: context.client,
        dir: context.directory,
        migrationsTable: "scry_migration_history",
        direction: "up",
        singleTransaction: true,
        logger: quiet,
      });
      expect(
        (await context.client.query("SELECT count(*) AS n FROM schema_baseline")).rows[0].n,
      ).toBe("0");
      expect(await migrateBrowserBaseline(context.input)).toMatchObject({
        replayed: true,
        migrationsApplied: 0,
      });
      expect(
        (await context.client.query("SELECT runtime_capability_id FROM schema_baseline")).rows[0]
          .runtime_capability_id,
      ).toBe("browser-execution");
    }));
  it("recovers an empty history table left by a failed first DDL transaction", () =>
    withDatabase(async (context) => {
      await add(context, "0009-fixture-failure.sql");
      await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
        "SCHEMA_MIGRATION_FAILED",
      );
      expect(await receipts(context.client)).toEqual([]);
      expect(
        (await context.client.query("SELECT to_regclass('public.schema_baseline') AS value"))
          .rows[0].value,
      ).toBeNull();
      await rm(path.join(context.directory, fixtureName("0009-fixture-failure.sql")));
      expect(await migrateBrowserBaseline(context.input)).toMatchObject({
        replayed: false,
        migrationsApplied: currentCount,
      });
    }));
  it("serializes concurrent adapters and safely replays after a refused contender retries", () =>
    withDatabase(async (context) => {
      await migrateBrowserBaseline(context.input);
      await add(context, "0009-fixture-slow.sql");
      const first = migrateBrowserBaseline(context.input);
      // Retain/settle the independently running contender even if an assertion
      // fails, before attempting to remove this exact fixture database.
      void first.catch(() => undefined);
      try {
        await vi.waitFor(
          async () => {
            expect(
              (
                await context.client.query(
                  "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=731925 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
                )
              ).rowCount,
            ).toBe(1);
          },
          { timeout: 3000, interval: 20 },
        );
        await expect(migrateBrowserBaseline(context.input)).rejects.toThrow("MIGRATION_BUSY");
        expect((await first).migrationsApplied).toBe(1);
        expect((await migrateBrowserBaseline(context.input)).migrationsApplied).toBe(0);
        expect(await receipts(context.client)).toHaveLength(currentCount + 1);
      } finally {
        await first.catch(() => undefined);
      }
    }));
  it("refuses conflicting or incomplete history without replaying old SQL", () =>
    withDatabase(async (context) => {
      await migrateBrowserBaseline(context.input);
      await add(context, "0009-fixture-addition.sql");
      await context.client.query(
        "UPDATE scry_migration_history SET name='0008-conflicting-operation' WHERE name='0008-production-integrity'",
      );
      await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
        "MIGRATION_HISTORY_CONFLICT",
      );
      expect(await probe(context.client)).toBe(0);
      await context.client.query(
        "DELETE FROM scry_migration_history WHERE name='0008-conflicting-operation'",
      );
      await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
        "MIGRATION_HISTORY_INVALID",
      );
      expect(await receipts(context.client)).toHaveLength(currentCount - 1);
      expect(await probe(context.client)).toBe(0);
    }));
  it("refuses partial legacy history before changing any legacy columns or metadata", () =>
    withDatabase(async (context) => {
      await rawBaseline(context);
      const id = await witness(context.client);
      // Model the complete retained layout before the compatibility bridge.
      await context.client.query(`
        ALTER TABLE schema_baseline DROP CONSTRAINT schema_baseline_runtime_capability_id_check;
        ALTER TABLE browser_execution_sessions DROP CONSTRAINT browser_execution_sessions_runtime_capability;
        ALTER TABLE browser_owner_generations DROP CONSTRAINT browser_owner_generations_runtime_capability_id_check;
        ALTER TABLE schema_baseline RENAME COLUMN runtime_capability_id TO runtime_capability_version;
        ALTER TABLE browser_execution_sessions RENAME COLUMN runtime_capability_id TO runtime_capability_version;
        ALTER TABLE browser_execution_outbox RENAME COLUMN runtime_capability_id TO runtime_capability_version;
        ALTER TABLE browser_owner_generations RENAME COLUMN runtime_capability_id TO runtime_capability_version;
        ALTER TABLE browser_execution_sessions RENAME COLUMN protection_key_id TO protection_key_version;
        ALTER TABLE browser_commands RENAME COLUMN protected_input_key_id TO protected_input_key_version;
        ALTER TABLE browser_captures RENAME COLUMN evidence_format TO evidence_version;
        ALTER TABLE protected_values RENAME COLUMN key_id TO key_version;
        ALTER TABLE browser_session_checkpoints RENAME COLUMN key_id TO key_version;
        ALTER TABLE schema_baseline ADD COLUMN schema_version text DEFAULT 'retained',
          ADD COLUMN schema_fingerprint text DEFAULT 'fixture-original',
          ADD COLUMN catalog_fingerprint text DEFAULT 'fixture-original';
        UPDATE schema_baseline SET runtime_capability_version='fixture-legacy';
      `);
      await runner({
        dbClient: context.client,
        dir: context.directory,
        migrationsTable: "scry_migration_history",
        direction: "up",
        fake: true,
        count: 3,
        logger: quiet,
      });
      const before = await context.client.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      );
      await expect(migrateBrowserBaseline(context.input)).rejects.toThrow(
        "MIGRATION_HISTORY_INVALID",
      );
      expect(
        (
          await context.client.query(
            "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
          )
        ).rows,
      ).toEqual(before.rows);
      expect((await context.client.query("SELECT * FROM schema_baseline")).rows[0]).toMatchObject({
        runtime_capability_version: "fixture-legacy",
        schema_version: "retained",
        schema_fingerprint: "fixture-original",
        catalog_fingerprint: "fixture-original",
      });
      expect(await receipts(context.client)).toHaveLength(3);
      await assertWitness(context.client, id);
    }));
});
