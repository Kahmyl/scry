import { z } from "zod";

export const protectedOperationOwnerKindSchema = z.enum(["authoring_session", "run"]);

export const protectedOperationStateSchema = z.enum([
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

const transitions = {
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
  if (["planned", "preparing", "ready_to_dispatch"].includes(current)) return current;
  if (protectedOperationTerminalStates.has(current) || current === "compromised") return current;
  if (dispatchSemantics === "read_only") return "failed_not_applied" as const;
  return "recovery_required" as const;
}
