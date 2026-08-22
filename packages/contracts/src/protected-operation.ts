import { z } from "zod";

export const protectedOperationOwnerKindSchema = z.enum(["authoring_session", "run"]);

export const protectedOperationStateSchema = z.enum([
  "reserved",
  "planned",
  "preparing",
  "ready_to_dispatch",
  "dispatching",
  "dispatched",
  "acquiring",
  "persisting",
  "persisted",
  "reconciling",
  "completed",
  "failed_not_applied",
  "recovery_required",
  "compromised",
  "revoked",
  "abandoned",
]);

export type ProtectedOperationState = z.infer<typeof protectedOperationStateSchema>;
export type ProtectedOperationOwnerKind = z.infer<typeof protectedOperationOwnerKindSchema>;

export type ProtectedOperationClaim = {
  id: string;
  state: ProtectedOperationState;
  version: number;
  fencingToken: number;
  mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
  persistedReferences?: Record<
    string,
    {
      classification: "public" | "protected";
      credentialId?: string;
      valueId?: string;
      scope: "run" | "project";
    }
  >;
};

export type ProtectedTransactionStore = {
  claim(input: {
    operationId: string;
    mutationKind: "one_time" | "repeatable";
    dispatchSemantics?: "mutation" | "read_only";
    programDigest: string;
    inputSchemaDigest: string;
    inputDigest: string;
    mutationIdentity: string;
    safeOutputManifest: Array<{
      reference: string;
      classification: "public" | "protected";
      storageName: string;
    }>;
  }): Promise<ProtectedOperationClaim>;
  transition(input: {
    id: string;
    operationId: string;
    version: number;
    fencingToken: number;
    expected: ProtectedOperationState;
    next: ProtectedOperationState;
    phase: string;
    reasonCode?: string;
    facts?: Record<string, unknown>;
  }): Promise<ProtectedOperationClaim>;
  record(input: {
    operationId: string;
    fencingToken: number;
    phase: string;
    facts?: Record<string, unknown>;
  }): Promise<void>;
  settleMutationOutcome(input: {
    id: string;
    operationId: string;
    version: number;
    fencingToken: number;
    outcome: "applied" | "not_applied";
  }): Promise<ProtectedOperationClaim>;
  heartbeat?(claim: ProtectedOperationClaim): Promise<void>;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};

const transitions = {
  reserved: ["planned", "failed_not_applied"],
  planned: ["preparing", "failed_not_applied"],
  preparing: ["ready_to_dispatch", "failed_not_applied"],
  ready_to_dispatch: ["dispatching", "failed_not_applied"],
  dispatching: ["dispatched", "failed_not_applied", "recovery_required"],
  dispatched: ["acquiring", "failed_not_applied", "recovery_required"],
  acquiring: ["persisting", "failed_not_applied", "recovery_required", "compromised"],
  persisting: ["persisted", "failed_not_applied", "recovery_required", "compromised"],
  persisted: ["reconciling", "failed_not_applied", "recovery_required"],
  reconciling: ["completed", "failed_not_applied", "recovery_required", "compromised"],
  recovery_required: ["acquiring", "reconciling", "compromised", "revoked", "abandoned"],
  compromised: ["revoked", "abandoned"],
  completed: [],
  failed_not_applied: [],
  revoked: [],
  abandoned: [],
} as const satisfies Record<ProtectedOperationState, readonly ProtectedOperationState[]>;

export const protectedOperationTerminalStates = new Set<ProtectedOperationState>([
  "completed",
  "failed_not_applied",
  "revoked",
  "abandoned",
]);

export function canTransitionProtectedOperation(
  current: ProtectedOperationState,
  next: ProtectedOperationState,
) {
  return (transitions[current] as readonly ProtectedOperationState[]).includes(next);
}

export function assertProtectedOperationTransition(
  current: ProtectedOperationState,
  next: ProtectedOperationState,
) {
  if (!canTransitionProtectedOperation(current, next)) {
    throw new Error(`PROTECTED_OPERATION_TRANSITION_INVALID:${current}:${next}`);
  }
}

export function protectedOperationDispatchMayBegin(
  current: ProtectedOperationState,
  next: ProtectedOperationState,
) {
  return current === "ready_to_dispatch" && next === "dispatching";
}

export function protectedOperationLeaseExpiryState(
  current: ProtectedOperationState,
  dispatchSemantics: "mutation" | "read_only" = "mutation",
) {
  if (["reserved", "planned", "preparing", "ready_to_dispatch"].includes(current)) return current;
  if (protectedOperationTerminalStates.has(current) || current === "compromised") return current;
  if (dispatchSemantics === "read_only") return "failed_not_applied" as const;
  return "recovery_required" as const;
}
