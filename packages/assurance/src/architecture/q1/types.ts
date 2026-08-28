import type { Invariant } from "../q0/types.js";

export type Q1ProofStatus =
  "proven_q1" | "partially_proven" | "future_proof_required" | "known_product_gap" | "unresolved";

export type Q1ProofGate =
  "Q2" | "milestone_4_foundation" | "Q3" | "Q4" | "Q5" | "Q6" | "dashboard_projection" | "Q7";

export type Q1ProofRequirement = Readonly<{
  proofGate: Q1ProofGate;
  ownerMilestone: 3 | 4 | 5 | 6 | 7;
  scope: string;
}>;

export type Q1AssertionStatus = "pass" | "fail" | "not_evaluable";
export type Q1Family = "M" | "T" | "L" | "A" | "P" | "R" | "Q";
export type MutationTruth = "not_attempted" | "not_applied" | "applied" | "unknown";
export type FunctionalTruth = "pending" | "succeeded" | "failed" | "inconclusive";
export type EvidenceState = "pending" | "available" | "failed" | "quarantined" | "suppressed";
export type RuntimeState = "healthy" | "unavailable" | "recovery_required" | "terminal";

export type Q1Snapshot = Readonly<{
  scope: Readonly<{
    projectId: string;
    missionId: string;
    objectiveId: string;
    environmentId: string;
    agentSessionId: string;
    praxisSessionId: string;
    runId: string;
  }>;
  mission: Readonly<{
    state: string;
    requiredObjectivesTerminal: boolean;
    conclusionsAllowed: boolean;
  }>;
  objective: Readonly<{
    state: string;
    conclusion: string | null;
    acceptedEvidence: boolean;
    automated: boolean;
  }>;
  run: Readonly<{
    state: string;
    resultClassification: string | null;
    attemptStates: readonly string[];
    attemptHistory: readonly Readonly<{
      attemptId: string;
      attemptNumber: number;
      state: string;
      claimToken: string | null;
    }>[];
    attemptHistoryPreserved: boolean;
    identityStable: boolean;
    operationMutable: boolean;
  }>;
  agent: Readonly<{ state: string; leaseValid: boolean; cleanupDeadlineExceeded: boolean }>;
  praxis: Readonly<{ state: string; liveRuntimeOwners: number; terminalConverged: boolean }>;
  operation: Readonly<{
    kind: "read_only" | "ordinary_mutation" | "protected_mutation";
    operationId: string;
    mutationIdentity: string;
    providerIdempotencyIdentity: string;
    originalMutationTruth: MutationTruth;
    mutationTruth: MutationTruth;
    mutationHistory: readonly MutationTruth[];
    functionalTruth: FunctionalTruth;
    dispatchPossible: boolean;
    dispatchCount: number;
    freshReplayAuthorized: boolean;
    failureClassifiedNotApplied: boolean;
    terminal: boolean;
    reconciliationInvokedMutation: boolean;
    reconciliationAuthoritative: boolean;
    reconciliationOwnerCurrent: boolean;
    reconciliationProvenanceRetained: boolean;
    protectedTruth: MutationTruth | null;
    adaptiveProjectionTruth: MutationTruth | null;
  }>;
  truth: Readonly<{
    privacy: "pending" | "sealed" | "failed";
    evidence: EvidenceState;
    evidenceRequired: boolean;
    evidenceChannelCount: number;
    qualityFinding: boolean;
    qualityClaimRequiresPass: boolean;
    runtime: RuntimeState;
    persistence: "pending" | "committed" | "failed" | "uncertain";
    telemetry: "healthy" | "failed";
    causalEnvelopeRetained: boolean;
  }>;
  authority: Readonly<{
    refSessionMatches: boolean;
    refPageMatches: boolean;
    refFrameMatches: boolean;
    refDocumentEpoch: number;
    currentDocumentEpoch: number;
    refRuntimeElementCurrent: boolean;
    refUsedForDispatch: boolean;
    semanticReplacementAccepted: boolean;
    requestMetadataUsedAsDocumentAuthority: boolean;
    protectedAuthorizationMatchesScope: boolean;
    externalIdentityAuthoritative: boolean;
    checkpointRestored: boolean;
    checkpointCreatedNewEpoch: boolean;
    oldRefRevived: boolean;
  }>;
  privacy: Readonly<{
    publicOutputsContainProtectedValue: boolean;
    protectedIntervalOpen: boolean;
    captureOccurred: boolean;
    cleanupUsedAsPrivacyProof: boolean;
    artifactAvailable: boolean;
    artifactBytesCommitted: boolean;
    artifactChecksumVerified: boolean;
    artifactSafeAdmission: boolean;
    artifactProvenanceMatches: boolean;
  }>;
  recovery: Readonly<{
    blockerProjectId: string | null;
    blockerResourceRelated: boolean;
    malformedAuthorityAccepted: boolean;
    timerExpired:
      "none" | "action" | "turn" | "evidence" | "db" | "lease" | "reconciliation" | "cleanup";
    timerMisclassifiedAs: string | null;
    expiryUsedLastDurableBoundary: boolean;
    staleReconciliationClearedUnknown: boolean;
    cleanupHasSeparateAuthorization: boolean;
    cleanupReusesOriginalMutation: boolean;
  }>;
  qualification: Readonly<{
    dashboardMatchesBackend: boolean;
    dashboardLagMs: number;
    dashboardSlaMs: number;
    causalBoundaryIds: readonly string[];
    oracleAuthority: "independent" | "scry" | "missing";
    campaignTerminalFailure: boolean;
    campaignQuotaPresent: boolean;
    secondLiveActionAdmitted: boolean;
  }>;
}>;

export type Q1Action =
  | Readonly<{ type: "beginPossibleDispatch" }>
  | Readonly<{ type: "crossDispatch" }>
  | Readonly<{ type: "authorizeFreshReplay" }>
  | Readonly<{ type: "establishMutation"; truth: MutationTruth; authoritative?: boolean }>
  | Readonly<{ type: "beginReconciliation"; ownerCurrent: boolean }>
  | Readonly<{
      type: "reconcileMutation";
      truth: "applied" | "not_applied";
      authoritative: boolean;
    }>
  | Readonly<{ type: "recordFunctionalResult"; truth: FunctionalTruth }>
  | Readonly<{ type: "settleEvidence"; state: EvidenceState; required: boolean }>
  | Readonly<{ type: "settlePrivacy"; state: "sealed" | "failed" }>
  | Readonly<{ type: "setPersistence"; state: "committed" | "failed" | "uncertain" }>
  | Readonly<{ type: "setRuntime"; state: RuntimeState }>
  | Readonly<{ type: "replaceDocument" }>
  | Readonly<{ type: "useReference" }>
  | Readonly<{ type: "acceptReplacementBySemantics" }>
  | Readonly<{ type: "useRequestMetadataAsAuthority" }>
  | Readonly<{ type: "finalizeRun"; state: "passed" | "failed" }>
  | Readonly<{ type: "acceptObjectiveEvidence" }>
  | Readonly<{ type: "concludeObjective"; state: "passed" | "failed" | "blocked" | "skipped" }>
  | Readonly<{ type: "finalizeMission" }>
  | Readonly<{ type: "loseAgentLease"; cleanupDeadlineExceeded?: boolean }>
  | Readonly<{ type: "loseRuntimeLease" }>
  | Readonly<{ type: "restoreCheckpoint" }>
  | Readonly<{
      type: "setProtectedProjection";
      canonical: MutationTruth;
      projection: MutationTruth;
    }>
  | Readonly<{ type: "setCampaignFailure"; quotaPresent: boolean; admitSecond: boolean }>
  | Readonly<{ type: "testOnlyPersistenceFailureInfersRuntimeDeath" }>
  | Readonly<{ type: "testOnlyCorrupt"; path: Q1FaultPath; value: boolean | string | number }>;

export type Q1FaultPath =
  | "operation.reconciliationInvokedMutation"
  | "operation.reconciliationProvenanceRetained"
  | "operation.providerIdempotencyIdentity"
  | "operation.failureClassifiedNotApplied"
  | "objective.acceptedEvidence"
  | "run.attemptHistoryPreserved"
  | "run.operationMutable"
  | "praxis.liveRuntimeOwners"
  | "praxis.terminalConverged"
  | "truth.causalEnvelopeRetained"
  | "truth.qualityFinding"
  | "truth.qualityClaimRequiresPass"
  | "truth.telemetry"
  | "authority.refSessionMatches"
  | "authority.refUsedForDispatch"
  | "authority.protectedAuthorizationMatchesScope"
  | "authority.externalIdentityAuthoritative"
  | "privacy.publicOutputsContainProtectedValue"
  | "privacy.captureOccurred"
  | "privacy.cleanupUsedAsPrivacyProof"
  | "recovery.malformedAuthorityAccepted"
  | "recovery.staleReconciliationClearedUnknown"
  | "recovery.cleanupHasSeparateAuthorization"
  | "recovery.cleanupReusesOriginalMutation"
  | "qualification.oracleAuthority";

export type Q1InvariantResult = Readonly<{
  invariantId: string;
  family: Q1Family;
  status: Q1AssertionStatus;
  risk: Invariant["risk"];
  involvedMachines: readonly string[];
  involvedTruthChannels: readonly string[];
  boundaryIds: readonly string[];
  responsibleOwners: readonly string[];
  proofStatus: Q1ProofStatus;
  proofRequirements: readonly Q1ProofRequirement[];
  safeExplanation: string;
}>;

export type Q1Violation = Readonly<{
  invariantId: string;
  actionIndex: number;
  action: Q1Action;
  before: Q1Snapshot;
  after: Q1Snapshot;
  result: Q1InvariantResult;
}>;

export type Q1Sequence = Readonly<{
  id: string;
  seed: number;
  truthSource?: "pure_reference" | "production_repository" | "contract_helper";
  initialState: Q1Snapshot;
  actions: readonly Q1Action[];
}>;

export type Q1Reproduction = Readonly<{
  invariantId: string;
  seed: number;
  release: string;
  schemaFingerprint: string;
  q0ManifestDigest: string;
  initialState: Q1Snapshot;
  actions: readonly Q1Action[];
  observedState: Q1Snapshot;
  expectedRule: string;
  truthSource: "pure_reference" | "production_repository" | "contract_helper";
  observedTruth: Readonly<{
    mutation: MutationTruth;
    functional: FunctionalTruth;
    run: string;
    objective: string;
    evidence: EvidenceState;
    runtime: RuntimeState;
  }>;
  boundaryIds: readonly string[];
  responsibleOwners: readonly string[];
  proofTier: Q1ProofStatus;
}>;
