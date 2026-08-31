import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../apps/api/migrations/", import.meta.url);

const calibration = await readFile(new URL("calibration-foundation.sql", root), "utf8");

const capsule = await readFile(new URL("protected-capsule.sql", root), "utf8");

const authoring = await readFile(new URL("authoring-execution-cutover.sql", root), "utf8");

const reporting = await readFile(new URL("praxis-reporting.sql", root), "utf8");

const cutoff = await readFile(new URL("praxis-cutoff.sql", root), "utf8");

const praxisCandidateInspection = await readFile(
  new URL("praxis-candidate-inspection.sql", root),
  "utf8",
);

const preferences = await readFile(new URL("veil-observation-preferences.sql", root), "utf8");

const retention = await readFile(new URL("veil-artifact-retention.sql", root), "utf8");

const compiledPlan = await readFile(new URL("compiled-plan-cutover.sql", root), "utf8");

const statefulProbeAuthoring = await readFile(
  new URL("stateful-probe-authoring.sql", root),
  "utf8",
);

const interactiveRuntimeCommands = await readFile(
  new URL("interactive-runtime-commands.sql", root),
  "utf8",
);

const interactiveRuntimeLifecycle = await readFile(
  new URL("interactive-runtime-lifecycle.sql", root),
  "utf8",
);

const authenticationAuthoring = await readFile(
  new URL("authentication-authoring.sql", root),
  "utf8",
);

const adaptiveAuthoring = await readFile(new URL("adaptive-authoring-pr9-pr12.sql", root), "utf8");

const adaptiveExecutionFoundation = await readFile(
  new URL("adaptive-execution-foundation-m0-m1.sql", root),
  "utf8",
);
const adaptiveSessions = await readFile(new URL("adaptive-sessions-m3.sql", root), "utf8");
const missionFirstM1 = await readFile(
  new URL("mission-first-live-convergence-m1.sql", root),
  "utf8",
);
const missionAuthoringGroupedTurnsM2 = await readFile(
  new URL("mission-authoring-grouped-turns-m2.sql", root),
  "utf8",
);
const protectedOperationStateMachine = await readFile(
  new URL("protected-operation-state-machine.sql", root),
  "utf8",
);
const protectedOperationCompletion = await readFile(
  new URL("protected-operation-completion.sql", root),
  "utf8",
);
const protectedOperationAuthoritativeProjection = await readFile(
  new URL("protected-operation-authoritative-projection.sql", root),
  "utf8",
);
const protectedResponseOutputStaging = await readFile(
  new URL("protected-response-output-staging.sql", root),
  "utf8",
);
const protectedReadOnlyDispatch = await readFile(
  new URL("protected-read-only-dispatch.sql", root),
  "utf8",
);
const externalResourceBindings = await readFile(
  new URL("external-resource-bindings.sql", root),
  "utf8",
);
const operationBoundSyntheticProtectedInputs = await readFile(
  new URL("operation-bound-synthetic-protected-inputs.sql", root),
  "utf8",
);
const structuredSyntheticProtectedInput = await readFile(
  new URL("structured-synthetic-protected-input.sql", root),
  "utf8",
);
const segmentedFlowSuccessorCheckpoints = await readFile(
  new URL("segmented-flow-successor-checkpoints.sql", root),
  "utf8",
);
const adaptiveCertificationProvenance = await readFile(
  new URL("adaptive-certification-provenance.sql", root),
  "utf8",
);
const adaptiveOperationReconciliation = await readFile(
  new URL("adaptive-operation-reconciliation.sql", root),
  "utf8",
);
const protectedOperationAuthorizationBinding = await readFile(
  new URL("protected-operation-authorization-binding.sql", root),
  "utf8",
);
const runPraxisSessionLedger = await readFile(
  new URL("run-praxis-session-ledger.sql", root),
  "utf8",
);
const protectedLivePraxisSession = await readFile(
  new URL("protected-live-praxis-session.sql", root),
  "utf8",
);
const resourceEffectReconciliation = await readFile(
  new URL("resource-effect-reconciliation.sql", root),
  "utf8",
);
const scopeUnknownFenceToResourceMutations = await readFile(
  new URL("20260820-0910_scope_unknown_fence_to_resource_mutations.sql", root),
  "utf8",
);

const documentTransitionGap = await readFile(
  new URL("20260816-231045_add_document_transition_gap.sql", root),
  "utf8",
);

const missionRecordingSelection = await readFile(
  new URL("mission-recording-selection.sql", root),
  "utf8",
);

const operationalEvents = await readFile(new URL("operational-events.sql", root), "utf8");
const missionDiagnosticIsolation = await readFile(
  new URL("mission-diagnostic-isolation.sql", root),
  "utf8",
);
const externalAgentLifecycle = await readFile(
  new URL("external-agent-lifecycle.sql", root),
  "utf8",
);
const preMissionExternalAgentLifecycle = await readFile(
  new URL("pre-mission-external-agent-lifecycle.sql", root),
  "utf8",
);
const flowNameIdentityCutover = await readFile(
  new URL("flow-name-identity-cutover.sql", root),
  "utf8",
);
const targetedRegionPerception = await readFile(
  new URL("targeted-region-perception.sql", root),
  "utf8",
);
const systemCorrectnessM4 = await readFile(
  new URL("system-correctness-m4-reconciliation-lease.sql", root),
  "utf8",
);
const qualificationCampaignSafety = await readFile(
  new URL("qualification-campaign-safety.sql", root),
  "utf8",
);
const authoritativeQ5Qualification = await readFile(
  new URL("authoritative-q5-qualification.sql", root),
  "utf8",
);
const q5CanonicalScopeBootstrap = await readFile(
  new URL("q5-canonical-scope-bootstrap.sql", root),
  "utf8",
);
const preparedProtectedOperationJourneys = await readFile(
  new URL("prepared-protected-operation-journeys.sql", root),
  "utf8",
);
const vitractQ5Composition = await readFile(new URL("vitract-q5-composition.sql", root), "utf8");
const preparedProtectedOperationReservationSettlement = await readFile(
  new URL("prepared-protected-operation-reservation-settlement.sql", root),
  "utf8",
);
const canonicalExecutionAuthority = await readFile(
  new URL("canonical-execution-authority.sql", root),
  "utf8",
);

const baseline = expandIncludes(await readFile(new URL("baseline.sql", root), "utf8"), [
  ["authoring-execution-cutover.sql", authoring],
  ["praxis-reporting.sql", reporting],
  ["praxis-cutoff.sql", cutoff],
  ["praxis-candidate-inspection.sql", praxisCandidateInspection],
  ["veil-observation-preferences.sql", preferences],
  ["veil-artifact-retention.sql", retention],
  ["compiled-plan-cutover.sql", compiledPlan],
  ["stateful-probe-authoring.sql", statefulProbeAuthoring],
  ["interactive-runtime-commands.sql", interactiveRuntimeCommands],
  ["interactive-runtime-lifecycle.sql", interactiveRuntimeLifecycle],
  ["authentication-authoring.sql", authenticationAuthoring],
  ["adaptive-authoring-pr9-pr12.sql", adaptiveAuthoring],
  ["adaptive-execution-foundation-m0-m1.sql", adaptiveExecutionFoundation],
  ["adaptive-sessions-m3.sql", adaptiveSessions],
  ["mission-first-live-convergence-m1.sql", missionFirstM1],
  ["mission-authoring-grouped-turns-m2.sql", missionAuthoringGroupedTurnsM2],
  ["protected-operation-state-machine.sql", protectedOperationStateMachine],
  ["protected-operation-completion.sql", protectedOperationCompletion],
  ["protected-operation-authoritative-projection.sql", protectedOperationAuthoritativeProjection],
  ["protected-response-output-staging.sql", protectedResponseOutputStaging],
  ["protected-read-only-dispatch.sql", protectedReadOnlyDispatch],
  ["external-resource-bindings.sql", externalResourceBindings],
  ["operation-bound-synthetic-protected-inputs.sql", operationBoundSyntheticProtectedInputs],
  ["structured-synthetic-protected-input.sql", structuredSyntheticProtectedInput],
  ["segmented-flow-successor-checkpoints.sql", segmentedFlowSuccessorCheckpoints],
  ["adaptive-certification-provenance.sql", adaptiveCertificationProvenance],
  ["adaptive-operation-reconciliation.sql", adaptiveOperationReconciliation],
  ["protected-operation-authorization-binding.sql", protectedOperationAuthorizationBinding],
  ["run-praxis-session-ledger.sql", runPraxisSessionLedger],
  ["protected-live-praxis-session.sql", protectedLivePraxisSession],
  ["resource-effect-reconciliation.sql", resourceEffectReconciliation],
  [
    "20260820-0910_scope_unknown_fence_to_resource_mutations.sql",
    scopeUnknownFenceToResourceMutations,
  ],
  ["20260816-231045_add_document_transition_gap.sql", documentTransitionGap],
  ["mission-recording-selection.sql", missionRecordingSelection],
  ["operational-events.sql", operationalEvents],
  ["mission-diagnostic-isolation.sql", missionDiagnosticIsolation],
  ["external-agent-lifecycle.sql", externalAgentLifecycle],
  ["pre-mission-external-agent-lifecycle.sql", preMissionExternalAgentLifecycle],
  ["flow-name-identity-cutover.sql", flowNameIdentityCutover],
  ["system-correctness-m4-reconciliation-lease.sql", systemCorrectnessM4],
  ["targeted-region-perception.sql", targetedRegionPerception],
  ["qualification-campaign-safety.sql", qualificationCampaignSafety],
  ["authoritative-q5-qualification.sql", authoritativeQ5Qualification],
  ["q5-canonical-scope-bootstrap.sql", q5CanonicalScopeBootstrap],
  ["prepared-protected-operation-journeys.sql", preparedProtectedOperationJourneys],
  ["vitract-q5-composition.sql", vitractQ5Composition],
  [
    "prepared-protected-operation-reservation-settlement.sql",
    preparedProtectedOperationReservationSettlement,
  ],
  ["canonical-execution-authority.sql", canonicalExecutionAuthority],
])
  .replace("\\ir calibration-foundation.sql", () => calibration)
  .replace("\\ir protected-capsule.sql", () => capsule);

process.stdout.write(`${createHash("sha256").update(baseline).digest("hex")}\n`);

function expandIncludes(source, migrations) {
  return migrations.reduce(
    (current, [name, contents]) =>
      current.replace(
        new RegExp(`\\\\ir\\s+${name.replaceAll(".", "\\.")}(?:\\r?\\n|$)`, "g"),
        () => contents,
      ),
    source,
  );
}
