import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner, type RunnerOption } from "node-pg-migrate";
import { BROWSER_RUNTIME_CAPABILITY_ID } from "../src/browser-execution/browser-runtime-capability.js";
import {
  assertBrowserSchema,
  assertRetainedBrowserSchema,
} from "../src/browser-execution/browser-schema.js";

export const retainedBaselineMigrationNames = Object.freeze([
  "0001-browser-execution-baseline.sql",
  "0002-content-aware-response-capture.sql",
  "0003-encrypted-browser-session-checkpoints.sql",
  "0004-single-protection-authority.sql",
  "0005-environment-disclosure-admission.sql",
  "0006-durable-response-lifecycle.sql",
  "0007-key-custody.sql",
  "0008-production-integrity.sql",
]);
const historyTable = "scry_migration_history",
  migrationLock = 731925;
const quiet = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const safeErrors = new Set([
  "SCRY_BROWSER_SCHEMA_CONFIRM_REQUIRED",
  "SCRY_BROWSER_DATABASE_URL_REQUIRED",
  "SCRY_BROWSER_EXPECTED_DATABASE_REQUIRED",
  "SCRY_BROWSER_DATABASE_IDENTITY_MISMATCH",
  "SCRY_BROWSER_MIGRATIONS_MISSING",
  "SCRY_BROWSER_MIGRATION_CATALOG_INVALID",
  "SCRY_BROWSER_MIGRATION_HISTORY_INVALID",
  "SCRY_BROWSER_MIGRATION_HISTORY_CONFLICT",
  "SCRY_BROWSER_MIGRATION_BUSY",
  "SCRY_BROWSER_DATABASE_NOT_EMPTY",
  "SCRY_BROWSER_EXISTING_SCHEMA_MISMATCH",
  "SCRY_BROWSER_SCHEMA_INCOMPLETE",
  "SCRY_BROWSER_MIGRATION_CATALOG_UNAVAILABLE",
  "SCRY_BROWSER_EVIDENCE_LIVE_OWNER",
]);
export interface BaselineMigrationInput {
  confirmation?: string | undefined;
  databaseUrl?: string | undefined;
  expectedDatabase?: string | undefined;
  /** Operational composition/test seam; never an HTTP/customer input. */
  directory?: string;
}

/** Operational output admits finite failure metadata, never arbitrary diagnostics. */
export function migrationFailureCode(error: unknown): string {
  try {
    const code = error instanceof Error ? error.message.split(":")[0]! : "";
    return safeErrors.has(code) ? code : "SCRY_BROWSER_SCHEMA_MIGRATION_FAILED";
  } catch {
    return "SCRY_BROWSER_SCHEMA_MIGRATION_FAILED";
  }
}

export function validateMigrationTarget(input: BaselineMigrationInput): void {
  if (input.confirmation !== "CREATE_EMPTY_BASELINE")
    throw new Error("SCRY_BROWSER_SCHEMA_CONFIRM_REQUIRED");
  if (!input.databaseUrl) throw new Error("SCRY_BROWSER_DATABASE_URL_REQUIRED");
  if (!input.expectedDatabase) throw new Error("SCRY_BROWSER_EXPECTED_DATABASE_REQUIRED");
  try {
    const url = new URL(input.databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      decodeURIComponent(url.pathname.slice(1)) !== input.expectedDatabase
    )
      throw new Error("mismatch");
  } catch {
    throw new Error("SCRY_BROWSER_DATABASE_IDENTITY_MISMATCH");
  }
}
export function validateMigrationCatalog(names: readonly string[]): void {
  if (!names.length) throw new Error("SCRY_BROWSER_MIGRATIONS_MISSING");
  if (
    names.length < retainedBaselineMigrationNames.length ||
    names.some(
      (name, index) =>
        !/^\d{4}-[a-z0-9-]+\.sql$/u.test(name) ||
        Number(name.slice(0, 4)) !== index + 1 ||
        (index < retainedBaselineMigrationNames.length &&
          name !== retainedBaselineMigrationNames[index]),
    )
  )
    throw new Error("SCRY_BROWSER_MIGRATION_CATALOG_INVALID");
}
async function history(client: pg.Client): Promise<string[]> {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
    [historyTable],
  );
  if (!exists.rowCount) return [];
  return (
    await client.query<{ name: string }>(
      "SELECT name FROM public.scry_migration_history ORDER BY run_on,id",
    )
  ).rows.map((row) => row.name);
}
function checkHistory(applied: readonly string[], names: readonly string[]): void {
  if (
    new Set(applied).size !== applied.length ||
    applied.some(
      (name, index) =>
        typeof name !== "string" ||
        !/^\d{4}-[a-z0-9-]+$/u.test(name) ||
        Number(name.slice(0, 4)) !== index + 1,
    )
  )
    throw new Error("SCRY_BROWSER_MIGRATION_HISTORY_INVALID");
  if (applied.some((name, index) => index < names.length && name !== names[index]!.slice(0, -4)))
    throw new Error("SCRY_BROWSER_MIGRATION_HISTORY_CONFLICT");
}
async function assertCapability(client: pg.Client, allowAbsent = false): Promise<void> {
  const result = await client.query<{ runtime_capability_id: string }>(
    "SELECT runtime_capability_id FROM schema_baseline WHERE singleton=true",
  );
  if (allowAbsent && !result.rowCount) return;
  if (result.rows[0]?.runtime_capability_id !== BROWSER_RUNTIME_CAPABILITY_ID)
    throw new Error("SCRY_BROWSER_EXISTING_SCHEMA_MISMATCH");
}

/** Framework owns SQL/history. Scry owns identity guards, atomic adoption and
 * readiness. Applied operation names are not byte hashes/schema fingerprints. */
export async function migrateBrowserBaseline(input: BaselineMigrationInput) {
  validateMigrationTarget(input);
  const directory =
    input.directory ?? fileURLToPath(new URL("../baseline-schema/", import.meta.url));
  let names: string[], bridge: string;
  try {
    names = (await readdir(directory)).filter((name) => /\.sql$/iu.test(name)).sort();
    validateMigrationCatalog(names);
    bridge = await readFile(
      path.join(directory, "compatibility/legacy-browser-generation.sql"),
      "utf8",
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(safeErrors.has(code) ? code : "SCRY_BROWSER_MIGRATION_CATALOG_UNAVAILABLE");
  }
  const client = new pg.Client({
    connectionString: input.databaseUrl!,
    connectionTimeoutMillis: 5000,
    statement_timeout: 120000,
    query_timeout: 125000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 120000,
  });
  client.on("error", () => {
    /* Queries/readiness fail; never log connection data. */
  });
  let connected = false,
    locked = false;
  try {
    await client.connect();
    connected = true;
    const identity = await client.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    if (identity.rows[0]?.database !== input.expectedDatabase)
      throw new Error("SCRY_BROWSER_DATABASE_IDENTITY_MISMATCH");
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [migrationLock],
    );
    if (!lock.rows[0]?.acquired) throw new Error("SCRY_BROWSER_MIGRATION_BUSY");
    locked = true;
    const tables = await client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'",
    );
    const existing = tables.rows.some((row) => row.name === "schema_baseline");
    let applied = await history(client);
    checkHistory(applied, names);
    const options: RunnerOption = {
      dbClient: client,
      dir: directory,
      migrationsTable: historyTable,
      migrationsSchema: "public",
      schema: "public",
      direction: "up",
      singleTransaction: true,
      checkOrder: true,
      noLock: true,
      logger: quiet,
      ignorePattern: "^(?![0-9]{4}-.+\\.sql$)",
      migrationLoaderStrategies: [{ extensions: [".sql"], loader: "legacySql" }],
    };
    let compatibilityApplied = false,
      adoptedBaseline = false;
    if (existing) {
      // A partial retained receipt prefix is not adoptable. Refuse before the
      // compatibility bridge can commit any rename, data update or metadata drop.
      if (applied.length > 0 && applied.length < retainedBaselineMigrationNames.length)
        throw new Error("SCRY_BROWSER_MIGRATION_HISTORY_INVALID");
      const legacy = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='schema_baseline' AND column_name='runtime_capability_version'",
      );
      if (legacy.rowCount || applied.length === 0) {
        await client.query("BEGIN");
        if (legacy.rowCount) {
          await client.query(bridge);
          compatibilityApplied = true;
        }
        await assertRetainedBrowserSchema(client);
        await assertCapability(client);
        if (applied.length === 0) {
          // Stable fake mode does not BEGIN/COMMIT. This explicit transaction
          // includes compatibility/adoption/history setup. No user skip switch.
          await runner({ ...options, fake: true, count: retainedBaselineMigrationNames.length });
          adoptedBaseline = true;
        }
        await client.query("COMMIT");
        applied = await history(client);
        checkHistory(applied, names);
      }
      if (applied.length < retainedBaselineMigrationNames.length)
        throw new Error("SCRY_BROWSER_MIGRATION_HISTORY_INVALID");
      await assertRetainedBrowserSchema(client);
      // Full tracked initial SQL can outlive a crash before readiness setup.
      await assertCapability(client, true);
    } else if (applied.length || tables.rows.some((row) => row.name !== historyTable)) {
      throw new Error("SCRY_BROWSER_DATABASE_NOT_EMPTY");
    }
    const executed = await runner(options);
    // DDL/history commit together; readiness is a separate short transaction.
    // A crash before marker setup is recovered by replay, not schema re-creation.
    await client.query("BEGIN");
    await assertBrowserSchema(client);
    await client.query(
      "INSERT INTO schema_baseline(singleton,runtime_capability_id) VALUES(true,$1) ON CONFLICT(singleton) DO NOTHING",
      [BROWSER_RUNTIME_CAPABILITY_ID],
    );
    await assertCapability(client);
    await client.query("COMMIT");
    return {
      verdict: "pass" as const,
      replayed: existing,
      compatibilityApplied,
      adoptedBaseline,
      migrationsApplied: executed.length,
      database: input.expectedDatabase!,
    };
  } catch (error) {
    if (connected) await client.query("ROLLBACK").catch(() => undefined);
    const code = error instanceof Error ? error.message.split(":")[0]! : "";
    throw new Error(safeErrors.has(code) ? code : "SCRY_BROWSER_SCHEMA_MIGRATION_FAILED");
  } finally {
    if (locked)
      await client.query("SELECT pg_advisory_unlock($1)", [migrationLock]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
