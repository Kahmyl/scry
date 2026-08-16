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
const missionFirstM1Path = fileURLToPath(
  new URL("../migrations/mission-first-live-convergence-m1.sql", import.meta.url),
);
const missionAuthoringGroupedTurnsM2Path = fileURLToPath(
  new URL("../migrations/mission-authoring-grouped-turns-m2.sql", import.meta.url),
);
const protectedOperationStateMachinePath = fileURLToPath(
  new URL("../migrations/protected-operation-state-machine.sql", import.meta.url),
);
const protectedOperationCompletionPath = fileURLToPath(
  new URL("../migrations/protected-operation-completion.sql", import.meta.url),
);
const protectedOperationAuthoritativeProjectionPath = fileURLToPath(
  new URL("../migrations/protected-operation-authoritative-projection.sql", import.meta.url),
);
const protectedResponseOutputStagingPath = fileURLToPath(
  new URL("../migrations/protected-response-output-staging.sql", import.meta.url),
);
const protectedReadOnlyDispatchPath = fileURLToPath(
  new URL("../migrations/protected-read-only-dispatch.sql", import.meta.url),
);
const externalResourceBindingsPath = fileURLToPath(
  new URL("../migrations/external-resource-bindings.sql", import.meta.url),
);
const operationBoundSyntheticProtectedInputsPath = fileURLToPath(
  new URL("../migrations/operation-bound-synthetic-protected-inputs.sql", import.meta.url),
);
const structuredSyntheticProtectedInputPath = fileURLToPath(new URL("../migrations/structured-synthetic-protected-input.sql", import.meta.url));
const segmentedFlowSuccessorCheckpointsPath = fileURLToPath(new URL("../migrations/segmented-flow-successor-checkpoints.sql", import.meta.url));
const adaptiveCertificationProvenancePath = fileURLToPath(new URL("../migrations/adaptive-certification-provenance.sql", import.meta.url));
const adaptiveOperationReconciliationPath = fileURLToPath(new URL("../migrations/adaptive-operation-reconciliation.sql", import.meta.url));
const protectedOperationAuthorizationBindingPath = fileURLToPath(new URL("../migrations/protected-operation-authorization-binding.sql", import.meta.url));
const runPraxisSessionLedgerPath = fileURLToPath(new URL("../migrations/run-praxis-session-ledger.sql", import.meta.url));
const protectedLivePraxisSessionPath = fileURLToPath(new URL("../migrations/protected-live-praxis-session.sql", import.meta.url));

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
const missionFirstM1 = await readFile(missionFirstM1Path, "utf8");
const missionAuthoringGroupedTurnsM2 = await readFile(missionAuthoringGroupedTurnsM2Path, "utf8");
const protectedOperationStateMachine = await readFile(protectedOperationStateMachinePath, "utf8");
const protectedOperationCompletion = await readFile(protectedOperationCompletionPath, "utf8");
const protectedOperationAuthoritativeProjection = await readFile(protectedOperationAuthoritativeProjectionPath, "utf8");
const protectedResponseOutputStaging = await readFile(protectedResponseOutputStagingPath, "utf8");
const protectedReadOnlyDispatch = await readFile(protectedReadOnlyDispatchPath, "utf8");
const externalResourceBindings = await readFile(externalResourceBindingsPath, "utf8");
const operationBoundSyntheticProtectedInputs = await readFile(operationBoundSyntheticProtectedInputsPath, "utf8");
const structuredSyntheticProtectedInput = await readFile(structuredSyntheticProtectedInputPath, "utf8");
const segmentedFlowSuccessorCheckpoints = await readFile(segmentedFlowSuccessorCheckpointsPath, "utf8");
const adaptiveCertificationProvenance = await readFile(adaptiveCertificationProvenancePath, "utf8");
const adaptiveOperationReconciliation = await readFile(adaptiveOperationReconciliationPath, "utf8");
const protectedOperationAuthorizationBinding = await readFile(protectedOperationAuthorizationBindingPath, "utf8");
const runPraxisSessionLedger = await readFile(runPraxisSessionLedgerPath, "utf8");
const protectedLivePraxisSession = await readFile(protectedLivePraxisSessionPath, "utf8");
const segmentedFlowSuccessorCheckpointsUpgrade = `${segmentedFlowSuccessorCheckpoints}\n${adaptiveCertificationProvenance}`;

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
  "mission-first-live-convergence-m1.sql": missionFirstM1,
  "mission-authoring-grouped-turns-m2.sql": missionAuthoringGroupedTurnsM2,
  "protected-operation-state-machine.sql": protectedOperationStateMachine,
  "protected-operation-completion.sql": protectedOperationCompletion,
  "protected-operation-authoritative-projection.sql": protectedOperationAuthoritativeProjection,
  "protected-response-output-staging.sql": protectedResponseOutputStaging,
  "protected-read-only-dispatch.sql": protectedReadOnlyDispatch,
  "external-resource-bindings.sql": externalResourceBindings,
  "operation-bound-synthetic-protected-inputs.sql": operationBoundSyntheticProtectedInputs,
  "structured-synthetic-protected-input.sql": structuredSyntheticProtectedInput,
  "segmented-flow-successor-checkpoints.sql": segmentedFlowSuccessorCheckpoints,
  "adaptive-certification-provenance.sql": adaptiveCertificationProvenance,
  "adaptive-operation-reconciliation.sql": adaptiveOperationReconciliation,
  "protected-operation-authorization-binding.sql": protectedOperationAuthorizationBinding,
  "run-praxis-session-ledger.sql": runPraxisSessionLedger,
  "protected-live-praxis-session.sql": protectedLivePraxisSession,
};

const stagedBaseline = (included: readonly OptionalBaselineMigration[]) =>
  expandFoundation(expandBaselineStage(baselineSource, optionalMigrationSources, included));

const baseline = stagedBaseline(OPTIONAL_BASELINE_MIGRATIONS);
const preAdaptiveOperationReconciliationFingerprint = createHash("sha256").update(
  stagedBaseline(OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "adaptive-operation-reconciliation.sql")),
).digest("hex");
const preSegmentedFlowSuccessorCheckpointsFingerprint = createHash("sha256").update(
  stagedBaseline(OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "segmented-flow-successor-checkpoints.sql" && name !== "adaptive-certification-provenance.sql")),
).digest("hex");
const preAdaptiveCertificationProvenanceFingerprint = createHash("sha256").update(
  stagedBaseline(OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "adaptive-certification-provenance.sql")),
).digest("hex");
const preQualifiedDraftVersionFingerprint =
  "ab026810c7b0421eb118e16ffb746d1e080424c753c4cfac5bf8428f0f8dfe43";
const preVerifiedAttestationFingerprint =
  "9f50ce3c9f5a50c2b611ae595a1a208c60d5d872c362e8ec812d78962ef871a0";
const preMissionFirstM1Baseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter(
    (name) =>
      name !== "mission-first-live-convergence-m1.sql" &&
      name !== "mission-authoring-grouped-turns-m2.sql" &&
      name !== "protected-operation-authoritative-projection.sql" &&
      name !== "protected-response-output-staging.sql" &&
      name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql",
  ),
);
const preAdaptiveSessionsBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter(
    (name) => name !== "adaptive-sessions-m3.sql" && name !== "mission-authoring-grouped-turns-m2.sql" && name !== "protected-operation-authoritative-projection.sql" && name !== "protected-response-output-staging.sql" && name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql",
  ),
);
const preMissionAuthoringGroupedTurnsM2Baseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "mission-authoring-grouped-turns-m2.sql" && name !== "protected-operation-state-machine.sql" && name !== "protected-operation-completion.sql" && name !== "protected-operation-authoritative-projection.sql" && name !== "protected-response-output-staging.sql" && name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql"),
);
const preProtectedOperationStateMachineBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "protected-operation-state-machine.sql" && name !== "protected-operation-completion.sql" && name !== "protected-operation-authoritative-projection.sql" && name !== "protected-response-output-staging.sql" && name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql"),
);
const preProtectedOperationCompletionBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "protected-operation-completion.sql" && name !== "protected-operation-authoritative-projection.sql" && name !== "protected-response-output-staging.sql" && name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql"),
);
const preProtectedOperationAuthoritativeProjectionBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "protected-operation-authoritative-projection.sql" && name !== "protected-response-output-staging.sql" && name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql"),
);
const preProtectedResponseOutputStagingBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "protected-response-output-staging.sql" && name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql"),
);
const preProtectedReadOnlyDispatchBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "protected-read-only-dispatch.sql" && name !== "external-resource-bindings.sql"),
);
const preExternalResourceBindingsBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "external-resource-bindings.sql" && name !== "operation-bound-synthetic-protected-inputs.sql"),
);
const preOperationBoundSyntheticProtectedInputsBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "operation-bound-synthetic-protected-inputs.sql" && name !== "structured-synthetic-protected-input.sql"),
);
const preStructuredSyntheticProtectedInputBaseline = stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "structured-synthetic-protected-input.sql"),
);

const fingerprint = digest(baseline);
const preMissionFirstM1Fingerprint = digest(preMissionFirstM1Baseline);
const preAdaptiveSessionsFingerprint = digest(preAdaptiveSessionsBaseline);
const preMissionAuthoringGroupedTurnsM2Fingerprint = digest(
  preMissionAuthoringGroupedTurnsM2Baseline,
);
const preProtectedOperationStateMachineFingerprint = digest(preProtectedOperationStateMachineBaseline);
const preProtectedOperationCompletionFingerprint = digest(preProtectedOperationCompletionBaseline);
const preProtectedOperationAuthoritativeProjectionFingerprint = digest(preProtectedOperationAuthoritativeProjectionBaseline);
const preProtectedResponseOutputStagingFingerprint = digest(preProtectedResponseOutputStagingBaseline);
const preProtectedReadOnlyDispatchFingerprint = digest(preProtectedReadOnlyDispatchBaseline);
const preExternalResourceBindingsFingerprint = digest(preExternalResourceBindingsBaseline);
const preOperationBoundSyntheticProtectedInputsFingerprint = digest(preOperationBoundSyntheticProtectedInputsBaseline);
const preStructuredSyntheticProtectedInputFingerprint = digest(preStructuredSyntheticProtectedInputBaseline);
const preProtectedLivePraxisSessionFingerprint = digest(stagedBaseline(
  OPTIONAL_BASELINE_MIGRATIONS.filter((name) => name !== "protected-live-praxis-session.sql"),
));

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

    if (installedFingerprint === preProtectedLivePraxisSessionFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-protected-live-praxis-session'))");
        await client.query(protectedLivePraxisSession);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied protected live Praxis session ${fingerprint}\n`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else if (installedFingerprint === preAdaptiveOperationReconciliationFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-operation-reconciliation'))");
        await client.query(adaptiveOperationReconciliation);
        await client.query(protectedOperationAuthorizationBinding);
        await client.query(runPraxisSessionLedger);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied adaptive operation reconciliation ${fingerprint}\n`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else if ([preQualifiedDraftVersionFingerprint, preVerifiedAttestationFingerprint].includes(installedFingerprint)) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-certification-provenance'))");
        await client.query(adaptiveCertificationProvenance);
        await client.query(adaptiveOperationReconciliation);
        await client.query(protectedOperationAuthorizationBinding);
        await client.query(runPraxisSessionLedger);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied qualified draft-version provenance ${fingerprint}\n`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else if (installedFingerprint === preAdaptiveCertificationProvenanceFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-certification-provenance'))");
        await client.query(adaptiveCertificationProvenance);
        await client.query(adaptiveOperationReconciliation);
        await client.query(protectedOperationAuthorizationBinding);
        await client.query(runPraxisSessionLedger);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied adaptive certification provenance ${fingerprint}\n`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else if (installedFingerprint === preSegmentedFlowSuccessorCheckpointsFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-segmented-flow-successor-checkpoints'))");
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(adaptiveOperationReconciliation);
        await client.query(protectedOperationAuthorizationBinding);
        await client.query(runPraxisSessionLedger);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied segmented Flow successor checkpoints ${fingerprint}\n`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else if (installedFingerprint === preStructuredSyntheticProtectedInputFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-structured-synthetic-protected-input'))");
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied structured synthetic protected input ${fingerprint}\n`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } else if (installedFingerprint === preOperationBoundSyntheticProtectedInputsFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-operation-bound-synthetic-protected-inputs'))");
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied operation-bound synthetic protected inputs ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preExternalResourceBindingsFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-external-resource-bindings'))");
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied external resource bindings ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preProtectedReadOnlyDispatchFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-protected-read-only-dispatch'))");
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied protected read-only dispatch ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preProtectedResponseOutputStagingFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-protected-response-output-staging'))");
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied protected response output staging ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preProtectedOperationAuthoritativeProjectionFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-protected-operation-authoritative-projection'))");
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied protected operation authoritative projection ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preProtectedOperationCompletionFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('scry-protected-operation-completion'))");
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(`UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now() WHERE singleton=true`, [fingerprint]);
        await client.query("COMMIT");
        process.stdout.write(`Applied protected operation completion ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preProtectedOperationStateMachineFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-protected-operation-state-machine'))",
        );
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(
          `UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied protected operation state machine ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preMissionAuthoringGroupedTurnsM2Fingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-mission-authoring-grouped-turns-m2'))",
        );
        await client.query(missionAuthoringGroupedTurnsM2);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(
          `UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied Mission authoring grouped turns M2 ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preMissionFirstM1Fingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-mission-first-live-convergence-m1'))",
        );
        await client.query(missionFirstM1);
        await client.query(missionAuthoringGroupedTurnsM2);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(
          `UPDATE schema_baseline SET schema_fingerprint=$1,applied_at=now()
           WHERE singleton=true`,
          [fingerprint],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied Mission-first M1 ${fingerprint}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (installedFingerprint === preAdaptiveSessionsFingerprint) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('scry-adaptive-sessions-m3'))",
        );
        await client.query(adaptiveSessions);
        await client.query(missionFirstM1);
        await client.query(missionAuthoringGroupedTurnsM2);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
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
        await client.query(adaptiveSessions);
        await client.query(missionFirstM1);
        await client.query(missionAuthoringGroupedTurnsM2);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
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
        await client.query(adaptiveSessions);
        await client.query(missionFirstM1);
        await client.query(missionAuthoringGroupedTurnsM2);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);
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
        await client.query(adaptiveSessions);
        await client.query(missionFirstM1);
        await client.query(missionAuthoringGroupedTurnsM2);
        await client.query(protectedOperationStateMachine);
        await client.query(protectedOperationCompletion);
        await client.query(protectedOperationAuthoritativeProjection);
        await client.query(protectedResponseOutputStaging);
        await client.query(protectedReadOnlyDispatch);
        await client.query(externalResourceBindings);
        await client.query(operationBoundSyntheticProtectedInputs);
        await client.query(structuredSyntheticProtectedInput);
        await client.query(segmentedFlowSuccessorCheckpointsUpgrade);

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
        `Schema fingerprint mismatch: installed=${installedFingerprint ?? "missing"} required=${fingerprint} supportedPreM1=${preMissionFirstM1Fingerprint}. Stop all writers and run the guarded pre-production cutover; compatibility migration is intentionally unsupported.`,
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
