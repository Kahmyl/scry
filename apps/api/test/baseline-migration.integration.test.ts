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
});
