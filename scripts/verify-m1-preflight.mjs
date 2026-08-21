import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url).pathname;
const snapshot = "/private/tmp/scry-m1-cutover-2b9e22e42cf3/development-db.dump";
const migrationOnly = process.argv.includes("--migration-only");
const commit = command("git", ["rev-parse", "HEAD"]);
const fingerprint = command("pnpm", ["--silent", "schema:fingerprint"]);
const releaseId = `m1-local-${commit.slice(0, 12)}`;
const runtimeVersion = "m1-local";
const suffix = commit.slice(0, 12).replace(/[^a-f0-9]/g, "");
const template = `scry_m1_snapshot_template_${suffix}`;
const qualification = `scry_m1_qualification_${suffix}_${process.pid}`;
const report = {
  verdict: "blocked",
  reasonCode: undefined,
  releaseId,
  gitCommit: commit,
  schemaFingerprint: fingerprint,
  runtimeConfigurationDigest: digest({
    releaseId,
    gitCommit: commit,
    schemaFingerprint: fingerprint,
    runtimeVersion,
  }),
  migration: {},
  services: {},
  targets: {},
};

try {
  if (!existsSync(snapshot)) throw typed("M1_SNAPSHOT_REQUIRED");
  ensureTemplate();
  pg("createdb", ["-T", template, qualification]);
  try {
    const databaseUrl = `postgres://scry:scry-local@127.0.0.1:54329/${qualification}`;
    migrate(databaseUrl);
    const ownership = sql(
      qualification,
      `
      SELECT
        count(*) FILTER (WHERE state NOT IN ('completed','failed','cancelled') AND
          (mission_id IS NULL OR objective_id IS NULL OR flow_draft_id IS NULL)),
        count(*) FILTER (WHERE state='cancelled' AND decision_boundary->>'reasonCode'=
          'LEGACY_SESSION_UNOWNED_AT_M1_CUTOVER'),
        (SELECT count(*) FROM adaptive_session_events
          WHERE type='session_cancelled' AND safe_facts->>'reasonCode'=
            'LEGACY_SESSION_UNOWNED_AT_M1_CUTOVER')
      FROM adaptive_sessions
    `,
    )
      .split("|")
      .map(Number);
    if (ownership[0] !== 0) throw typed("M1_SNAPSHOT_INVALID_OWNERSHIP_TUPLE");
    if (ownership[1] !== 33 || ownership[2] !== 33)
      throw typed("M1_SNAPSHOT_LEGACY_RECONCILIATION_COUNT_MISMATCH");
    const bindings = Number(
      sql(
        qualification,
        `
      SELECT count(*) FROM environments e
      JOIN LATERAL jsonb_array_elements_text(e.secret_refs) ref(value) ON true
      JOIN project_credentials c ON c.id::text=ref.value AND c.project_id=e.project_id
      WHERE e.base_origin='https://preview.vitract.com'
        AND c.name IN ('Vitract preview login email','Vitract preview login password')
        AND c.deleted_at IS NULL AND c.security_status='active'
    `,
      ),
    );
    if (bindings < 2) throw typed("M1_VITRACT_ENCRYPTED_BINDINGS_REQUIRED");
    migrate(databaseUrl);
    const evidenceAfterReplay = Number(
      sql(
        qualification,
        `
      SELECT count(*) FROM adaptive_session_events
      WHERE type='session_cancelled' AND safe_facts->>'reasonCode'=
        'LEGACY_SESSION_UNOWNED_AT_M1_CUTOVER'
    `,
      ),
    );
    if (evidenceAfterReplay !== 33) throw typed("M1_MIGRATION_NOT_IDEMPOTENT");
    report.migration = {
      snapshotRestored: true,
      invalidOwnershipTuples: ownership[0],
      terminalizedLegacySessions: ownership[1],
      migrationEvidenceEvents: ownership[2],
      encryptedVitractBindings: bindings,
      idempotent: true,
    };
  } finally {
    pg("dropdb", ["--if-exists", qualification]);
  }

  if (!migrationOnly) {
    verifyServices();
    await verifyTargets();
  }
  report.verdict = "pass";
  delete report.reasonCode;
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  report.reasonCode = safeCode(error);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
}

function ensureTemplate() {
  const exists = sql("postgres", `SELECT 1 FROM pg_database WHERE datname='${template}'`);
  if (exists === "1") return;
  pg("createdb", [template]);
  const restored = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "-U",
      "scry",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "-d",
      template,
    ],
    { cwd: root, input: readFileSync(snapshot), encoding: "utf8", maxBuffer: 1024 * 1024 * 20 },
  );
  if (restored.status !== 0) {
    pg("dropdb", ["--if-exists", template]);
    throw typed("M1_SNAPSHOT_RESTORE_FAILED");
  }
  pg("psql", ["-d", "postgres", "-Atc", `ALTER DATABASE ${template} IS_TEMPLATE true`]);
}

function migrate(databaseUrl) {
  const result = spawnSync("pnpm", ["--filter", "@scry/api", "db:migrate"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SCRY_RELEASE_ID: releaseId,
      SCRY_GIT_COMMIT: commit,
      SCRY_SCHEMA_FINGERPRINT: fingerprint,
      SCRY_RUNTIME_VERSION: runtimeVersion,
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  if (result.status !== 0) throw typed("M1_MIGRATION_QUALIFICATION_FAILED");
}

function verifyServices() {
  const lines = command("docker", ["compose", "ps", "--format", "json"])
    .split("\n")
    .filter(Boolean);
  const required = new Set(["postgres", "redis", "api", "mcp", "worker", "web"]);
  for (const line of lines) {
    const service = JSON.parse(line);
    if (!required.has(service.Service)) continue;
    const healthy =
      service.State === "running" && (!service.Health || service.Health === "healthy");
    report.services[service.Service] = healthy ? "healthy" : "unhealthy";
    if (!healthy) throw typed("M1_REQUIRED_SERVICE_UNHEALTHY");
    required.delete(service.Service);
  }
  if (required.size) throw typed("M1_REQUIRED_SERVICE_MISSING");
  for (const name of [
    "SCRY_RELEASE_ID",
    "SCRY_GIT_COMMIT",
    "SCRY_SCHEMA_FINGERPRINT",
    "SCRY_RUNTIME_VERSION",
  ])
    report.services[name] =
      command("docker", ["compose", "exec", "-T", "api", "printenv", name]) ===
      {
        SCRY_RELEASE_ID: releaseId,
        SCRY_GIT_COMMIT: commit,
        SCRY_SCHEMA_FINGERPRINT: fingerprint,
        SCRY_RUNTIME_VERSION: runtimeVersion,
      }[name]
        ? "matched"
        : "mismatched";
  if (Object.values(report.services).includes("mismatched"))
    throw typed("M1_RUNTIME_IDENTITY_MISMATCH");
}

async function verifyTargets() {
  const targets = {
    vitract_preview: "https://preview.vitract.com",
    orangehrm: "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login",
    expand_testing: "https://practice.expandtesting.com/login",
    the_internet: "https://the-internet.herokuapp.com/login",
    xyz_bank: "https://www.globalsqa.com/angularJs-protractor/BankingProject/#/login",
  };
  for (const [name, url] of Object.entries(targets)) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      report.targets[name] = response.ok ? "reachable" : `http_${response.status}`;
      if (!response.ok) throw typed(`M1_TARGET_UNREACHABLE_${name.toUpperCase()}`);
    } catch (error) {
      if (safeCode(error).startsWith("M1_TARGET_UNREACHABLE_")) throw error;
      throw typed(`M1_TARGET_UNREACHABLE_${name.toUpperCase()}`);
    }
  }
}

function pg(program, args) {
  return command("docker", ["compose", "exec", "-T", "postgres", program, "-U", "scry", ...args]);
}
function sql(database, query) {
  return pg("psql", ["-d", database, "-Atc", query]);
}
function command(program, args) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function typed(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function safeCode(error) {
  const candidate = error?.code ?? error?.message ?? "M1_PREFLIGHT_FAILED";
  return /^[A-Z0-9_]+$/.test(candidate) ? candidate : "M1_PREFLIGHT_FAILED";
}
