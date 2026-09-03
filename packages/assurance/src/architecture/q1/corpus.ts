import { applyReferenceAction, createReferenceState } from "./state.js";
import type { Q1Action, Q1Sequence, Q1Snapshot } from "./types.js";

export type Q1CorpusCase = Q1Sequence & Readonly<{ expectedViolationIds: readonly string[] }>;

const sequence = (
  id: string,
  seed: number,
  actions: readonly Q1Action[],
  expectedViolationIds: readonly string[] = [],
): Q1CorpusCase => ({
  id,
  seed,
  initialState: createReferenceState(),
  actions,
  expectedViolationIds,
});

export const q1SeedCorpus: readonly Q1CorpusCase[] = [
  sequence("happy-legal-lifecycle", 101, [
    { type: "crossDispatch" },
    { type: "establishMutation", truth: "applied", authoritative: true },
    { type: "recordFunctionalResult", truth: "succeeded" },
    { type: "settlePrivacy", state: "sealed" },
    { type: "settleEvidence", state: "available", required: true },
    { type: "setPersistence", state: "committed" },
    { type: "finalizeRun", state: "passed" },
    { type: "acceptObjectiveEvidence" },
    { type: "concludeObjective", state: "passed" },
    { type: "finalizeMission" },
  ]),
  sequence("pre-dispatch-refusal", 102, [
    { type: "establishMutation", truth: "not_applied", authoritative: true },
    { type: "recordFunctionalResult", truth: "failed" },
  ]),
  sequence("post-dispatch-unknown", 103, [
    { type: "crossDispatch" },
    { type: "establishMutation", truth: "unknown" },
  ]),
  sequence("applied-evidence-failure-mixed-truth", 104, [
    { type: "crossDispatch" },
    { type: "establishMutation", truth: "applied", authoritative: true },
    { type: "recordFunctionalResult", truth: "succeeded" },
    { type: "settleEvidence", state: "failed", required: true },
  ]),
  sequence("not-applied-healthy-runtime", 105, [
    { type: "establishMutation", truth: "not_applied", authoritative: true },
    { type: "setRuntime", state: "healthy" },
  ]),
  sequence("runtime-loss-requires-owner-convergence", 106, [{ type: "loseRuntimeLease" }], ["L04"]),
  sequence(
    "stale-fence-settlement",
    107,
    [
      { type: "establishMutation", truth: "unknown" },
      { type: "beginReconciliation", ownerCurrent: false },
      { type: "reconcileMutation", truth: "applied", authoritative: true },
    ],
    ["L05"],
  ),
  sequence(
    "stale-authority",
    108,
    [{ type: "replaceDocument" }, { type: "useReference" }],
    ["A01"],
  ),
  sequence("protected-operation", 109, [
    { type: "setProtectedProjection", canonical: "applied", projection: "applied" },
  ]),
  sequence("reconciliation", 110, [
    { type: "crossDispatch" },
    { type: "establishMutation", truth: "unknown" },
    { type: "beginReconciliation", ownerCurrent: true },
    { type: "reconcileMutation", truth: "applied", authoritative: true },
  ]),
  sequence("run-finalization", 111, [
    { type: "settleEvidence", state: "available", required: true },
    { type: "finalizeRun", state: "passed" },
  ]),
  sequence("objective-acceptance-mission-completion", 112, [
    { type: "settleEvidence", state: "available", required: true },
    { type: "finalizeRun", state: "passed" },
    { type: "acceptObjectiveEvidence" },
    { type: "concludeObjective", state: "passed" },
    { type: "finalizeMission" },
  ]),
];

export const q1MandatoryNegativeControls: readonly Q1CorpusCase[] = [
  sequence(
    "negative-applied-regression",
    201,
    [
      { type: "establishMutation", truth: "applied", authoritative: true },
      { type: "establishMutation", truth: "unknown" },
    ],
    ["M02"],
  ),
  sequence(
    "negative-unknown-silently-cleared",
    202,
    [
      { type: "establishMutation", truth: "unknown" },
      { type: "reconcileMutation", truth: "not_applied", authoritative: false },
    ],
    ["M01"],
  ),
  sequence(
    "negative-second-dispatch",
    203,
    [{ type: "crossDispatch" }, { type: "crossDispatch" }],
    ["M05"],
  ),
  sequence(
    "negative-required-evidence-ignored",
    204,
    [
      { type: "settleEvidence", state: "failed", required: true },
      { type: "finalizeRun", state: "passed" },
    ],
    ["P04"],
  ),
  sequence(
    "negative-persistence-infers-runtime-death",
    205,
    [{ type: "testOnlyPersistenceFailureInfersRuntimeDeath" }],
    ["T03"],
  ),
  sequence(
    "negative-stale-document-ref",
    206,
    [{ type: "replaceDocument" }, { type: "useReference" }],
    ["A01"],
  ),
  sequence(
    "negative-objective-without-evidence",
    207,
    [{ type: "concludeObjective", state: "passed" }],
    ["L07"],
  ),
  sequence(
    "negative-stale-fenced-owner-settles",
    208,
    [
      { type: "establishMutation", truth: "unknown" },
      { type: "beginReconciliation", ownerCurrent: false },
      { type: "reconcileMutation", truth: "applied", authoritative: true },
    ],
    ["L05"],
  ),
  sequence(
    "negative-protected-projection-disagrees",
    209,
    [{ type: "setProtectedProjection", canonical: "applied", projection: "unknown" }],
    ["T01"],
  ),
  sequence(
    "negative-self-oracle",
    210,
    [{ type: "testOnlyCorrupt", path: "qualification.oracleAuthority", value: "scry" }],
    ["Q03"],
  ),
];

export function negativeEvaluationCase(invariantId: string): {
  before: Q1Snapshot;
  action: Q1Action;
  after: Q1Snapshot;
} {
  const before = createReferenceState();
  const after = structuredClone(before) as any;
  let action: Q1Action = {
    type: "testOnlyCorrupt",
    path: "truth.causalEnvelopeRetained",
    value: false,
  };
  const set = (path: string, value: unknown) => {
    const [owner, field] = path.split(".");
    after[owner!][field!] = value;
  };
  switch (invariantId) {
    case "M01":
      set("operation.originalMutationTruth", "unknown");
      set("operation.mutationTruth", "not_applied");
      set("operation.reconciliationAuthoritative", false);
      break;
    case "M02":
      set("operation.mutationHistory", ["not_attempted", "applied", "unknown"]);
      set("operation.mutationTruth", "unknown");
      break;
    case "M03":
      set("operation.originalMutationTruth", "not_applied");
      set("operation.mutationTruth", "applied");
      break;
    case "M04":
      set("operation.dispatchPossible", true);
      set("operation.freshReplayAuthorized", true);
      break;
    case "M05":
      set("operation.dispatchCount", 2);
      break;
    case "M06":
      set("operation.dispatchPossible", true);
      set("operation.failureClassifiedNotApplied", true);
      break;
    case "M07":
      set("operation.kind", "read_only");
      set("operation.mutationTruth", "unknown");
      break;
    case "M08":
      set("operation.reconciliationInvokedMutation", true);
      break;
    case "M09":
      set("operation.providerIdempotencyIdentity", "provider-changed");
      action = {
        type: "testOnlyCorrupt",
        path: "operation.providerIdempotencyIdentity",
        value: "provider-changed",
      };
      break;
    case "M10":
      set("operation.originalMutationTruth", "unknown");
      set("operation.reconciliationProvenanceRetained", false);
      break;
    case "T01":
      set("operation.kind", "protected_mutation");
      set("operation.protectedTruth", "applied");
      set("operation.adaptiveProjectionTruth", "unknown");
      break;
    case "T02":
      set("truth.evidence", "failed");
      set("operation.mutationTruth", "not_applied");
      action = { type: "settleEvidence", state: "failed", required: true };
      break;
    case "T03":
      set("truth.persistence", "failed");
      set("truth.runtime", "unavailable");
      action = { type: "testOnlyPersistenceFailureInfersRuntimeDeath" };
      break;
    case "T04":
      set("truth.runtime", "recovery_required");
      set("operation.functionalTruth", "failed");
      action = { type: "loseRuntimeLease" };
      break;
    case "T05":
      set("operation.functionalTruth", "succeeded");
      set("operation.mutationTruth", "unknown");
      set("run.state", "passed");
      break;
    case "T06":
      set("truth.qualityFinding", true);
      set("operation.functionalTruth", "failed");
      break;
    case "T07":
      set("truth.telemetry", "failed");
      set("operation.functionalTruth", "failed");
      break;
    case "T08":
      set("truth.causalEnvelopeRetained", false);
      break;
    case "L01":
      set("run.state", "passed");
      set("run.attemptStates", ["running"]);
      break;
    case "L02":
      set("run.identityStable", false);
      break;
    case "L03":
      set("agent.leaseValid", false);
      set("agent.cleanupDeadlineExceeded", true);
      break;
    case "L04":
      set("praxis.liveRuntimeOwners", 2);
      break;
    case "L05":
      set("operation.reconciliationOwnerCurrent", false);
      set("operation.mutationTruth", "applied");
      break;
    case "L06":
      set("operation.terminal", true);
      set("run.operationMutable", true);
      break;
    case "L07":
      set("objective.state", "passed");
      set("objective.acceptedEvidence", false);
      break;
    case "L08":
      set("mission.state", "completed");
      set("mission.requiredObjectivesTerminal", false);
      break;
    case "L09":
      set("praxis.state", "completed");
      set("praxis.terminalConverged", false);
      break;
    case "L10":
      set("run.attemptHistoryPreserved", false);
      break;
    case "A01":
      set("authority.refUsedForDispatch", true);
      set("authority.refSessionMatches", false);
      break;
    case "A02":
      set("authority.currentDocumentEpoch", 2);
      set("authority.refRuntimeElementCurrent", true);
      break;
    case "A03":
      set("authority.semanticReplacementAccepted", true);
      break;
    case "A04":
      set("authority.requestMetadataUsedAsDocumentAuthority", true);
      break;
    case "A05":
      set("authority.protectedAuthorizationMatchesScope", false);
      break;
    case "A06":
      set("authority.externalIdentityAuthoritative", false);
      break;
    case "A07":
      set("authority.checkpointRestored", true);
      set("authority.checkpointCreatedNewEpoch", false);
      set("authority.oldRefRevived", true);
      break;
    case "P01":
      set("privacy.publicOutputsContainProtectedValue", true);
      break;
    case "P02":
      set("privacy.protectedIntervalOpen", true);
      set("privacy.captureOccurred", true);
      break;
    case "P03":
      set("privacy.cleanupUsedAsPrivacyProof", true);
      break;
    case "P04":
      set("truth.evidence", "failed");
      set("run.state", "passed");
      break;
    case "P05":
      set("truth.evidence", "suppressed");
      set("truth.evidenceRequired", false);
      set("run.resultClassification", "evidence_failure");
      break;
    case "P06":
      set("privacy.artifactAvailable", true);
      break;
    case "P07":
      set("truth.evidenceChannelCount", 2);
      break;
    case "R01":
      set("recovery.blockerProjectId", "unrelated-project");
      set("recovery.blockerResourceRelated", false);
      break;
    case "R02":
      set("recovery.malformedAuthorityAccepted", true);
      break;
    case "R03":
      set("recovery.timerExpired", "action");
      set("recovery.timerMisclassifiedAs", "turn");
      break;
    case "R04":
      set("recovery.expiryUsedLastDurableBoundary", false);
      break;
    case "R05":
      set("recovery.staleReconciliationClearedUnknown", true);
      break;
    case "R06":
      set("recovery.cleanupHasSeparateAuthorization", false);
      set("recovery.cleanupReusesOriginalMutation", true);
      break;
    case "Q01":
      set("qualification.dashboardMatchesBackend", false);
      set("qualification.dashboardLagMs", 10_000);
      break;
    case "Q02":
      set("qualification.causalBoundaryIds", ["B1"]);
      break;
    case "Q03":
      set("qualification.oracleAuthority", "scry");
      break;
    case "Q04":
      set("qualification.campaignTerminalFailure", true);
      set("qualification.campaignQuotaPresent", false);
      set("qualification.secondLiveActionAdmitted", true);
      break;
    default:
      throw new Error(`Q1_NEGATIVE_CASE_MISSING:${invariantId}`);
  }
  return { before, action, after };
}

export function runActions(actions: readonly Q1Action[]): Q1Snapshot {
  return actions.reduce(applyReferenceAction, createReferenceState());
}
