import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { executionPolicySchema } from "@scry/contracts";
import { compileDefaultVeilPolicy } from "@scry/policy";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry";
const baselinePath = fileURLToPath(new URL("../migrations/baseline.sql", import.meta.url));
const calibrationFoundationPath = fileURLToPath(new URL("../migrations/calibration-foundation.sql", import.meta.url));
const protectedCapsulePath = fileURLToPath(new URL("../migrations/protected-capsule.sql", import.meta.url));
const authoringCutoverPath = fileURLToPath(new URL("../migrations/authoring-execution-cutover.sql", import.meta.url));
const praxisReportingPath = fileURLToPath(new URL("../migrations/praxis-reporting.sql", import.meta.url));
const praxisCutoffPath = fileURLToPath(new URL("../migrations/praxis-cutoff.sql", import.meta.url));
const veilObservationPreferencesPath = fileURLToPath(new URL("../migrations/veil-observation-preferences.sql", import.meta.url));
const veilArtifactRetentionPath = fileURLToPath(new URL("../migrations/veil-artifact-retention.sql", import.meta.url));
const calibrationFoundation = await readFile(calibrationFoundationPath, "utf8");
const protectedCapsule = await readFile(protectedCapsulePath, "utf8");
const baselineSource = await readFile(baselinePath, "utf8");
const authoringCutover = await readFile(authoringCutoverPath, "utf8");
const praxisReporting = await readFile(praxisReportingPath, "utf8");
const praxisCutoff = await readFile(praxisCutoffPath, "utf8");
const veilObservationPreferences = await readFile(veilObservationPreferencesPath, "utf8");
const veilArtifactRetention = await readFile(veilArtifactRetentionPath, "utf8");
const expandFoundation = (source: string) => source
  .replace("\\ir calibration-foundation.sql", () => calibrationFoundation)
  .replace("\\ir protected-capsule.sql", () => protectedCapsule);
const base = expandFoundation(baselineSource
  .replace("\\ir authoring-execution-cutover.sql\n", "")
  .replace("\\ir praxis-reporting.sql\n", "")
  .replace("\\ir praxis-cutoff.sql\n", "")
  .replace("\\ir veil-observation-preferences.sql\n", "")
  .replace("\\ir veil-artifact-retention.sql\n", ""));
const authoringBaseline = expandFoundation(baselineSource
  .replace("\\ir praxis-reporting.sql\n", "")
  .replace("\\ir praxis-cutoff.sql\n", "")
  .replace("\\ir veil-observation-preferences.sql\n", "")
  .replace("\\ir veil-artifact-retention.sql\n", ""))
  .replace("\\ir authoring-execution-cutover.sql", () => authoringCutover);
const reportingBaseline = expandFoundation(baselineSource
  .replace("\\ir praxis-cutoff.sql\n", "")
  .replace("\\ir veil-observation-preferences.sql\n", "")
  .replace("\\ir veil-artifact-retention.sql\n", ""))
  .replace("\\ir authoring-execution-cutover.sql", () => authoringCutover)
  .replace("\\ir praxis-reporting.sql", () => praxisReporting);
const praxisBaseline = expandFoundation(baselineSource
  .replace("\\ir veil-observation-preferences.sql\n", "")
  .replace("\\ir veil-artifact-retention.sql\n", ""))
  .replace("\\ir authoring-execution-cutover.sql", () => authoringCutover)
  .replace("\\ir praxis-reporting.sql", () => praxisReporting)
  .replace("\\ir praxis-cutoff.sql", () => praxisCutoff);
const preferencesBaseline = expandFoundation(baselineSource
  .replace("\\ir veil-artifact-retention.sql\n", ""))
  .replace("\\ir authoring-execution-cutover.sql", () => authoringCutover)
  .replace("\\ir praxis-reporting.sql", () => praxisReporting)
  .replace("\\ir praxis-cutoff.sql", () => praxisCutoff)
  .replace("\\ir veil-observation-preferences.sql", () => veilObservationPreferences);
const baseline = expandFoundation(baselineSource)
  .replace("\\ir authoring-execution-cutover.sql", () => authoringCutover)
  .replace("\\ir praxis-reporting.sql", () => praxisReporting)
  .replace("\\ir praxis-cutoff.sql", () => praxisCutoff)
  .replace("\\ir veil-observation-preferences.sql", () => veilObservationPreferences)
  .replace("\\ir veil-artifact-retention.sql", () => veilArtifactRetention);
const fingerprint = createHash("sha256").update(baseline).digest("hex");
const previousFingerprint = createHash("sha256").update(base).digest("hex");
const authoringFingerprint = createHash("sha256").update(authoringBaseline).digest("hex");
const reportingFingerprint = createHash("sha256").update(reportingBaseline).digest("hex");
const praxisFingerprint = createHash("sha256").update(praxisBaseline).digest("hex");
const preferencesFingerprint = createHash("sha256").update(preferencesBaseline).digest("hex");
const previousVeilFullFingerprint = "8c0e5ae0ae72f9a163189abe903b317e38aacf6b1674f3441b62dd7129b48c6a";
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const baselineTable = await pool.query("SELECT to_regclass('public.schema_baseline') AS table");
  if (!baselineTable.rows[0]?.table) {
    const legacy = await pool.query("SELECT to_regclass('public.schema_migrations') AS table");
    if (legacy.rows[0]?.table) throw new Error("Legacy schema detected. Run the guarded pre-production cutoff instead of applying compatibility migrations.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(baseline);
      await client.query("INSERT INTO schema_baseline(schema_fingerprint) VALUES ($1)", [fingerprint]);
      await client.query("COMMIT");
      process.stdout.write(`Applied clean baseline ${fingerprint}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const installed = await pool.query("SELECT schema_fingerprint FROM schema_baseline WHERE singleton = true");
    const installedFingerprint = installed.rows[0]?.schema_fingerprint;
    if ([previousFingerprint, authoringFingerprint, reportingFingerprint, praxisFingerprint, preferencesFingerprint, previousVeilFullFingerprint].includes(installedFingerprint)) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-praxis-cutoff'))");
        if (installedFingerprint === previousFingerprint) await client.query(authoringCutover);
        if (installedFingerprint === previousFingerprint || installedFingerprint === authoringFingerprint) await client.query(praxisReporting);
        if ([previousFingerprint, authoringFingerprint, reportingFingerprint].includes(installedFingerprint)) await client.query(praxisCutoff);
        if (installedFingerprint !== preferencesFingerprint) await client.query(veilObservationPreferences);
        await backfillVeilPolicySnapshots(client);
        await client.query(veilArtifactRetention);
        await client.query("UPDATE schema_baseline SET schema_fingerprint=$1, applied_at=now() WHERE singleton=true", [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied guarded Veil schema lifecycle ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    } else if (installed.rows[0]?.schema_fingerprint !== fingerprint) {
      throw new Error(`Schema fingerprint mismatch: installed=${installed.rows[0]?.schema_fingerprint ?? "missing"} required=${fingerprint}. Stop all writers and run the guarded capability-grounding pre-production cutover; compatibility migration is intentionally unsupported.`);
    } else {
      process.stdout.write(`Clean baseline already present ${fingerprint}\n`);
    }
  }
} finally { await pool.end(); }

async function backfillVeilPolicySnapshots(client: pg.PoolClient) {
  const runs = await client.query<{ id: string; policy_snapshot: unknown }>(
    `SELECT id,policy_snapshot FROM runs WHERE veil_policy_snapshot->>'digest'=repeat('0',64) FOR UPDATE`,
  );
  for (const run of runs.rows) {
    const snapshot = compileDefaultVeilPolicy(executionPolicySchema.parse(run.policy_snapshot));
    await client.query(`UPDATE runs SET veil_policy_snapshot=$2::jsonb WHERE id=$1`, [run.id, JSON.stringify(snapshot)]);
  }
}
