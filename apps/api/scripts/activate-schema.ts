import pg from "pg";

import { BROWSER_RUNTIME_CAPABILITY_ID } from "../src/browser-execution/browser-runtime-capability.js";
import { assertBrowserSchema } from "../src/browser-execution/browser-schema.js";

requireValue("SCRY_BROWSER_ACTIVATION_CONFIRM", "ACTIVATE_PERMANENT_SCRY_BROWSER_CUTOVER");
requireValue("SCRY_BROWSER_LEGACY_RUNTIME_STOPPED", "I_ATTEST_LEGACY_RUNTIME_STOPPED");
requireValue("SCRY_BROWSER_TRAFFIC_SWITCH_READY", "I_ATTEST_TRAFFIC_SWITCH_READY");
requireValue("SCRY_BROWSER_LEGACY_MCP_TOKENS_REVOKED", "I_ATTEST_LEGACY_MCP_TOKENS_REVOKED");
requireValue("SCRY_BROWSER_LEGACY_DATABASE_RETIRED", "I_ATTEST_LEGACY_DATABASE_RETIRED");
requireValue("SCRY_BROWSER_LEGACY_ARTIFACTS_DISPOSED", "I_ATTEST_LEGACY_ARTIFACTS_DISPOSED");

const databaseUrl = required("SCRY_BROWSER_DATABASE_URL");
const expectedDatabase = required("SCRY_BROWSER_EXPECTED_DATABASE");
const configuredDatabase = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ""));
if (configuredDatabase !== expectedDatabase)
  throw new Error("SCRY_BROWSER_DATABASE_IDENTITY_MISMATCH");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('browser-baseline-activation'))");
  await assertBrowserSchema(client);
  const baseline = await client.query<{
    database: string;
    runtime_capability_id: string;
  }>(
    `SELECT current_database() AS database,runtime_capability_id
     FROM schema_baseline WHERE singleton=true FOR UPDATE`,
  );
  const row = baseline.rows[0];
  if (
    !row ||
    row.database !== expectedDatabase ||
    row.runtime_capability_id !== BROWSER_RUNTIME_CAPABILITY_ID
  )
    throw new Error("SCRY_BROWSER_ACTIVATION_SCHEMA_MISMATCH");

  const receipt = await client.query<{ id: string; state: string }>(
    `SELECT id,state FROM identity_import_receipts
     WHERE mode='permanent' ORDER BY imported_at DESC LIMIT 1 FOR UPDATE`,
  );
  if (!receipt.rows[0]) throw new Error("SCRY_BROWSER_PERMANENT_IMPORT_REQUIRED");
  if (receipt.rows[0].state === "active") {
    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({ verdict: "pass", replay: true, database: expectedDatabase, state: "active" })}\n`,
    );
  } else {
    if (receipt.rows[0].state !== "identity_imported")
      throw new Error("SCRY_BROWSER_IMPORT_NOT_ACTIVATABLE");
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
        throw new Error(`SCRY_BROWSER_PREACTIVATION_DATA_PRESENT:${table}`);
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
