import type {
  OperationalCausality,
  OperationalComponent,
  OperationalEvent,
  OperationalEventClassification,
  OperationalEventName,
} from "@scry/observability";

import type { AssuranceEvidenceRef } from "../core/types.js";
import type { RuntimeObservation } from "./runtime-observation.js";

export type ObservabilityFaultCaseId =
  | "invalid_mcp_input"
  | "invalid_api_input"
  | "authorization_mismatch"
  | "stale_exact_reference"
  | "browser_authority_loss"
  | "owned_request_timeout"
  | "response_observed_persistence_failure"
  | "database_failure"
  | "worker_loss_fencing"
  | "reconciliation_ambiguity"
  | "artifact_store_failure"
  | "report_finalization_failure"
  | "observability_sink_failure";

export type QualifiedMutationTruth = "not_applicable" | "not_applied" | "applied" | "unknown";
export type QualifiedRetrySemantics =
  | "not_applicable"
  | "safe_after_correction"
  | "safe_after_reobservation"
  | "requires_reconciliation"
  | "do_not_retry";

export interface ObservabilityProductTruth {
  mutation: QualifiedMutationTruth;
  orchestration: string;
  durableState: string;
  retry: QualifiedRetrySemantics;
}

export interface RequiredOperationalEvent {
  name: OperationalEventName;
  component: OperationalComponent;
  classification: OperationalEventClassification;
  reasonCode: string;
  outcome: OperationalEvent["outcome"];
  causalIdentifiers: readonly (keyof OperationalCausality)[];
  details?: Readonly<Record<string, unknown>>;
  durationRequired?: boolean;
  transition?: Readonly<{ from: string; to: string }>;
}

export type SafeDiagnosticAction =
  | "correct_request_before_resubmission"
  | "restore_authorization_before_resubmission"
  | "reobserve_and_obtain_a_fresh_exact_reference"
  | "restore_browser_authority_then_reobserve"
  | "inspect_owned_request_and_reconcile_before_retry"
  | "preserve_observed_response_and_reconcile_persistence"
  | "restore_database_then_resume_from_durable_state"
  | "respect_worker_fence_and_recover_from_durable_state"
  | "reconcile_external_effect_before_any_redispatch"
  | "restore_artifact_store_and_finalize_without_redispatch"
  | "inspect_report_blockers_and_retry_finalization_only"
  | "use_fallback_evidence_and_restore_the_durable_sink";

export interface ObservabilityFaultCase {
  id: ObservabilityFaultCaseId;
  title: string;
  injectedFault: string;
  expectedTruth: ObservabilityProductTruth;
  requiredEvents: readonly RequiredOperationalEvent[];
  forbiddenFieldNames: readonly string[];
  forbiddenValuePatterns: readonly RegExp[];
  safeAction: SafeDiagnosticAction;
  availabilityDeadlineMs: number;
  expectedEvidence: Readonly<{
    operational: string;
    productTruth: string;
    action: string;
    telemetryResilience: string;
  }>;
}

export type OperationalEvidenceChannel =
  "durable_store" | "stdout_fallback" | "cross_process_capture";

export interface ObservedOperationalEvent {
  event: OperationalEvent;
  availableAt: string;
  channel: OperationalEvidenceChannel;
  evidence: readonly AssuranceEvidenceRef[];
}

export interface ObservabilityFaultObservation {
  caseId: ObservabilityFaultCaseId;
  injectedAt: string;
  causalContext: Readonly<Partial<Record<keyof OperationalCausality, string>>>;
  productTruth?: Readonly<{
    value: ObservabilityProductTruth;
    evidence: readonly AssuranceEvidenceRef[];
  }>;
  operationalEvents: readonly ObservedOperationalEvent[];
  safeAction?: Readonly<{
    value: SafeDiagnosticAction;
    evidence: readonly AssuranceEvidenceRef[];
  }>;
  telemetryFailure?: Readonly<{
    injected: boolean;
    changedProductTruth: boolean;
    evidence: readonly AssuranceEvidenceRef[];
  }>;
}

export type ObservabilityQualificationDimension =
  | "detectionCoverage"
  | "causalSpecificity"
  | "correlationCompleteness"
  | "stateFidelity"
  | "timelinessAvailability"
  | "privacy"
  | "actionability"
  | "resilienceToTelemetryFailure";

export type ObservabilityQualificationStatus = "pass" | "fail" | "inconclusive";

export interface ObservabilityDimensionScore {
  status: ObservabilityQualificationStatus;
  points: 0 | 1;
  reasonCodes: readonly string[];
  evidence: readonly AssuranceEvidenceRef[];
}

export interface ObservabilityQualificationResult {
  caseId: ObservabilityFaultCaseId;
  status: ObservabilityQualificationStatus;
  points: number;
  maximumPoints: 8;
  evidenceAvailability: "available" | "partial" | "unavailable";
  scores: Readonly<Record<ObservabilityQualificationDimension, ObservabilityDimensionScore>>;
  evidence: readonly AssuranceEvidenceRef[];
}

const forbiddenFieldNames = [
  "authorization",
  "cookie",
  "credential",
  "password",
  "secret",
  "token",
  "request_body",
  "response_body",
  "protected_value",
  "raw_value",
  "dom",
  "browser_handle",
] as const;

const forbiddenValuePatterns = [
  /\bBearer\s+\S+/i,
  /\b(?:session|auth|access|refresh)[_-]?token\s*[=:]\s*\S+/i,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
] as const;

const expectedEvidence = {
  operational: "canonical sanitized operational event with a retained evidence reference",
  productTruth: "authoritative durable/product-state observation",
  action: "safe diagnostic or recovery action from the owning runtime/operator contract",
  telemetryResilience: "isolated sink-failure proof that product truth did not change",
} as const;

const lifecycleCausality = [
  "projectId",
  "missionId",
  "objectiveId",
  "agentSessionId",
  "runId",
  "attemptId",
  "operationId",
  "correlationId",
] as const;

const reportCausality = [
  "projectId",
  "missionId",
  "objectiveId",
  "agentSessionId",
  "runId",
  "attemptId",
  "correlationId",
] as const;

function defineFault(
  input: Omit<
    ObservabilityFaultCase,
    "forbiddenFieldNames" | "forbiddenValuePatterns" | "expectedEvidence"
  >,
): ObservabilityFaultCase {
  return { ...input, forbiddenFieldNames, forbiddenValuePatterns, expectedEvidence };
}

function requiredEvent(
  name: OperationalEventName,
  component: OperationalComponent,
  classification: OperationalEventClassification,
  reasonCode: string,
  outcome: OperationalEvent["outcome"],
  causalIdentifiers: readonly (keyof OperationalCausality)[],
  options: Pick<RequiredOperationalEvent, "details" | "durationRequired" | "transition"> = {},
): RequiredOperationalEvent {
  return { name, component, classification, reasonCode, outcome, causalIdentifiers, ...options };
}

/**
 * Provider-neutral operational fault contract consumed downstream by Assurance.
 * It describes required facts only; it does not admit, block, retry, or mutate runtime work.
 */
export const observabilityFaultMatrix: readonly ObservabilityFaultCase[] = [
  defineFault({
    id: "invalid_mcp_input",
    title: "Invalid MCP input",
    injectedFault: "MCP request fails canonical input validation before admission",
    expectedTruth: truth(
      "not_applicable",
      "request_refused",
      "no_runtime_work_admitted",
      "safe_after_correction",
    ),
    requiredEvents: [
      requiredEvent(
        "mcp.request_rejected",
        "mcp",
        "validation",
        "MCP_REQUEST_INVALID",
        "refused",
        ["mcpSessionId", "correlationId"],
        { details: { status: 400 } },
      ),
    ],
    safeAction: "correct_request_before_resubmission",
    availabilityDeadlineMs: 1_000,
  }),
  defineFault({
    id: "invalid_api_input",
    title: "Invalid API input",
    injectedFault: "API request fails canonical input validation before admission",
    expectedTruth: truth(
      "not_applicable",
      "request_refused",
      "no_runtime_work_admitted",
      "safe_after_correction",
    ),
    requiredEvents: [
      requiredEvent(
        "api.request_rejected",
        "api",
        "validation",
        "API_INPUT_VALIDATION_FAILED",
        "refused",
        ["correlationId"],
        { details: { status: 400 } },
      ),
    ],
    safeAction: "correct_request_before_resubmission",
    availabilityDeadlineMs: 1_000,
  }),
  defineFault({
    id: "authorization_mismatch",
    title: "Authorization mismatch",
    injectedFault: "Authenticated caller lacks the requested operation authority",
    expectedTruth: truth(
      "not_applied",
      "request_refused",
      "authorization_refusal_retained",
      "do_not_retry",
    ),
    requiredEvents: [
      requiredEvent(
        "api.request_rejected",
        "api",
        "policy_refusal",
        "MISSION_AUTHORIZATION_MISMATCH",
        "refused",
        ["correlationId"],
        { details: { status: 403 } },
      ),
    ],
    safeAction: "restore_authorization_before_resubmission",
    availabilityDeadlineMs: 1_000,
  }),
  defineFault({
    id: "stale_exact_reference",
    title: "Stale exact reference",
    injectedFault: "Pinned browser entity is replaced before dispatch",
    expectedTruth: truth(
      "not_applied",
      "awaiting_external_agent",
      "stale_reference_refusal_retained",
      "safe_after_reobservation",
    ),
    requiredEvents: [
      requiredEvent(
        "praxis.action_failed",
        "praxis",
        "stale_authority",
        "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
        "failed",
        lifecycleCausality,
        {
          details: { mutationOutcome: "not_applied", retry: "requires_reobservation" },
          durationRequired: true,
        },
      ),
    ],
    safeAction: "reobserve_and_obtain_a_fresh_exact_reference",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "browser_authority_loss",
    title: "Browser crash or authority loss",
    injectedFault: "Browser context is lost after the operation is owned",
    expectedTruth: truth(
      "unknown",
      "reconciliation_required",
      "browser_authority_loss_retained",
      "requires_reconciliation",
    ),
    requiredEvents: [
      requiredEvent(
        "praxis.action_failed",
        "praxis",
        "infrastructure",
        "BROWSER_AUTHORITY_LOST",
        "inconclusive",
        lifecycleCausality,
        { details: { mutationOutcome: "unknown", retry: "unsafe" }, durationRequired: true },
      ),
    ],
    safeAction: "restore_browser_authority_then_reobserve",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "owned_request_timeout",
    title: "Owned-request timeout",
    injectedFault: "Owned external request exceeds its response-settlement deadline",
    expectedTruth: truth(
      "unknown",
      "reconciliation_required",
      "owned_request_timeout_retained",
      "requires_reconciliation",
    ),
    requiredEvents: [
      requiredEvent(
        "protected_operation.reconciliation_required",
        "runtime",
        "reconciliation_unknown",
        "PROTECTED_RESPONSE_SETTLEMENT_TIMEOUT",
        "reconciliation_required",
        [...lifecycleCausality, "protectedOperationId"],
        {
          details: { mutationOutcome: "unknown", retryClass: "retry_requires_reconciliation" },
        },
      ),
    ],
    safeAction: "inspect_owned_request_and_reconcile_before_retry",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "response_observed_persistence_failure",
    title: "Response observed and persistence fails",
    injectedFault: "Owned response is observed but atomic protected-output persistence fails",
    expectedTruth: truth(
      "unknown",
      "reconciliation_required",
      "response_observation_retained_without_fabricated_persistence",
      "requires_reconciliation",
    ),
    requiredEvents: [
      requiredEvent(
        "protected_operation.reconciliation_required",
        "runtime",
        "reconciliation_unknown",
        "ATOMIC_OUTPUT_PERSISTENCE_FAILED",
        "reconciliation_required",
        [...lifecycleCausality, "protectedOperationId"],
        { details: { mutationOutcome: "unknown", failurePhase: "persistence" } },
      ),
    ],
    safeAction: "preserve_observed_response_and_reconcile_persistence",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "database_failure",
    title: "Database failure",
    injectedFault: "Product persistence fails at a database-owned boundary",
    expectedTruth: truth(
      "not_applicable",
      "failed",
      "last_committed_state_preserved",
      "safe_after_correction",
    ),
    requiredEvents: [
      requiredEvent(
        "persistence.write_failed",
        "runtime",
        "persistence",
        "DATABASE_WRITE_FAILED",
        "failed",
        reportCausality,
        { details: { boundary: "execution_report_commit" }, durationRequired: true },
      ),
    ],
    safeAction: "restore_database_then_resume_from_durable_state",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "worker_loss_fencing",
    title: "Worker loss and fencing",
    injectedFault: "Worker loses its durable claim while execution is in flight",
    expectedTruth: truth(
      "unknown",
      "recovery_required",
      "stale_worker_fenced",
      "requires_reconciliation",
    ),
    requiredEvents: [
      requiredEvent(
        "worker.execution_failed",
        "worker",
        "stale_authority",
        "WORKER_CLAIM_FENCED",
        "failed",
        reportCausality,
        {
          details: { finalAttempt: false },
          durationRequired: true,
          transition: { from: "running", to: "failed" },
        },
      ),
    ],
    safeAction: "respect_worker_fence_and_recover_from_durable_state",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "reconciliation_ambiguity",
    title: "Reconciliation ambiguity",
    injectedFault: "Observations cannot authoritatively prove the external mutation outcome",
    expectedTruth: truth(
      "unknown",
      "reconciliation_required",
      "unknown_mutation_truth_preserved",
      "requires_reconciliation",
    ),
    requiredEvents: [
      requiredEvent(
        "protected_operation.reconciliation_required",
        "runtime",
        "reconciliation_unknown",
        "MUTATION_RECONCILIATION_REQUIRED",
        "reconciliation_required",
        [...lifecycleCausality, "protectedOperationId"],
        { details: { mutationOutcome: "unknown", reconciliation: "unknown" } },
      ),
    ],
    safeAction: "reconcile_external_effect_before_any_redispatch",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "artifact_store_failure",
    title: "Artifact-store failure",
    injectedFault: "Artifact bytes cannot be retained during report commit",
    expectedTruth: truth(
      "applied",
      "report_blocked",
      "artifact_unavailable_and_report_not_finalized",
      "do_not_retry",
    ),
    requiredEvents: reportFailureEvents("ARTIFACT_STORE_WRITE_FAILED"),
    safeAction: "restore_artifact_store_and_finalize_without_redispatch",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "report_finalization_failure",
    title: "Report-finalization failure",
    injectedFault: "Final report transaction fails after runtime execution has completed",
    expectedTruth: truth("applied", "report_blocked", "report_not_finalized", "do_not_retry"),
    requiredEvents: reportFailureEvents("REPORT_FINALIZATION_FAILED"),
    safeAction: "inspect_report_blockers_and_retry_finalization_only",
    availabilityDeadlineMs: 2_000,
  }),
  defineFault({
    id: "observability_sink_failure",
    title: "Observability sink failure",
    injectedFault: "Durable operational-event sink rejects while stdout fallback remains available",
    expectedTruth: truth(
      "not_applicable",
      "request_refused",
      "product_response_unchanged_by_telemetry_failure",
      "safe_after_correction",
    ),
    requiredEvents: [
      requiredEvent(
        "api.request_rejected",
        "api",
        "validation",
        "API_INPUT_VALIDATION_FAILED",
        "refused",
        ["correlationId"],
        { details: { status: 400 } },
      ),
    ],
    safeAction: "use_fallback_evidence_and_restore_the_durable_sink",
    availabilityDeadlineMs: 1_000,
  }),
] as const;

function truth(
  mutation: QualifiedMutationTruth,
  orchestration: string,
  durableState: string,
  retry: QualifiedRetrySemantics,
): ObservabilityProductTruth {
  return { mutation, orchestration, durableState, retry };
}

function reportFailureEvents(reasonCode: string): readonly RequiredOperationalEvent[] {
  return [
    requiredEvent(
      "report.finalization_failed",
      "runtime",
      "persistence",
      reasonCode,
      "failed",
      reportCausality,
      {
        details: { reportState: "passed" },
        durationRequired: true,
        transition: { from: "finalizing", to: "failed" },
      },
    ),
    requiredEvent(
      "persistence.write_failed",
      "runtime",
      "persistence",
      reasonCode,
      "failed",
      reportCausality,
      { details: { boundary: "execution_report_commit" }, durationRequired: true },
    ),
  ];
}

export function qualifyObservabilityFault(
  scenario: ObservabilityFaultCase,
  observation: ObservabilityFaultObservation,
): ObservabilityQualificationResult {
  if (scenario.id !== observation.caseId) {
    return allInconclusive(observation.caseId, "OBSERVABILITY_CASE_ID_MISMATCH");
  }

  const matches = scenario.requiredEvents.map((required) => ({
    required,
    detected: observation.operationalEvents.filter(
      ({ event }) => event.name === required.name && event.component === required.component,
    ),
    exact: observation.operationalEvents.filter(({ event }) =>
      eventMatchesRequirement(event, required),
    ),
  }));
  const detectedEvidence = matches.flatMap(({ detected }) =>
    detected.flatMap(({ evidence }) => evidence),
  );
  const exactEvidence = matches.flatMap(({ exact }) => exact.flatMap(({ evidence }) => evidence));

  const scores: Record<ObservabilityQualificationDimension, ObservabilityDimensionScore> = {
    detectionCoverage: score(
      matches.every(({ detected }) => detected.length > 0),
      matches.some(({ detected }) => detected.length === 0)
        ? "REQUIRED_OPERATIONAL_EVENT_MISSING"
        : "OPERATIONAL_EVIDENCE_REFERENCE_MISSING",
      detectedEvidence,
      detectedEvidence.length === 0 ? "inconclusive" : "fail",
    ),
    causalSpecificity: score(
      matches.every(({ exact }) => exact.length > 0),
      "OPERATIONAL_CAUSE_NOT_EXACT",
      exactEvidence,
      matches.every(({ detected }) => detected.length === 0) ? "inconclusive" : "fail",
    ),
    correlationCompleteness: correlationScore(matches, observation.causalContext),
    stateFidelity: productTruthScore(scenario, observation),
    timelinessAvailability: availabilityScore(scenario, observation, matches),
    privacy: privacyScore(scenario, observation.operationalEvents),
    actionability: actionabilityScore(scenario, observation),
    resilienceToTelemetryFailure: resilienceScore(observation),
  };
  const values = Object.values(scores);
  const evidence = dedupeEvidence(values.flatMap(({ evidence: refs }) => refs));

  return {
    caseId: scenario.id,
    status: aggregate(values.map(({ status }) => status)),
    points: values.reduce((total, item) => total + item.points, 0),
    maximumPoints: 8,
    evidenceAvailability:
      evidence.length === 0
        ? "unavailable"
        : values.every(({ evidence: refs }) => refs.length > 0)
          ? "available"
          : "partial",
    scores,
    evidence,
  };
}

export function observabilityQualificationToRuntimeObservation(
  scenario: ObservabilityFaultCase,
  result: ObservabilityQualificationResult,
): RuntimeObservation {
  const firstFailure = Object.entries(result.scores).find(([, value]) => value.status !== "pass");
  return {
    id: `observability-qualification:${scenario.id}`,
    capability: "causal-observability",
    outcome:
      result.status === "pass" ? "succeeded" : result.status === "fail" ? "failed" : "inconclusive",
    evidence: result.evidence,
    environment: {
      frameworkBehavior: "canonical-operational-event-contract",
      failureRecoveryClass: scenario.id,
    },
    metrics: Object.entries(result.scores).map(([name, value]) => ({
      name: `observability_${name}`,
      value: value.points,
      unit: "binary",
    })),
    ...(firstFailure
      ? { failureClass: `${firstFailure[0]}:${firstFailure[1].reasonCodes[0]}` }
      : {}),
    summary: `${result.points}/${result.maximumPoints} observability qualification dimensions passed`,
  };
}

function eventMatchesRequirement(event: OperationalEvent, required: RequiredOperationalEvent) {
  return (
    event.name === required.name &&
    event.component === required.component &&
    event.classification === required.classification &&
    event.reasonCode === required.reasonCode &&
    event.outcome === required.outcome &&
    (!required.durationRequired || event.durationMs !== undefined) &&
    (!required.transition || equal(event.transition, required.transition)) &&
    (!required.details || contains(event.details ?? {}, required.details))
  );
}

function correlationScore(
  matches: readonly {
    required: RequiredOperationalEvent;
    exact: readonly ObservedOperationalEvent[];
  }[],
  context: ObservabilityFaultObservation["causalContext"],
): ObservabilityDimensionScore {
  const evidence = matches.flatMap(({ exact }) => exact.flatMap(({ evidence: refs }) => refs));
  if (matches.some(({ exact }) => exact.length === 0))
    return score(false, "CAUSAL_EVENT_UNAVAILABLE", evidence, "inconclusive");
  for (const { required, exact } of matches) {
    for (const key of required.causalIdentifiers) {
      const expected = context[key];
      if (!expected)
        return score(false, "CAUSAL_CONTEXT_EXPECTATION_MISSING", evidence, "inconclusive");
      if (exact.some(({ event }) => event.causality[key] !== expected))
        return score(false, "CAUSAL_IDENTIFIER_MISSING_OR_MISMATCHED", evidence);
    }
  }
  return score(true, undefined, evidence, "inconclusive");
}

function productTruthScore(
  scenario: ObservabilityFaultCase,
  observation: ObservabilityFaultObservation,
): ObservabilityDimensionScore {
  if (!observation.productTruth)
    return score(false, "PRODUCT_TRUTH_EVIDENCE_UNAVAILABLE", [], "inconclusive");
  if (observation.productTruth.evidence.length === 0)
    return score(false, "PRODUCT_TRUTH_EVIDENCE_REFERENCE_MISSING", [], "inconclusive");
  if (!equal(observation.productTruth.value, scenario.expectedTruth))
    return score(false, "PRODUCT_TRUTH_MISMATCH", observation.productTruth.evidence);
  if (
    observation.productTruth.value.mutation === "unknown" &&
    !["requires_reconciliation", "do_not_retry"].includes(observation.productTruth.value.retry)
  )
    return score(false, "UNKNOWN_MUTATION_RETRY_UNSAFE", observation.productTruth.evidence);
  return score(true, undefined, observation.productTruth.evidence);
}

function availabilityScore(
  scenario: ObservabilityFaultCase,
  observation: ObservabilityFaultObservation,
  matches: readonly { exact: readonly ObservedOperationalEvent[] }[],
): ObservabilityDimensionScore {
  const evidence = matches.flatMap(({ exact }) => exact.flatMap(({ evidence: refs }) => refs));
  if (matches.some(({ exact }) => exact.length === 0))
    return score(false, "REQUIRED_EVIDENCE_UNAVAILABLE", evidence);
  if (evidence.length === 0)
    return score(false, "EVIDENCE_REFERENCE_UNAVAILABLE", evidence, "inconclusive");
  const injectedAt = Date.parse(observation.injectedAt);
  if (!Number.isFinite(injectedAt))
    return score(false, "INJECTION_TIME_INVALID", evidence, "inconclusive");
  for (const { exact } of matches) {
    if (
      !exact.some(({ availableAt }) => {
        const available = Date.parse(availableAt);
        return (
          Number.isFinite(available) &&
          available >= injectedAt &&
          available - injectedAt <= scenario.availabilityDeadlineMs
        );
      })
    )
      return score(false, "EVIDENCE_AVAILABILITY_DEADLINE_MISSED", evidence);
  }
  return score(true, undefined, evidence);
}

function privacyScore(
  scenario: ObservabilityFaultCase,
  events: readonly ObservedOperationalEvent[],
): ObservabilityDimensionScore {
  const evidence = events.flatMap(({ evidence: refs }) => refs);
  if (events.length === 0 || evidence.length === 0)
    return score(false, "PRIVACY_EVIDENCE_UNAVAILABLE", evidence, "inconclusive");
  const finding = events
    .map(({ event }) => privacyFinding(event, scenario))
    .find((value): value is string => Boolean(value));
  return score(!finding, finding ?? undefined, evidence);
}

function actionabilityScore(
  scenario: ObservabilityFaultCase,
  observation: ObservabilityFaultObservation,
): ObservabilityDimensionScore {
  if (!observation.safeAction) return score(false, "SAFE_ACTION_UNAVAILABLE", [], "inconclusive");
  if (observation.safeAction.evidence.length === 0)
    return score(false, "SAFE_ACTION_EVIDENCE_REFERENCE_MISSING", [], "inconclusive");
  return score(
    observation.safeAction.value === scenario.safeAction,
    "SAFE_ACTION_MISMATCH",
    observation.safeAction.evidence,
  );
}

function resilienceScore(observation: ObservabilityFaultObservation): ObservabilityDimensionScore {
  if (!observation.telemetryFailure?.injected)
    return score(false, "TELEMETRY_FAILURE_PROBE_UNAVAILABLE", [], "inconclusive");
  if (observation.telemetryFailure.evidence.length === 0)
    return score(false, "TELEMETRY_FAILURE_EVIDENCE_REFERENCE_MISSING", [], "inconclusive");
  return score(
    !observation.telemetryFailure.changedProductTruth,
    "TELEMETRY_FAILURE_CHANGED_PRODUCT_TRUTH",
    observation.telemetryFailure.evidence,
  );
}

function privacyFinding(value: unknown, scenario: ObservabilityFaultCase): string | undefined {
  if (typeof value === "string")
    return scenario.forbiddenValuePatterns.some((pattern) => pattern.test(value))
      ? "FORBIDDEN_SENSITIVE_VALUE_PRESENT"
      : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const finding = privacyFinding(item, scenario);
      if (finding) return finding;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (scenario.forbiddenFieldNames.includes(normalized))
      return "FORBIDDEN_SENSITIVE_FIELD_PRESENT";
    const finding = privacyFinding(item, scenario);
    if (finding) return finding;
  }
  return undefined;
}

function score(
  passed: boolean,
  failureReason: string | undefined,
  evidence: readonly AssuranceEvidenceRef[],
  failureStatus: "fail" | "inconclusive" = "fail",
): ObservabilityDimensionScore {
  return passed
    ? { status: "pass", points: 1, reasonCodes: [], evidence: dedupeEvidence(evidence) }
    : {
        status: failureStatus,
        points: 0,
        reasonCodes: [failureReason ?? "OBSERVABILITY_QUALIFICATION_FAILED"],
        evidence: dedupeEvidence(evidence),
      };
}

function aggregate(statuses: readonly ObservabilityQualificationStatus[]) {
  if (statuses.includes("fail")) return "fail" as const;
  if (statuses.every((status) => status === "pass")) return "pass" as const;
  return "inconclusive" as const;
}

function allInconclusive(
  caseId: ObservabilityFaultCaseId,
  reasonCode: string,
): ObservabilityQualificationResult {
  const dimensions: ObservabilityQualificationDimension[] = [
    "detectionCoverage",
    "causalSpecificity",
    "correlationCompleteness",
    "stateFidelity",
    "timelinessAvailability",
    "privacy",
    "actionability",
    "resilienceToTelemetryFailure",
  ];
  const value = score(false, reasonCode, [], "inconclusive");
  return {
    caseId,
    status: "inconclusive",
    points: 0,
    maximumPoints: 8,
    evidenceAvailability: "unavailable",
    scores: Object.fromEntries(dimensions.map((dimension) => [dimension, value])) as Record<
      ObservabilityQualificationDimension,
      ObservabilityDimensionScore
    >,
    evidence: [],
  };
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return equal(actual, expected);
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      contains((actual as Record<string, unknown>)[key], value),
    );
  }
  return Object.is(actual, expected);
}

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dedupeEvidence(input: readonly AssuranceEvidenceRef[]) {
  return [
    ...new Map(input.map((item) => [`${item.source}:${item.kind}:${item.ref}`, item])).values(),
  ];
}
