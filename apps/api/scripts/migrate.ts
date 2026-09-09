import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { BROWSER_RUNTIME_CAPABILITY_ID } from "../src/browser-execution/browser-runtime-capability.js";
import { assertBrowserSchema } from "../src/browser-execution/browser-schema.js";

const CAPABILITY_ID = BROWSER_RUNTIME_CAPABILITY_ID;
const confirmation = process.env.SCRY_BROWSER_SCHEMA_CONFIRM;
const databaseUrl = process.env.SCRY_BROWSER_DATABASE_URL;
const expectedDatabase = process.env.SCRY_BROWSER_EXPECTED_DATABASE;

if (confirmation !== "CREATE_EMPTY_BASELINE")
  throw new Error("SCRY_BROWSER_SCHEMA_CONFIRM_REQUIRED");
if (!databaseUrl) throw new Error("SCRY_BROWSER_DATABASE_URL_REQUIRED");
if (!expectedDatabase) throw new Error("SCRY_BROWSER_EXPECTED_DATABASE_REQUIRED");

const parsedUrl = new URL(databaseUrl);
const configuredDatabase = decodeURIComponent(parsedUrl.pathname.replace(/^\//u, ""));
if (!configuredDatabase || configuredDatabase !== expectedDatabase) {
  throw new Error("SCRY_BROWSER_DATABASE_IDENTITY_MISMATCH");
}

const migrationDirectory = fileURLToPath(new URL("../baseline-schema/", import.meta.url));
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
  .sort();
if (migrationNames.length === 0) throw new Error("SCRY_BROWSER_MIGRATIONS_MISSING");

const migrations = await Promise.all(
  migrationNames.map(async (name) => ({
    name,
    source: await readFile(path.join(migrationDirectory, name), "utf8"),
  })),
);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  const identity = await pool.query<{ database: string }>("SELECT current_database() AS database");
  if (identity.rows[0]?.database !== expectedDatabase)
    throw new Error("SCRY_BROWSER_DATABASE_IDENTITY_MISMATCH");

  const existingTables = await pool.query<{ tableName: string }>(
    `SELECT tablename AS "tableName" FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  if (existingTables.rows.some(({ tableName }) => tableName === "schema_baseline")) {
    const legacyCapabilityColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='schema_baseline'
         AND column_name='runtime_capability_version'`,
    );
    let compatibilityApplied = false;
    if (legacyCapabilityColumn.rowCount === 1) {
      const compatibilitySource = await readFile(
        path.join(migrationDirectory, "compatibility", "legacy-browser-generation.sql"),
        "utf8",
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(compatibilitySource);
        await assertBrowserSchema(client);
        await client.query("COMMIT");
        compatibilityApplied = true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await assertBrowserSchema(pool);
    const baseline = await pool.query<{ runtimeCapabilityId: string }>(
      `SELECT runtime_capability_id AS "runtimeCapabilityId"
       FROM schema_baseline WHERE singleton=true`,
    );
    const row = baseline.rows[0];
    if (!row || row.runtimeCapabilityId !== CAPABILITY_ID)
      throw new Error("SCRY_BROWSER_EXISTING_SCHEMA_MISMATCH");
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replayed: true, compatibilityApplied, database: expectedDatabase })}\n`,
    );
    process.exitCode = 0;
  } else {
    if (existingTables.rowCount !== 0) {
      throw new Error(
        `SCRY_BROWSER_DATABASE_NOT_EMPTY:${existingTables.rows.map(({ tableName }) => tableName).join(",")}`,
      );
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const migration of migrations) await client.query(migration.source);
      await client.query(
        "INSERT INTO schema_baseline(singleton,runtime_capability_id) VALUES(true,$1)",
        [CAPABILITY_ID],
      );
      await assertBrowserSchema(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replayed: false, database: expectedDatabase })}\n`,
    );
  }
} finally {
  await pool.end();
}
