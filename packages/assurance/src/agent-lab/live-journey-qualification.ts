import type { AssuranceEvidenceRef } from "../core/types.js";
import type { AgentLabRunResult } from "./types.js";

export type LiveJourneyDimensionStatus = "pass" | "fail" | "inconclusive";
export type LiveJourneyDimension = Readonly<{
  status: LiveJourneyDimensionStatus;
  reasonCodes: readonly string[];
}>;

export type AgentLabLiveJourneyObservation = Readonly<{
  result: AgentLabRunResult;
  semanticOwnership?: "external_agent";
  lifecycle?: Readonly<{
    missionStatus: string;
    objectiveStatus: string;
    runStatus: string;
    praxisStatus: string;
    agentSessionStatus: string;
  }>;
  causalJoinability?: Readonly<{
    publicMcpToApi: boolean;
    runtimeToDurableStore: boolean;
    projectDashboardVisible: boolean;
  }>;
  privacy?: Readonly<{ protectedValueExposed: boolean; evidenceSanitized: boolean }>;
  finalization?: Readonly<{ evidenceAvailable: boolean; reportFinalized: boolean }>;
  telemetryResilience?: Readonly<{ productTruthChangedBySinkFailure: boolean }>;
  evidence: readonly AssuranceEvidenceRef[];
}>;

export type AgentLabLiveJourneyQualification = Readonly<{
  kind: "full_live_journey";
  status: "PASS" | "FAIL" | "PARTIAL";
  cohort: string;
  failures: readonly string[];
  unavailable: readonly string[];
  dimensions: Readonly<
    Record<
      | "completion"
      | "callQuality"
      | "provenance"
      | "runtimeIdentity"
      | "semanticOwnership"
      | "lifecycleSettlement"
      | "causalJoinability"
      | "privacy"
      | "evidenceFinalization"
      | "latencyTimeliness"
      | "telemetryResilience",
      LiveJourneyDimension
    >
  >;
  evidence: readonly AssuranceEvidenceRef[];
  result: AgentLabRunResult;
}>;

/** Qualifies one arbitrary journey without projecting fixed-matrix scenarios onto it. */
export function evaluateAgentLabLiveJourney(input: {
  cohort: string;
  observation: AgentLabLiveJourneyObservation;
}): AgentLabLiveJourneyQualification {
  const observation = input.observation;
  const result = observation.result;
  const dimensions = {
    completion:
      result.status === "completed" && result.completed ? pass() : fail("LIVE_JOURNEY_INCOMPLETE"),
    callQuality:
      result.invalid_calls ||
      result.stale_reference_calls ||
      result.repeated_unchanged_observations ||
      result.unnecessary_capabilities_calls
        ? fail(
            ...(result.invalid_calls ? [`INVALID_CALLS_${result.invalid_calls}`] : []),
            ...(result.stale_reference_calls
              ? [`STALE_REFERENCE_CALLS_${result.stale_reference_calls}`]
              : []),
            ...(result.repeated_unchanged_observations
              ? [`REPEATED_OBSERVATIONS_${result.repeated_unchanged_observations}`]
              : []),
            ...(result.unnecessary_capabilities_calls
              ? [`UNNECESSARY_CAPABILITY_CALLS_${result.unnecessary_capabilities_calls}`]
              : []),
          )
        : pass(),
    provenance:
      result.provider && result.model && result.external_run_id
        ? pass()
        : fail("EXTERNAL_AGENT_PROVENANCE_INCOMPLETE"),
    runtimeIdentity: result.runtime_identity
      ? pass()
      : inconclusive("RUNTIME_IDENTITY_UNAVAILABLE"),
    semanticOwnership:
      observation.semanticOwnership === "external_agent"
        ? pass()
        : inconclusive("SEMANTIC_OWNERSHIP_EVIDENCE_UNAVAILABLE"),
    lifecycleSettlement: qualifyLifecycle(observation.lifecycle),
    causalJoinability: qualifyBooleans(
      observation.causalJoinability,
      "CAUSAL_JOINABILITY_EVIDENCE_UNAVAILABLE",
      "CAUSAL_CHAIN_INCOMPLETE",
    ),
    privacy: observation.privacy
      ? !observation.privacy.protectedValueExposed && observation.privacy.evidenceSanitized
        ? pass()
        : fail("LIVE_JOURNEY_PRIVACY_FAILED")
      : inconclusive("PRIVACY_EVIDENCE_UNAVAILABLE"),
    evidenceFinalization: observation.finalization
      ? observation.finalization.evidenceAvailable && observation.finalization.reportFinalized
        ? pass()
        : fail("EVIDENCE_OR_REPORT_FINALIZATION_FAILED")
      : inconclusive("FINALIZATION_EVIDENCE_UNAVAILABLE"),
    latencyTimeliness:
      result.latency &&
      finiteMetric(result.latency.totalJourneyMs) &&
      finiteMetric(result.latency.modelInferenceMs) &&
      finiteMetric(result.latency.mcpExecutionMs)
        ? pass()
        : inconclusive("LATENCY_EVIDENCE_UNAVAILABLE"),
    telemetryResilience: observation.telemetryResilience
      ? observation.telemetryResilience.productTruthChangedBySinkFailure
        ? fail("TELEMETRY_FAILURE_CHANGED_PRODUCT_TRUTH")
        : pass()
      : inconclusive("TELEMETRY_RESILIENCE_EVIDENCE_UNAVAILABLE"),
  } as const;

  const failures = Object.entries(dimensions).flatMap(([dimension, score]) =>
    score.status === "fail" ? score.reasonCodes.map((code) => `${dimension}:${code}`) : [],
  );
  const unavailable = Object.entries(dimensions).flatMap(([dimension, score]) =>
    score.status === "inconclusive" ? score.reasonCodes.map((code) => `${dimension}:${code}`) : [],
  );
  if (!observation.evidence.length)
    unavailable.push("evidence:RETAINED_JOURNEY_EVIDENCE_UNAVAILABLE");
  return {
    kind: "full_live_journey",
    status: failures.length ? "FAIL" : unavailable.length ? "PARTIAL" : "PASS",
    cohort: input.cohort,
    failures,
    unavailable,
    dimensions,
    evidence: observation.evidence,
    result,
  };
}

function qualifyLifecycle(
  value: AgentLabLiveJourneyObservation["lifecycle"],
): LiveJourneyDimension {
  if (!value) return inconclusive("DURABLE_LIFECYCLE_UNAVAILABLE");
  const settled =
    ["completed", "blocked", "failed", "cancelled"].includes(value.missionStatus) &&
    ["passed", "failed", "blocked", "skipped"].includes(value.objectiveStatus) &&
    ["passed", "failed", "cancelled", "timed_out", "infrastructure_error"].includes(
      value.runStatus,
    ) &&
    ["completed", "failed", "cancelled", "recovery_required"].includes(value.praxisStatus) &&
    ["completed", "interrupted", "failed"].includes(value.agentSessionStatus);
  return settled ? pass() : fail("OWNED_LIFECYCLE_NOT_SETTLED");
}

function qualifyBooleans(
  value: Readonly<Record<string, boolean>> | undefined,
  missing: string,
  failed: string,
) {
  if (!value) return inconclusive(missing);
  return Object.values(value).every(Boolean) ? pass() : fail(failed);
}

function finiteMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function pass(): LiveJourneyDimension {
  return { status: "pass", reasonCodes: [] };
}
function fail(...reasonCodes: string[]): LiveJourneyDimension {
  return { status: "fail", reasonCodes };
}
function inconclusive(...reasonCodes: string[]): LiveJourneyDimension {
  return { status: "inconclusive", reasonCodes };
}
