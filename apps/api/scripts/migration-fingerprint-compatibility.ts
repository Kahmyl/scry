import { createHash } from "node:crypto";

export const AUTHORITATIVE_D647_FINGERPRINT =
  "d647df341b454e74f0e2263dc7e54c4c41b05e440b59adceac5566ef5d7a05c3";

export const AUTHORITATIVE_D647_SHAPE_SQL = `
  SELECT
    to_regclass('public.protected_operations') IS NOT NULL AS "hasProtectedOperations",
    to_regclass('public.adaptive_operations') IS NOT NULL AS "hasAdaptiveOperations",
    to_regclass('public.adaptive_operation_reconciliations') IS NOT NULL AS "hasReconciliations",
    to_regclass('public.mission_recording_selections') IS NOT NULL AS "hasRecordingSelections",
    COALESCE((
      SELECT pg_get_constraintdef(oid) LIKE '%document_transition_gap%'
      FROM pg_constraint
      WHERE conrelid=to_regclass('public.artifact_timeline_entries')
        AND conname='artifact_timeline_entries_entry_type_check'
    ),false) AS "hasDocumentTransitionGap",
    COALESCE((
      SELECT pg_get_functiondef(oid) LIKE '%action'' ->> ''kind'' <> ''authenticate''%'
      FROM pg_proc
      WHERE oid=to_regprocedure('public.adaptive_operation_unknown_unresolved(uuid,text)')
    ),false) AS "hasScopedUnknownFence",
    COALESCE((
      SELECT pg_get_functiondef(oid) LIKE '%Applied recovery adaptive protected projection%'
      FROM pg_proc
      WHERE oid=to_regprocedure('public.protect_adaptive_operation_identity()')
    ),false) AS "hasAppliedRecoveryProjection"
`;

export type AuthoritativeD647Shape = {
  hasProtectedOperations: boolean;
  hasAdaptiveOperations: boolean;
  hasReconciliations: boolean;
  hasRecordingSelections: boolean;
  hasDocumentTransitionGap: boolean;
  hasScopedUnknownFence: boolean;
  hasAppliedRecoveryProjection: boolean;
};

export function assertAuthoritativeD647Shape(shape: AuthoritativeD647Shape | undefined): void {
  if (
    !shape?.hasProtectedOperations ||
    !shape.hasAdaptiveOperations ||
    !shape.hasReconciliations ||
    shape.hasRecordingSelections ||
    shape.hasDocumentTransitionGap ||
    shape.hasScopedUnknownFence ||
    shape.hasAppliedRecoveryProjection
  )
    throw new Error("AUTHORITATIVE_D647_LINEAGE_SHAPE_MISMATCH");
}

export function assertConfiguredMigrationFingerprint(
  configured: string | undefined,
  embedded: string,
): void {
  if (configured && configured !== embedded)
    throw new Error(
      `MIGRATION_IMAGE_SCHEMA_FINGERPRINT_MISMATCH: configured=${configured} embedded=${embedded}`,
    );
}

export const SUPPORTED_HISTORICAL_BASELINES = [
  "base",
  "authoring",
  "reporting",
  "praxis",
  "preferences",
  "veil_full",
  "previous_veil_full",
  "compiled_plan",
  "stateful_probe_authoring",
  "interactive_runtime_commands",
  "interactive_runtime_lifecycle",
  "praxis_candidate_inspection",
  "authentication_authoring",
  "pre_adaptive_execution",
] as const;

export const OPTIONAL_BASELINE_MIGRATIONS = [
  "authoring-execution-cutover.sql",
  "praxis-reporting.sql",
  "praxis-cutoff.sql",
  "praxis-candidate-inspection.sql",
  "veil-observation-preferences.sql",
  "veil-artifact-retention.sql",
  "compiled-plan-cutover.sql",
  "stateful-probe-authoring.sql",
  "interactive-runtime-commands.sql",
  "interactive-runtime-lifecycle.sql",
  "authentication-authoring.sql",
  "adaptive-authoring-pr9-pr12.sql",
  "adaptive-execution-foundation-m0-m1.sql",
  "adaptive-sessions-m3.sql",
  "mission-first-live-convergence-m1.sql",
  "mission-authoring-grouped-turns-m2.sql",
  "protected-operation-state-machine.sql",
  "protected-operation-completion.sql",
  "protected-operation-authoritative-projection.sql",
  "protected-response-output-staging.sql",
  "protected-read-only-dispatch.sql",
  "external-resource-bindings.sql",
  "operation-bound-synthetic-protected-inputs.sql",
  "structured-synthetic-protected-input.sql",
  "segmented-flow-successor-checkpoints.sql",
  "adaptive-certification-provenance.sql",
  "adaptive-operation-reconciliation.sql",
  "protected-operation-authorization-binding.sql",
  "run-praxis-session-ledger.sql",
  "protected-live-praxis-session.sql",
  "resource-effect-reconciliation.sql",
  "20260820-0910_scope_unknown_fence_to_resource_mutations.sql",
  "20260816-231045_add_document_transition_gap.sql",
  "mission-recording-selection.sql",
  "operational-events.sql",
  "mission-diagnostic-isolation.sql",
  "external-agent-lifecycle.sql",
  "pre-mission-external-agent-lifecycle.sql",
  "flow-name-identity-cutover.sql",
] as const;

export type OptionalBaselineMigration = (typeof OPTIONAL_BASELINE_MIGRATIONS)[number];
type HistoricalBaseline = (typeof SUPPORTED_HISTORICAL_BASELINES)[number];

export const RELEASED_HISTORICAL_FINGERPRINTS: Readonly<Record<HistoricalBaseline, string>> = {
  base: "dd834e85ff99b318c5b9f0795b85738e599c6f3ae5c4b51921a0fa25598e08f0",
  authoring: "650d193ccec60883488576c9eec3641b2f67cb3e534fd4d89b22db5576aa9c47",
  reporting: "226509c0da78f776d5451fd8ee15eb3902b99b1860d192ba21109300fb07e071",
  praxis: "66d3b399ab5ab272c81e44d0423031b542ae35b7f898b688d6991ed83630c9fc",
  preferences: "5b000f55f52ee2d193c765b19a1679afd44a82a41631e5d6dff1036460aa62ea",
  veil_full: "444772bff0dac5f1e7efd71b4fa46ff21276755b6555a0431180b4058d538e1f",
  previous_veil_full: "8c0e5ae0ae72f9a163189abe903b317e38aacf6b1674f3441b62dd7129b48c6a",
  compiled_plan: "96fc8e5cd238eaa22bf22fe479c1b725d28f7fe462ad4c33978de2ca31ddd2ac",
  stateful_probe_authoring: "a243279fa835bb9e7bf34d67db04d193635a9f2da758f7636de733c057337345",
  interactive_runtime_commands: "d18621b5bb37aec3d648343e23e0d7ec69ed098a8e6080cb0e5155659fef4796",
  interactive_runtime_lifecycle: "22d4e9b22d2779a278b8241c42ff5c138c624e68b6665169571064a29b6c18d6",
  praxis_candidate_inspection: "3f9aecbd3deab969666b229c297327439f0e1ac2f8afa970ced3dd26ffa807a0",
  authentication_authoring: "9aba920c7a0f478c354ae1247048ebb9a78e9ed4685be3f5de4d0c4a13b363f3",
  pre_adaptive_execution: "4813c6cc6eed66d7fe135be4dc189a6d3f4bec3b72890009e16bbeab28ea896a",
};

const AUTHORING: OptionalBaselineMigration[] = ["authoring-execution-cutover.sql"];
const REPORTING: OptionalBaselineMigration[] = [...AUTHORING, "praxis-reporting.sql"];
const PRAXIS: OptionalBaselineMigration[] = [...REPORTING, "praxis-cutoff.sql"];
const PREFERENCES: OptionalBaselineMigration[] = [...PRAXIS, "veil-observation-preferences.sql"];
const VEIL_FULL: OptionalBaselineMigration[] = [...PREFERENCES, "veil-artifact-retention.sql"];
const COMPILED: OptionalBaselineMigration[] = [...VEIL_FULL, "compiled-plan-cutover.sql"];
const STATEFUL: OptionalBaselineMigration[] = [...COMPILED, "stateful-probe-authoring.sql"];
const COMMANDS: OptionalBaselineMigration[] = [...STATEFUL, "interactive-runtime-commands.sql"];
const LIFECYCLE: OptionalBaselineMigration[] = [...COMMANDS, "interactive-runtime-lifecycle.sql"];
const CANDIDATE: OptionalBaselineMigration[] = [...LIFECYCLE, "praxis-candidate-inspection.sql"];
const AUTHENTICATION: OptionalBaselineMigration[] = [...CANDIDATE, "authentication-authoring.sql"];

export const HISTORICAL_BASELINE_STAGES: Record<
  Exclude<HistoricalBaseline, "previous_veil_full">,
  readonly OptionalBaselineMigration[]
> = {
  base: [],
  authoring: AUTHORING,
  reporting: REPORTING,
  praxis: PRAXIS,
  preferences: PREFERENCES,
  veil_full: VEIL_FULL,
  compiled_plan: COMPILED,
  stateful_probe_authoring: STATEFUL,
  interactive_runtime_commands: COMMANDS,
  interactive_runtime_lifecycle: LIFECYCLE,
  praxis_candidate_inspection: CANDIDATE,
  authentication_authoring: AUTHENTICATION,
  pre_adaptive_execution: [...AUTHENTICATION, "adaptive-authoring-pr9-pr12.sql"],
};

export function compatibilityBaseline(source: string): string {
  return [
    "praxis-candidate-inspection.sql",
    "authentication-authoring.sql",
    "adaptive-authoring-pr9-pr12.sql",
    "adaptive-execution-foundation-m0-m1.sql",
    "adaptive-sessions-m3.sql",
    "mission-first-live-convergence-m1.sql",
    "mission-authoring-grouped-turns-m2.sql",
    "protected-operation-state-machine.sql",
    "protected-operation-completion.sql",
    "protected-operation-authoritative-projection.sql",
    "protected-response-output-staging.sql",
    "protected-read-only-dispatch.sql",
    "external-resource-bindings.sql",
    "operation-bound-synthetic-protected-inputs.sql",
    "structured-synthetic-protected-input.sql",
    "segmented-flow-successor-checkpoints.sql",
    "adaptive-certification-provenance.sql",
    "adaptive-operation-reconciliation.sql",
    "protected-operation-authorization-binding.sql",
    "run-praxis-session-ledger.sql",
    "protected-live-praxis-session.sql",
    "resource-effect-reconciliation.sql",
    "20260820-0910_scope_unknown_fence_to_resource_mutations.sql",
    "20260816-231045_add_document_transition_gap.sql",
    "mission-recording-selection.sql",
    "operational-events.sql",
    "mission-diagnostic-isolation.sql",
    "external-agent-lifecycle.sql",
    "pre-mission-external-agent-lifecycle.sql",
    "flow-name-identity-cutover.sql",
  ].reduce(
    (current, migration) =>
      current.replace(new RegExp(`\\\\ir\\s+${escape(migration)}\\r?\\n`, "g"), ""),
    source,
  );
}

export function expandBaselineStage(
  source: string,
  migrationSources: Record<OptionalBaselineMigration, string>,
  included: readonly OptionalBaselineMigration[],
): string {
  const admitted = new Set(included);
  return OPTIONAL_BASELINE_MIGRATIONS.reduce(
    (current, migration) =>
      current.replace(new RegExp(`\\\\ir\\s+${escape(migration)}(?:\\r?\\n|$)`, "g"), () =>
        admitted.has(migration) ? migrationSources[migration] : "",
      ),
    source,
  );
}

export function supportedHistoricalFingerprints(
  values: Record<(typeof SUPPORTED_HISTORICAL_BASELINES)[number], string>,
): string[] {
  const fingerprints = SUPPORTED_HISTORICAL_BASELINES.map((name) => values[name]);
  if (fingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("HISTORICAL_MIGRATION_FINGERPRINT_INVALID");
  }
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("HISTORICAL_MIGRATION_FINGERPRINT_DUPLICATE");
  }
  return fingerprints;
}

export function calculateHistoricalFingerprints(input: {
  baselineSource: string;
  migrationSources: Record<OptionalBaselineMigration, string>;
  expandFoundation(source: string): string;
  previousVeilFullFingerprint: string;
}): Record<HistoricalBaseline, string> {
  const calculated = Object.fromEntries(
    Object.entries(HISTORICAL_BASELINE_STAGES).map(([name, included]) => [
      name,
      digest(
        input.expandFoundation(
          expandReleasedBaselineStage(input.baselineSource, input.migrationSources, included),
        ),
      ),
    ]),
  ) as Omit<Record<HistoricalBaseline, string>, "previous_veil_full">;
  return {
    ...calculated,
    previous_veil_full: input.previousVeilFullFingerprint,
  };
}

// Released fingerprints preserve the replacement semantics used by those releases.
// Current baseline expansion uses callback replacement so SQL `$` tokens remain literal.
function expandReleasedBaselineStage(
  source: string,
  migrationSources: Record<OptionalBaselineMigration, string>,
  included: readonly OptionalBaselineMigration[],
): string {
  const admitted = new Set(included);
  return OPTIONAL_BASELINE_MIGRATIONS.reduce(
    (current, migration) =>
      current.replace(
        new RegExp(`\\\\ir\\s+${escape(migration)}(?:\\r?\\n|$)`, "g"),
        admitted.has(migration) ? migrationSources[migration] : "",
      ),
    source,
  );
}

export function assertReleasedFingerprintReconstruction(
  reconstructed: Record<HistoricalBaseline, string>,
): void {
  for (const name of SUPPORTED_HISTORICAL_BASELINES) {
    if (reconstructed[name] !== RELEASED_HISTORICAL_FINGERPRINTS[name]) {
      throw new Error(`RELEASED_MIGRATION_HISTORY_DRIFT:${name}`);
    }
  }
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function digest(source: string) {
  return createHash("sha256").update(source).digest("hex");
}
