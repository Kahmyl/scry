import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { executionPolicySchema } from "@scry/contracts";
import { compileDefaultVeilPolicy } from "@scry/veil";
import pg from "pg";

import {
  calculateHistoricalFingerprints,
  assertReleasedFingerprintReconstruction,
  expandBaselineStage,
  OPTIONAL_BASELINE_MIGRATIONS,
  supportedHistoricalFingerprints,
  RELEASED_HISTORICAL_FINGERPRINTS,
  type OptionalBaselineMigration,
} from "./migration-fingerprint-compatibility.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry";

const baselinePath = fileURLToPath(new URL("../migrations/baseline.sql", import.meta.url));

const calibrationFoundationPath = fileURLToPath(
  new URL("../migrations/calibration-foundation.sql", import.meta.url),
);

const protectedCapsulePath = fileURLToPath(
  new URL("../migrations/protected-capsule.sql", import.meta.url),
);

const authoringCutoverPath = fileURLToPath(
  new URL("../migrations/authoring-execution-cutover.sql", import.meta.url),
);

const praxisReportingPath = fileURLToPath(
  new URL("../migrations/praxis-reporting.sql", import.meta.url),
);

const praxisCutoffPath = fileURLToPath(new URL("../migrations/praxis-cutoff.sql", import.meta.url));

const praxisCandidateInspectionPath = fileURLToPath(
  new URL("../migrations/praxis-candidate-inspection.sql", import.meta.url),
);

const authenticationAuthoringPath = fileURLToPath(
  new URL("../migrations/authentication-authoring.sql", import.meta.url),
);

const veilObservationPreferencesPath = fileURLToPath(
  new URL("../migrations/veil-observation-preferences.sql", import.meta.url),
);

const veilArtifactRetentionPath = fileURLToPath(
  new URL("../migrations/veil-artifact-retention.sql", import.meta.url),
);

const compiledPlanCutoverPath = fileURLToPath(
  new URL("../migrations/compiled-plan-cutover.sql", import.meta.url),
);

const statefulProbeAuthoringPath = fileURLToPath(
  new URL("../migrations/stateful-probe-authoring.sql", import.meta.url),
);

const interactiveRuntimeCommandsPath = fileURLToPath(
  new URL("../migrations/interactive-runtime-commands.sql", import.meta.url),
);

const interactiveRuntimeLifecyclePath = fileURLToPath(
  new URL("../migrations/interactive-runtime-lifecycle.sql", import.meta.url),
);

const adaptiveAuthoringPath = fileURLToPath(
  new URL("../migrations/adaptive-authoring-pr9-pr12.sql", import.meta.url),
);
const adaptiveExecutionFoundationPath = fileURLToPath(
  new URL("../migrations/adaptive-execution-foundation-m0-m1.sql", import.meta.url),
);
const adaptiveSessionsPath = fileURLToPath(
  new URL("../migrations/adaptive-sessions-m3.sql", import.meta.url),
);

const calibrationFoundation = await readFile(calibrationFoundationPath, "utf8");

const protectedCapsule = await readFile(protectedCapsulePath, "utf8");

const baselineSource = await readFile(baselinePath, "utf8");

const authoringCutover = await readFile(authoringCutoverPath, "utf8");

const praxisReporting = await readFile(praxisReportingPath, "utf8");

const praxisCutoff = await readFile(praxisCutoffPath, "utf8");
const praxisCandidateInspection = await readFile(praxisCandidateInspectionPath, "utf8");

const authenticationAuthoring = await readFile(authenticationAuthoringPath, "utf8");

const veilObservationPreferences = await readFile(veilObservationPreferencesPath, "utf8");

const veilArtifactRetention = await readFile(veilArtifactRetentionPath, "utf8");

const compiledPlanCutover = await readFile(compiledPlanCutoverPath, "utf8");

const statefulProbeAuthoring = await readFile(statefulProbeAuthoringPath, "utf8");

const interactiveRuntimeCommands = await readFile(interactiveRuntimeCommandsPath, "utf8");

const interactiveRuntimeLifecycle = await readFile(interactiveRuntimeLifecyclePath, "utf8");

const adaptiveAuthoring = await readFile(adaptiveAuthoringPath, "utf8");
const adaptiveExecutionFoundation = await readFile(adaptiveExecutionFoundationPath, "utf8");
const adaptiveSessions = await readFile(adaptiveSessionsPath, "utf8");

const expandFoundation = (source: string) =>
  source
    .replace("\\ir calibration-foundation.sql", () => calibrationFoundation)
    .replace("\\ir protected-capsule.sql", () => protectedCapsule);

const optionalMigrationSources: Record<OptionalBaselineMigration, string> = {
  "authoring-execution-cutover.sql": authoringCutover,
  "praxis-reporting.sql": praxisReporting,
  "praxis-cutoff.sql": praxisCutoff,
  "praxis-candidate-inspection.sql": praxisCandidateInspection,
  "veil-observation-preferences.sql": veilObservationPreferences,
  "veil-artifact-retention.sql": veilArtifactRetention,
  "compiled-plan-cutover.sql": compiledPlanCutover,
  "stateful-probe-authoring.sql": statefulProbeAuthoring,
  "interactive-runtime-commands.sql": interactiveRuntimeCommands,
  "interactive-runtime-lifecycle.sql": interactiveRuntimeLifecycle,
  "authentication-authoring.sql": authenticationAuthoring,
  "adaptive-authoring-pr9-pr12.sql": adaptiveAuthoring,
  "adaptive-execution-foundation-m0-m1.sql": adaptiveExecutionFoundation,
  "adaptive-sessions-m3.sql": adaptiveSessions,
};

const stagedBaseline = (included: readonly OptionalBaselineMigration[]) =>
  expandFoundation(expandBaselineStage(baselineSource, optionalMigrationSources, included));

const baseline = stagedBaseline(OPTIONAL_BASELINE_MIGRATIONS);
const preAdaptiveSessionsBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "adaptive-sessions-m3.sql"),
);

const fingerprint = digest(baseline);
const preAdaptiveSessionsFingerprint = digest(preAdaptiveSessionsBaseline);

const previousVeilFullFingerprint =
  "8c0e5ae0ae72f9a163189abe903b317e38aacf6b1674f3441b62dd7129b48c6a";
const legacyInteractiveRuntimeFingerprint =
  "1dd96bf7b7a8e4273ec2f9da327c58182e3ca7516d0c71377af69482fb437c84";
const deployedAdaptiveAuthoringFingerprint =
  "01d52bd699c707bc293b5b81701de4e137e4f4ac1054d701675dc9db1b06b28c";
const historicalFingerprints = calculateHistoricalFingerprints({
  baselineSource,
  migrationSources: optionalMigrationSources,
  expandFoundation,
  previousVeilFullFingerprint,
});
assertReleasedFingerprintReconstruction(historicalFingerprints);
const releasedHistoricalFingerprints = RELEASED_HISTORICAL_FINGERPRINTS;

const pool = new pg.Pool({
  connectionString: databaseUrl,
});

try {
  const baselineTable = await pool.query("SELECT to_regclass('public.schema_baseline') AS table");

  if (!baselineTable.rows[0]?.table) {
    const legacy = await pool.query("SELECT to_regclass('public.schema_migrations') AS table");

    if (legacy.rows[0]?.table) {
      throw new Error(
        "Legacy schema detected. Run the guarded pre-production cutoff instead of applying compatibility migrations.",
      );
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(baseline);

      await client.query("INSERT INTO schema_baseline(schema_fingerprint) VALUES ($1)", [
        fingerprint,
      ]);

      await client.query("COMMIT");

      process.stdout.write(`Applied clean baseline ${fingerprint}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else {
    const installed = await pool.query(
      "SELECT schema_fingerprint FROM schema_baseline WHERE singleton = true",
    );

    const installedFingerprint = installed.rows[0]?.schema_fingerprint;

    const supportedPreviousFingerprints = supportedHistoricalFingerprints(
      releasedHistoricalFingerprints,
    );

    if (installedFingerprint === preAdaptiveSessionsFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-sessions-m3'))",
        );
        await client.query(adaptiveSessions);
        await client.query(
          `UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied adaptive sessions M3 ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (
      [
        releasedHistoricalFingerprints.pre_adaptive_execution,
        deployedAdaptiveAuthoringFingerprint,
      ].includes(installedFingerprint)
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-execution-foundation-m0-m1'))",
        );
        await client.query(adaptiveExecutionFoundation);
        await client.query(
          `UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied adaptive execution foundation ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (
      [
        legacyInteractiveRuntimeFingerprint,
        releasedHistoricalFingerprints.interactive_runtime_lifecycle,
        releasedHistoricalFingerprints.praxis_candidate_inspection,
        releasedHistoricalFingerprints.authentication_authoring,
      ].includes(installedFingerprint)
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-authoring-cutover'))",
        );
        if (installedFingerprint === legacyInteractiveRuntimeFingerprint) {
          await assertLegacyInteractiveRuntimeShape(client);
        }
        if (
          installedFingerprint === legacyInteractiveRuntimeFingerprint ||
          installedFingerprint === releasedHistoricalFingerprints.interactive_runtime_lifecycle
        ) {
          await client.query(praxisCandidateInspection);
        }
        if (installedFingerprint !== releasedHistoricalFingerprints.authentication_authoring) {
          await client.query(authenticationAuthoring);
        }
        await client.query(adaptiveAuthoring);
        await client.query(adaptiveExecutionFoundation);
        await client.query(
          `UPDATE schema_baseline
           SET schema_fingerprint=$1,applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied guarded post-lifecycle cutover ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (supportedPreviousFingerprints.includes(installedFingerprint)) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-interactive-runtime-lifecycle-cutover'))",
        );

        if (installedFingerprint === releasedHistoricalFingerprints.base) {
          await client.query(authoringCutover);
        }

        if (
          installedFingerprint === releasedHistoricalFingerprints.base ||
          installedFingerprint === releasedHistoricalFingerprints.authoring
        ) {
          await client.query(praxisReporting);
        }

        if (
          [
            releasedHistoricalFingerprints.base,
            releasedHistoricalFingerprints.authoring,
            releasedHistoricalFingerprints.reporting,
          ].includes(installedFingerprint)
        ) {
          await client.query(praxisCutoff);
        }

        if (
          installedFingerprint !== releasedHistoricalFingerprints.preferences &&
          installedFingerprint !== releasedHistoricalFingerprints.veil_full &&
          installedFingerprint !== releasedHistoricalFingerprints.previous_veil_full
        ) {
          await client.query(veilObservationPreferences);
        }

        await backfillVeilPolicySnapshots(client);

        if (
          installedFingerprint !== releasedHistoricalFingerprints.veil_full &&
          installedFingerprint !== releasedHistoricalFingerprints.previous_veil_full
        ) {
          await client.query(veilArtifactRetention);
        }

        if (
          installedFingerprint !== releasedHistoricalFingerprints.compiled_plan &&
          installedFingerprint !== releasedHistoricalFingerprints.stateful_probe_authoring &&
          installedFingerprint !== releasedHistoricalFingerprints.interactive_runtime_commands
        ) {
          await client.query(compiledPlanCutover);
        }

        if (
          installedFingerprint !== releasedHistoricalFingerprints.stateful_probe_authoring &&
          installedFingerprint !== releasedHistoricalFingerprints.interactive_runtime_commands
        ) {
          await client.query(statefulProbeAuthoring);
        }

        if (installedFingerprint !== releasedHistoricalFingerprints.interactive_runtime_commands) {
          await client.query(interactiveRuntimeCommands);
        }

        await client.query(interactiveRuntimeLifecycle);

        await client.query(praxisCandidateInspection);

        await client.query(authenticationAuthoring);

        await client.query(adaptiveAuthoring);
        await client.query(adaptiveExecutionFoundation);

        await client.query(
          `UPDATE schema_baseline
           SET schema_fingerprint=$1,
               applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );

        await client.query("COMMIT");

        process.stdout.write(`Applied guarded interactive runtime lifecycle ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint !== fingerprint) {
      throw new Error(
        `Schema fingerprint mismatch: installed=${installedFingerprint ?? "missing"} required=${fingerprint}. Stop all writers and run the guarded interactive-runtime lifecycle pre-production cutover; compatibility migration is intentionally unsupported.`,
      );
    } else {
      process.stdout.write(`Clean baseline already present ${fingerprint}\n`);
    }
  }
} finally {
  await pool.end();
}

async function backfillVeilPolicySnapshots(client: pg.PoolClient) {
  const runs = await client.query<{
    id: string;
    policy_snapshot: unknown;
  }>(
    `SELECT id,policy_snapshot
     FROM runs
     WHERE veil_policy_snapshot->>'digest'=repeat('0',64)
     FOR UPDATE`,
  );

  for (const run of runs.rows) {
    const snapshot = compileDefaultVeilPolicy(executionPolicySchema.parse(run.policy_snapshot));

    await client.query(
      `UPDATE runs
       SET veil_policy_snapshot=$2::jsonb
       WHERE id=$1`,
      [run.id, JSON.stringify(snapshot)],
    );
  }
}

async function assertLegacyInteractiveRuntimeShape(client: pg.PoolClient) {
  const shape = await client.query<{
    commands: string | null;
    lifecycle: string | null;
    authentication: string | null;
    adaptiveColumn: string | null;
  }>(
    `SELECT
       to_regclass('public.authoring_runtime_commands')::text AS commands,
       to_regclass('public.authoring_browser_leases')::text AS lifecycle,
       to_regclass('public.authentication_attempts')::text AS authentication,
       (SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='flow_compilations'
          AND column_name='contract_version') AS "adaptiveColumn"`,
  );
  const row = shape.rows[0]!;
  if (!row.commands || !row.lifecycle || row.authentication || row.adaptiveColumn) {
    throw new Error(
      "Legacy adaptive-authoring cutover refused: installed schema shape does not match the approved historical state.",
    );
  }
}

function digest(source: string) {
  return createHash("sha256").update(source).digest("hex");
}
