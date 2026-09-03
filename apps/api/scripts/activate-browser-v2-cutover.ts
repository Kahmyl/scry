import pg from "pg";

import {
  BROWSER_RUNTIME_CAPABILITY_VERSION,
  BROWSER_V2_SCHEMA_VERSION,
} from "../src/browser-execution/browser-runtime-capability.js";
import {
  browserV2CatalogFingerprint,
  loadBrowserV2SchemaManifest,
} from "../src/browser-execution/browser-v2-schema-manifest.js";

requireValue("BROWSER_V2_ACTIVATION_CONFIRM", "ACTIVATE_PERMANENT_BROWSER_V2_CUTOVER");
requireValue("BROWSER_V2_LEGACY_RUNTIME_STOPPED", "I_ATTEST_LEGACY_RUNTIME_STOPPED");
requireValue("BROWSER_V2_TRAFFIC_SWITCH_READY", "I_ATTEST_TRAFFIC_SWITCH_READY");
requireValue("BROWSER_V2_LEGACY_MCP_TOKENS_REVOKED", "I_ATTEST_LEGACY_MCP_TOKENS_REVOKED");
requireValue("BROWSER_V2_LEGACY_DATABASE_RETIRED", "I_ATTEST_LEGACY_DATABASE_RETIRED");
requireValue("BROWSER_V2_LEGACY_ARTIFACTS_DISPOSED", "I_ATTEST_LEGACY_ARTIFACTS_DISPOSED");

const databaseUrl = required("BROWSER_V2_DATABASE_URL");
const expectedDatabase = required("BROWSER_V2_EXPECTED_DATABASE");
const configuredDatabase = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ""));
if (configuredDatabase !== expectedDatabase)
  throw new Error("BROWSER_V2_DATABASE_IDENTITY_MISMATCH");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('browser-v2-cutover-activation'))");
  const manifest = await loadBrowserV2SchemaManifest();
  const baseline = await client.query<{
    database: string;
    schema_version: number;
    schema_fingerprint: string;
    catalog_fingerprint: string | null;
    runtime_capability_version: string;
  }>(
    `SELECT current_database() AS database,schema_version,schema_fingerprint,
            catalog_fingerprint,runtime_capability_version
     FROM schema_baseline WHERE singleton=true FOR UPDATE`,
  );
  const row = baseline.rows[0];
  const catalogFingerprint = await browserV2CatalogFingerprint(client);
  if (
    !row ||
    row.database !== expectedDatabase ||
    row.schema_version !== BROWSER_V2_SCHEMA_VERSION ||
    manifest.schemaVersion !== BROWSER_V2_SCHEMA_VERSION ||
    row.schema_fingerprint !== manifest.schemaFingerprint ||
    row.catalog_fingerprint !== catalogFingerprint ||
    row.runtime_capability_version !== BROWSER_RUNTIME_CAPABILITY_VERSION
  )
    throw new Error("BROWSER_V2_ACTIVATION_SCHEMA_MISMATCH");

  const receipt = await client.query<{ id: string; state: string }>(
    `SELECT id,state FROM identity_import_receipts
     WHERE mode='permanent' ORDER BY imported_at DESC LIMIT 1 FOR UPDATE`,
  );
  if (!receipt.rows[0]) throw new Error("BROWSER_V2_PERMANENT_IMPORT_REQUIRED");
  if (receipt.rows[0].state === "active") {
    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replay: true, database: expectedDatabase, state: "active" })}\n`,
    );
  } else {
    if (receipt.rows[0].state !== "identity_imported")
      throw new Error("BROWSER_V2_IMPORT_NOT_ACTIVATABLE");
    const executionTables = [
      "missions",
      "agent_sessions",
      "mission_objectives",
      "flows",
      "flow_revisions",
      "runs",
      "browser_execution_sessions",
      "browser_effects",
      "browser_captures",
      "protected_values",
      "mission_reports",
    ];
    for (const table of executionTables) {
      const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
      if (Number(count.rows[0]?.count) !== 0)
        throw new Error(`BROWSER_V2_PREACTIVATION_DATA_PRESENT:${table}`);
    }
    await client.query(
      "UPDATE identity_import_receipts SET state='active',activated_at=now() WHERE id=$1",
      [receipt.rows[0].id],
    );
    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replay: false, database: expectedDatabase, state: "active" })}\n`,
    );
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function requireValue(name: string, expected: string): void {
  if (process.env[name] !== expected) throw new Error(`${name}_REQUIRED`);
}
