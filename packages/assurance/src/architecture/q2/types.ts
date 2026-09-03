import type { Q1Action, Q1Snapshot } from "../q1/types.js";

export type Q2BoundaryId =
  | "B1"
  | "B2"
  | "B3"
  | "B4"
  | "B5"
  | "B6"
  | "B7"
  | "B8"
  | "B9"
  | "B10"
  | "B11"
  | "B12"
  | "B13"
  | "B14"
  | "B15"
  | "B16"
  | "B17"
  | "B18"
  | "B19"
  | "B20";
export type Q2FaultEffect =
  | "throw"
  | "reject_db"
  | "drop_response"
  | "lose_lease"
  | "close_runtime"
  | "fail_artifact_persist"
  | "fail_event_sink";
export type Q2DispatchCategory = "impossible" | "possible" | "acknowledged";
export type Q2RetryClass =
  | "safe_after_fresh_authority"
  | "do_not_retry"
  | "observe_only"
  | "finalize_only"
  | "projection_only"
  | "cleanup_or_quarantine"
  | "settle_lifecycle_only"
  | "telemetry_fallback";

export type Q2SafeScope = Readonly<{
  projectId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  runId: string;
  attemptId: string;
  praxisSessionId: string;
  operationId: string;
  protectedOperationId?: string;
  correlationId: string;
}>;

export type Q2FailpointDefinition = Readonly<{
  name: string;
  boundary: Q2BoundaryId;
  effect: Q2FaultEffect;
  fireOnNth: number;
  maxFires: number;
}>;

export type Q2FailpointLedgerEntry = Q2FailpointDefinition &
  Readonly<{
    invocation: number;
    firedAtOrdinal: number;
    scope: Q2SafeScope;
  }>;

export type Q2CausalEnvelope = Readonly<{
  schemaVersion: 1;
  phase: string;
  component: string;
  reasonCode: string;
  causeCategory: "authority" | "dispatch" | "persistence" | "runtime" | "evidence" | "telemetry";
  dispatchBoundary: Q2DispatchCategory;
  truth: Readonly<{
    functional: Q1Snapshot["operation"]["functionalTruth"];
    mutation: Q1Snapshot["operation"]["mutationTruth"];
    privacy: Q1Snapshot["truth"]["privacy"];
    evidence: Q1Snapshot["truth"]["evidence"];
    runtime: Q1Snapshot["truth"]["runtime"];
  }>;
  retryClass: Q2RetryClass;
  causality: Q2SafeScope;
  safeCauseRef: string;
}>;

export type Q2Scenario = Readonly<{
  id: string;
  seed: number;
  boundary: Q2BoundaryId;
  failpoint: Q2FailpointDefinition;
  phase: string;
  component: string;
  causeCategory: Q2CausalEnvelope["causeCategory"];
  dispatchCategory: Q2DispatchCategory;
  actions: readonly Q1Action[];
  expected: Readonly<{
    functional: Q1Snapshot["operation"]["functionalTruth"];
    mutation: Q1Snapshot["operation"]["mutationTruth"];
    privacy: Q1Snapshot["truth"]["privacy"];
    evidence: Q1Snapshot["truth"]["evidence"];
    runtime: Q1Snapshot["truth"]["runtime"];
    lifecycle: string;
    dispatchCount: number;
  }>;
  retryClass: Q2RetryClass;
  recoveryOwner: string;
  invariantIds: readonly string[];
}>;
