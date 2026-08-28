import type { Q1Action, Q1FaultPath, Q1Snapshot } from "./types.js";

export function createReferenceState(): Q1Snapshot {
  return freezeSnapshot({
    scope: {
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      environmentId: "environment-1",
      agentSessionId: "agent-1",
      praxisSessionId: "praxis-1",
      runId: "run-1",
    },
    mission: { state: "active", requiredObjectivesTerminal: false, conclusionsAllowed: true },
    objective: { state: "running", conclusion: null, acceptedEvidence: false, automated: true },
    run: {
      state: "running",
      resultClassification: null,
      attemptStates: ["running"],
      attemptHistory: [
        { attemptId: "attempt-1", attemptNumber: 1, state: "running", claimToken: "claim-1" },
      ],
      attemptHistoryPreserved: true,
      identityStable: true,
      operationMutable: true,
    },
    agent: { state: "active", leaseValid: true, cleanupDeadlineExceeded: false },
    praxis: { state: "active", liveRuntimeOwners: 1, terminalConverged: true },
    operation: {
      kind: "ordinary_mutation",
      operationId: "operation-1",
      mutationIdentity: "mutation-1",
      providerIdempotencyIdentity: "provider-1",
      originalMutationTruth: "not_attempted",
      mutationTruth: "not_attempted",
      mutationHistory: ["not_attempted"],
      functionalTruth: "pending",
      dispatchPossible: false,
      dispatchCount: 0,
      freshReplayAuthorized: false,
      failureClassifiedNotApplied: false,
      terminal: false,
      reconciliationInvokedMutation: false,
      reconciliationAuthoritative: false,
      reconciliationOwnerCurrent: true,
      reconciliationProvenanceRetained: true,
      protectedTruth: null,
      adaptiveProjectionTruth: null,
    },
    truth: {
      privacy: "pending",
      evidence: "pending",
      evidenceRequired: true,
      evidenceChannelCount: 1,
      qualityFinding: false,
      qualityClaimRequiresPass: false,
      runtime: "healthy",
      persistence: "pending",
      telemetry: "healthy",
      causalEnvelopeRetained: true,
    },
    authority: {
      refSessionMatches: true,
      refPageMatches: true,
      refFrameMatches: true,
      refDocumentEpoch: 1,
      currentDocumentEpoch: 1,
      refRuntimeElementCurrent: true,
      refUsedForDispatch: false,
      semanticReplacementAccepted: false,
      requestMetadataUsedAsDocumentAuthority: false,
      protectedAuthorizationMatchesScope: true,
      externalIdentityAuthoritative: true,
      checkpointRestored: false,
      checkpointCreatedNewEpoch: false,
      oldRefRevived: false,
    },
    privacy: {
      publicOutputsContainProtectedValue: false,
      protectedIntervalOpen: false,
      captureOccurred: false,
      cleanupUsedAsPrivacyProof: false,
      artifactAvailable: false,
      artifactBytesCommitted: false,
      artifactChecksumVerified: false,
      artifactSafeAdmission: false,
      artifactProvenanceMatches: false,
    },
    recovery: {
      blockerProjectId: null,
      blockerResourceRelated: false,
      malformedAuthorityAccepted: false,
      timerExpired: "none",
      timerMisclassifiedAs: null,
      expiryUsedLastDurableBoundary: true,
      staleReconciliationClearedUnknown: false,
      cleanupHasSeparateAuthorization: true,
      cleanupReusesOriginalMutation: false,
    },
    qualification: {
      dashboardMatchesBackend: true,
      dashboardLagMs: 0,
      dashboardSlaMs: 5_000,
      causalBoundaryIds: Array.from({ length: 20 }, (_, index) => `B${index + 1}`),
      oracleAuthority: "independent",
      campaignTerminalFailure: false,
      campaignQuotaPresent: false,
      secondLiveActionAdmitted: false,
    },
  });
}

export function applyReferenceAction(state: Q1Snapshot, action: Q1Action): Q1Snapshot {
  const next = structuredClone(state) as Mutable<Q1Snapshot>;
  switch (action.type) {
    case "beginPossibleDispatch":
      next.operation.dispatchPossible = true;
      break;
    case "crossDispatch":
      next.operation.dispatchPossible = true;
      next.operation.dispatchCount += 1;
      break;
    case "authorizeFreshReplay":
      next.operation.freshReplayAuthorized = true;
      break;
    case "establishMutation":
      next.operation.mutationTruth = action.truth;
      next.operation.mutationHistory = [...next.operation.mutationHistory, action.truth];
      if (next.operation.originalMutationTruth === "not_attempted")
        next.operation.originalMutationTruth = action.truth;
      next.operation.reconciliationAuthoritative = action.authoritative ?? false;
      break;
    case "beginReconciliation":
      next.operation.reconciliationOwnerCurrent = action.ownerCurrent;
      break;
    case "reconcileMutation":
      next.operation.reconciliationAuthoritative = action.authoritative;
      next.operation.mutationTruth = action.truth;
      next.operation.mutationHistory = [...next.operation.mutationHistory, action.truth];
      break;
    case "recordFunctionalResult":
      next.operation.functionalTruth = action.truth;
      break;
    case "settleEvidence":
      next.truth.evidence = action.state;
      next.truth.evidenceRequired = action.required;
      break;
    case "settlePrivacy":
      next.truth.privacy = action.state;
      break;
    case "setPersistence":
      next.truth.persistence = action.state;
      break;
    case "setRuntime":
      next.truth.runtime = action.state;
      break;
    case "replaceDocument":
      next.authority.currentDocumentEpoch += 1;
      next.authority.refRuntimeElementCurrent = false;
      break;
    case "useReference":
      next.authority.refUsedForDispatch = true;
      break;
    case "acceptReplacementBySemantics":
      next.authority.semanticReplacementAccepted = true;
      break;
    case "useRequestMetadataAsAuthority":
      next.authority.requestMetadataUsedAsDocumentAuthority = true;
      break;
    case "finalizeRun":
      next.run.state = action.state;
      next.run.resultClassification =
        action.state === "passed" ? "application_pass" : "application_failure";
      next.run.attemptStates = [action.state];
      next.run.operationMutable = false;
      next.operation.terminal = true;
      break;
    case "acceptObjectiveEvidence":
      next.objective.acceptedEvidence = true;
      break;
    case "concludeObjective":
      next.objective.state = action.state;
      next.objective.conclusion = `${action.state.toUpperCase()}_CONCLUSION`;
      break;
    case "finalizeMission":
      next.mission.state = "completed";
      next.mission.requiredObjectivesTerminal = ["passed", "failed", "blocked", "skipped"].includes(
        next.objective.state,
      );
      break;
    case "loseAgentLease":
      next.agent.leaseValid = false;
      next.agent.cleanupDeadlineExceeded = action.cleanupDeadlineExceeded ?? false;
      break;
    case "loseRuntimeLease":
      next.praxis.liveRuntimeOwners = 0;
      next.truth.runtime = "recovery_required";
      break;
    case "restoreCheckpoint":
      next.authority.checkpointRestored = true;
      next.authority.checkpointCreatedNewEpoch = true;
      next.authority.currentDocumentEpoch += 1;
      next.authority.refRuntimeElementCurrent = false;
      break;
    case "setProtectedProjection":
      next.operation.kind = "protected_mutation";
      next.operation.protectedTruth = action.canonical;
      next.operation.adaptiveProjectionTruth = action.projection;
      next.operation.mutationTruth = action.canonical;
      break;
    case "setCampaignFailure":
      next.qualification.campaignTerminalFailure = true;
      next.qualification.campaignQuotaPresent = action.quotaPresent;
      next.qualification.secondLiveActionAdmitted = action.admitSecond;
      break;
    case "testOnlyPersistenceFailureInfersRuntimeDeath":
      next.truth.persistence = "failed";
      next.truth.runtime = "unavailable";
      break;
    case "testOnlyCorrupt":
      setFault(next, action.path, action.value);
      break;
  }
  return freezeSnapshot(next);
}

function setFault(state: Mutable<Q1Snapshot>, path: Q1FaultPath, value: boolean | string | number) {
  const [owner, field] = path.split(".") as [keyof Q1Snapshot, string];
  (state[owner] as Record<string, unknown>)[field] = value;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? U[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

export function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeSnapshot(nested);
  }
  return value;
}
