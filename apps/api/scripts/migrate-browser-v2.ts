import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  BROWSER_RUNTIME_CAPABILITY_VERSION,
  BROWSER_V2_SCHEMA_VERSION,
} from "../src/browser-execution/browser-runtime-capability.js";
import {
  browserV2CatalogFingerprint,
  loadBrowserV2SchemaManifest,
} from "../src/browser-execution/browser-v2-schema-manifest.js";

const CAPABILITY_VERSION = BROWSER_RUNTIME_CAPABILITY_VERSION;
const confirmation = process.env.BROWSER_V2_SCHEMA_CONFIRM;
const databaseUrl = process.env.BROWSER_V2_DATABASE_URL;
const expectedDatabase = process.env.BROWSER_V2_EXPECTED_DATABASE;

if (confirmation !== "CREATE_EMPTY_V2") throw new Error("BROWSER_V2_SCHEMA_CONFIRM_REQUIRED");
if (!databaseUrl) throw new Error("BROWSER_V2_DATABASE_URL_REQUIRED");
if (!expectedDatabase) throw new Error("BROWSER_V2_EXPECTED_DATABASE_REQUIRED");

const parsedUrl = new URL(databaseUrl);
const configuredDatabase = decodeURIComponent(parsedUrl.pathname.replace(/^\//u, ""));
if (!configuredDatabase || configuredDatabase !== expectedDatabase) {
  throw new Error("BROWSER_V2_DATABASE_IDENTITY_MISMATCH");
}

const migrationDirectory = fileURLToPath(new URL("../migrations-v2/", import.meta.url));
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
  .sort();
if (migrationNames.length === 0) throw new Error("BROWSER_V2_MIGRATIONS_MISSING");

const migrations = await Promise.all(
  migrationNames.map(async (name) => ({
    name,
    source: await readFile(path.join(migrationDirectory, name), "utf8"),
  })),
);
const manifest = await loadBrowserV2SchemaManifest();
const { schemaFingerprint } = manifest;
if (
  manifest.schemaVersion !== BROWSER_V2_SCHEMA_VERSION ||
  migrationNames.join("\n") !== manifest.migrationNames.join("\n")
)
  throw new Error("BROWSER_V2_SCHEMA_MANIFEST_MISMATCH");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
try {
  const identity = await pool.query<{ database: string }>("SELECT current_database() AS database");
  if (identity.rows[0]?.database !== expectedDatabase)
    throw new Error("BROWSER_V2_DATABASE_IDENTITY_MISMATCH");

  const existingTables = await pool.query<{ tableName: string }>(
    `SELECT tablename AS "tableName" FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  if (existingTables.rows.some(({ tableName }) => tableName === "schema_baseline")) {
    const baseline = await pool.query<{
      schemaVersion: number;
      schemaFingerprint: string;
      catalogFingerprint: string | null;
      runtimeCapabilityVersion: string;
    }>(
      `SELECT schema_version AS "schemaVersion",schema_fingerprint AS "schemaFingerprint",
              catalog_fingerprint AS "catalogFingerprint",
              runtime_capability_version AS "runtimeCapabilityVersion"
       FROM schema_baseline WHERE singleton=true`,
    );
    const row = baseline.rows[0];
    const catalogFingerprint = await browserV2CatalogFingerprint(pool);
    if (
      !row ||
      row.schemaVersion !== BROWSER_V2_SCHEMA_VERSION ||
      row.schemaFingerprint !== schemaFingerprint ||
      row.catalogFingerprint !== catalogFingerprint ||
      row.runtimeCapabilityVersion !== CAPABILITY_VERSION
    )
      throw new Error("BROWSER_V2_EXISTING_SCHEMA_MISMATCH");
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replayed: true, database: expectedDatabase, schemaFingerprint, migrationNames })}\n`,
    );
    process.exitCode = 0;
  } else {
    if (existingTables.rowCount !== 0) {
      throw new Error(
        `BROWSER_V2_DATABASE_NOT_EMPTY:${existingTables.rows.map(({ tableName }) => tableName).join(",")}`,
      );
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const migration of migrations) await client.query(migration.source);
      const catalogFingerprint = await browserV2CatalogFingerprint(client);
      await client.query(
        `INSERT INTO schema_baseline(
           singleton,schema_version,schema_fingerprint,catalog_fingerprint,runtime_capability_version)
         VALUES(true,$1,$2,$3,$4)`,
        [BROWSER_V2_SCHEMA_VERSION, schemaFingerprint, catalogFingerprint, CAPABILITY_VERSION],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replayed: false, database: expectedDatabase, schemaFingerprint, migrationNames })}\n`,
    );
  }
} finally {
  await pool.end();
}
