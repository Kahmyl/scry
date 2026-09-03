import { correctnessManifest } from "../q0/manifest.js";
import type { Invariant } from "../q0/types.js";
import type {
  Q1Action,
  Q1InvariantResult,
  Q1ProofRequirement,
  Q1ProofStatus,
  Q1Snapshot,
} from "./types.js";

type Assertion = (state: Q1Snapshot, before?: Q1Snapshot, action?: Q1Action) => boolean | undefined;

const assertions: Record<string, Assertion> = {
  M01: (s, b) =>
    !(
      (b?.operation.mutationTruth === "unknown" ||
        s.operation.originalMutationTruth === "unknown") &&
      s.operation.mutationTruth === "not_applied"
    ) || s.operation.reconciliationAuthoritative,
  M02: (s) =>
    !s.operation.mutationHistory.includes("applied") || s.operation.mutationTruth === "applied",
  M03: (s) =>
    s.operation.originalMutationTruth !== "not_applied" ||
    s.operation.mutationTruth === "not_applied",
  M04: (s) => !s.operation.dispatchPossible || !s.operation.freshReplayAuthorized,
  M05: (s) => s.operation.dispatchCount <= 1,
  M06: (s) =>
    !s.operation.failureClassifiedNotApplied ||
    !s.operation.dispatchPossible ||
    s.operation.reconciliationAuthoritative,
  M07: (s) => s.operation.kind !== "read_only" || s.operation.mutationTruth !== "unknown",
  M08: (s) => !s.operation.reconciliationInvokedMutation,
  M09: (s, b) =>
    !b ||
    b.operation.mutationIdentity !== s.operation.mutationIdentity ||
    b.operation.providerIdempotencyIdentity === s.operation.providerIdempotencyIdentity,
  M10: (s) =>
    s.operation.originalMutationTruth !== "unknown" || s.operation.reconciliationProvenanceRetained,
  T01: (s) =>
    Boolean(
      s.operation.functionalTruth &&
      s.operation.mutationTruth &&
      s.truth.privacy &&
      s.truth.evidence &&
      s.truth.runtime &&
      s.truth.persistence,
    ) &&
    (s.operation.kind !== "protected_mutation" ||
      s.operation.protectedTruth === s.operation.adaptiveProjectionTruth),
  T02: (s, b, a) =>
    a?.type !== "settleEvidence" ||
    !b ||
    (s.operation.functionalTruth === b.operation.functionalTruth &&
      s.operation.mutationTruth === b.operation.mutationTruth),
  T03: (s, b, a) =>
    !["setPersistence", "testOnlyPersistenceFailureInfersRuntimeDeath"].includes(a?.type ?? "") ||
    !b ||
    s.truth.runtime === b.truth.runtime,
  T04: (s, b, a) =>
    a?.type !== "loseRuntimeLease" ||
    !b ||
    s.operation.functionalTruth === b.operation.functionalTruth,
  T05: (s) =>
    !(
      s.operation.functionalTruth === "succeeded" &&
      s.operation.mutationTruth === "unknown" &&
      s.run.state === "passed"
    ),
  T06: (s) =>
    !s.truth.qualityFinding ||
    s.truth.qualityClaimRequiresPass ||
    s.operation.functionalTruth !== "failed",
  T07: (s, b) =>
    s.truth.telemetry !== "failed" ||
    !b ||
    (s.operation.functionalTruth === b.operation.functionalTruth &&
      s.operation.mutationTruth === b.operation.mutationTruth),
  T08: (s) => s.truth.causalEnvelopeRetained,
  L01: (s) => s.run.state !== "passed" || s.run.attemptStates.at(-1) === "passed",
  L02: (s) => s.run.identityStable,
  L03: (s) =>
    !(s.agent.state === "active" && !s.agent.leaseValid && s.agent.cleanupDeadlineExceeded),
  L04: (s) => s.praxis.state !== "active" || s.praxis.liveRuntimeOwners === 1,
  L05: (s, b) =>
    !b ||
    s.operation.reconciliationOwnerCurrent ||
    s.operation.mutationTruth === b.operation.mutationTruth,
  L06: (s) => !(s.operation.terminal && s.run.operationMutable),
  L07: (s) =>
    s.objective.state !== "passed" || !s.objective.automated || s.objective.acceptedEvidence,
  L08: (s) =>
    s.mission.state !== "completed" ||
    (s.mission.requiredObjectivesTerminal &&
      s.mission.conclusionsAllowed &&
      (s.objective.state !== "passed" || s.objective.acceptedEvidence)),
  L09: (s) =>
    !["completed", "failed", "cancelled", "expired"].includes(s.praxis.state) ||
    s.praxis.terminalConverged,
  L10: (s) => s.run.attemptHistoryPreserved,
  A01: (s) =>
    !s.authority.refUsedForDispatch ||
    (s.authority.refSessionMatches &&
      s.authority.refPageMatches &&
      s.authority.refFrameMatches &&
      s.authority.refDocumentEpoch === s.authority.currentDocumentEpoch &&
      s.authority.refRuntimeElementCurrent),
  A02: (s) =>
    s.authority.refDocumentEpoch === s.authority.currentDocumentEpoch ||
    !s.authority.refRuntimeElementCurrent,
  A03: (s) => !s.authority.semanticReplacementAccepted,
  A04: (s) => !s.authority.requestMetadataUsedAsDocumentAuthority,
  A05: (s) => s.authority.protectedAuthorizationMatchesScope,
  A06: (s) => s.authority.externalIdentityAuthoritative,
  A07: (s) =>
    !s.authority.checkpointRestored ||
    (s.authority.checkpointCreatedNewEpoch &&
      !s.authority.oldRefRevived &&
      !s.authority.refRuntimeElementCurrent),
  P01: (s) => !s.privacy.publicOutputsContainProtectedValue,
  P02: (s) => !(s.privacy.protectedIntervalOpen && s.privacy.captureOccurred),
  P03: (s) => !s.privacy.cleanupUsedAsPrivacyProof,
  P04: (s) =>
    !(
      s.truth.evidenceRequired &&
      ["pending", "failed", "quarantined"].includes(s.truth.evidence) &&
      s.run.state === "passed"
    ),
  P05: (s) =>
    !(
      s.truth.evidence === "suppressed" &&
      !s.truth.evidenceRequired &&
      s.run.resultClassification === "evidence_failure"
    ),
  P06: (s) =>
    !s.privacy.artifactAvailable ||
    (s.privacy.artifactBytesCommitted &&
      s.privacy.artifactChecksumVerified &&
      s.privacy.artifactSafeAdmission &&
      s.privacy.artifactProvenanceMatches),
  P07: (s) => s.truth.evidenceChannelCount === 1,
  R01: (s) =>
    s.recovery.blockerProjectId === null ||
    s.recovery.blockerProjectId === s.scope.projectId ||
    s.recovery.blockerResourceRelated,
  R02: (s) => !s.recovery.malformedAuthorityAccepted,
  R03: (s) =>
    s.recovery.timerMisclassifiedAs === null ||
    s.recovery.timerMisclassifiedAs === s.recovery.timerExpired,
  R04: (s) => s.recovery.expiryUsedLastDurableBoundary,
  R05: (s) => !s.recovery.staleReconciliationClearedUnknown,
  R06: (s) =>
    s.recovery.cleanupHasSeparateAuthorization && !s.recovery.cleanupReusesOriginalMutation,
  Q01: (s) =>
    s.qualification.dashboardMatchesBackend &&
    s.qualification.dashboardLagMs <= s.qualification.dashboardSlaMs,
  Q02: (s) =>
    correctnessManifest.boundaries.every(({ id }) =>
      s.qualification.causalBoundaryIds.includes(id),
    ),
  Q03: (s) => s.qualification.oracleAuthority === "independent",
  Q04: (s) =>
    !s.qualification.campaignTerminalFailure ||
    (s.qualification.campaignQuotaPresent && !s.qualification.secondLiveActionAdmitted),
};

const truthChannels: Record<string, readonly string[]> = {
  M: ["mutation", "dispatch", "reconciliation"],
  T: [
    "functional",
    "mutation",
    "privacy",
    "evidence",
    "quality",
    "runtime",
    "persistence",
    "telemetry",
  ],
  L: ["lifecycle", "lease", "fence", "evidence"],
  A: ["session", "page", "frame", "document", "reference", "authorization", "external_identity"],
  P: ["privacy", "evidence", "artifact"],
  R: ["recovery", "timer", "conflict_scope", "mutation"],
  Q: ["projection", "causality", "oracle", "campaign_authorization"],
};

export function proofStatusFor(invariant: Invariant): Q1ProofStatus {
  if (invariant.id === "Q04") return "production_proven_q5";
  if (proofRequirementsFor(invariant).length > 0) return "future_proof_required";
  return "partially_proven";
}

export function proofRequirementsFor(invariant: Invariant): readonly Q1ProofRequirement[] {
  if (invariant.id === "Q01")
    return [
      {
        proofGate: "dashboard_projection",
        ownerMilestone: 7,
        scope: "dashboard projection freshness and backend agreement",
      },
    ];
  if (invariant.id === "Q02" || invariant.id.startsWith("A") || invariant.id.startsWith("P"))
    return [
      {
        proofGate: "Q2",
        ownerMilestone: 3,
        scope: "real authority, privacy, evidence, and B1-B20 causal-envelope boundaries",
      },
    ];
  if (invariant.id === "Q03")
    return [
      {
        proofGate: "Q3",
        ownerMilestone: 5,
        scope: "independent Stage-6 miniature and external resource oracle",
      },
    ];
  if (["R03", "R04", "R06"].includes(invariant.id))
    return [
      {
        proofGate: "milestone_4_foundation",
        ownerMilestone: 4,
        scope: "conflict, recovery, lifecycle, and reconciliation foundations",
      },
      {
        proofGate: "Q3",
        ownerMilestone: 5,
        scope: "independent miniature ambiguity and reconciliation scenarios",
      },
    ];
  if (["L03", "L04", "L05", "L09", "R05"].includes(invariant.id))
    return [
      {
        proofGate: "milestone_4_foundation",
        ownerMilestone: 4,
        scope: "lease, lifecycle, recovery, and reconciliation foundations",
      },
      {
        proofGate: "Q4",
        ownerMilestone: 6,
        scope: "process death, fencing, convergence, stale-owner refusal, and stuck reconciliation",
      },
    ];
  if (invariant.id === "Q04") return [];
  return [];
}

export function evaluateInvariants(
  state: Q1Snapshot,
  before?: Q1Snapshot,
  action?: Q1Action,
): Q1InvariantResult[] {
  return correctnessManifest.invariants.map((invariant) => {
    const assertion = assertions[invariant.id];
    const outcome = assertion?.(state, before, action);
    const family = invariant.id[0] as Q1InvariantResult["family"];
    return {
      invariantId: invariant.id,
      family,
      status: outcome === undefined ? "not_evaluable" : outcome ? "pass" : "fail",
      risk: invariant.risk,
      involvedMachines: invariant.machineIds,
      involvedTruthChannels: truthChannels[family] ?? [],
      boundaryIds: invariant.boundaryIds,
      responsibleOwners: invariant.authoritativeComponents,
      proofStatus: proofStatusFor(invariant),
      proofRequirements: proofRequirementsFor(invariant),
      safeExplanation:
        outcome === false
          ? invariant.statement
          : outcome === true
            ? `Satisfied: ${invariant.statement}`
            : `Not evaluable: ${invariant.statement}`,
    };
  });
}

export function invariantStatement(id: string): string {
  return correctnessManifest.invariants.find((invariant) => invariant.id === id)?.statement ?? id;
}

export function assertCompleteRegistry(): void {
  const missing = correctnessManifest.invariants.filter(({ id }) => !assertions[id]);
  const stale = Object.keys(assertions).filter(
    (id) => !correctnessManifest.invariants.some((invariant) => invariant.id === id),
  );
  if (missing.length || stale.length)
    throw new Error(
      `Q1_INVARIANT_REGISTRY_DRIFT missing=${missing.map(({ id }) => id).join(",")} stale=${stale.join(",")}`,
    );
}
