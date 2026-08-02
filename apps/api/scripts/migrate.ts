import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry";
const baselinePath = fileURLToPath(new URL("../migrations/baseline.sql", import.meta.url));
const calibrationFoundationPath = fileURLToPath(new URL("../migrations/calibration-foundation.sql", import.meta.url));
const protectedCapsulePath = fileURLToPath(new URL("../migrations/protected-capsule.sql", import.meta.url));
const authoringCutoverPath = fileURLToPath(new URL("../migrations/authoring-execution-cutover.sql", import.meta.url));
const calibrationFoundation = await readFile(calibrationFoundationPath, "utf8");
const protectedCapsule = await readFile(protectedCapsulePath, "utf8");
const baselineSource = await readFile(baselinePath, "utf8");
const authoringCutover = await readFile(authoringCutoverPath, "utf8");
const previousBaseline = baselineSource
  .replace("\\ir authoring-execution-cutover.sql\n", "")
  .replace("\\ir calibration-foundation.sql", () => calibrationFoundation)
  .replace("\\ir protected-capsule.sql", () => protectedCapsule);
const baseline = baselineSource
  .replace("\\ir calibration-foundation.sql", () => calibrationFoundation)
  .replace("\\ir protected-capsule.sql", () => protectedCapsule)
  .replace("\\ir authoring-execution-cutover.sql", () => authoringCutover);
const fingerprint = createHash("sha256").update(baseline).digest("hex");
const previousFingerprint = createHash("sha256").update(previousBaseline).digest("hex");
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
    if (installed.rows[0]?.schema_fingerprint === previousFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-authoring-execution-cutover'))");
        await client.query(authoringCutover);
        await client.query("UPDATE schema_baseline SET schema_fingerprint=$1, applied_at=now() WHERE singleton=true", [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied guarded authoring cutover ${fingerprint}\n`);
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
