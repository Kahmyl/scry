import type { AdaptiveSessionState } from "@scry/contracts";

export type CanonicalMutationTruth = "none" | "not_applied" | "applied" | "unknown";

export type RuntimeLossFacts = {
  praxisState: AdaptiveSessionState;
  runtimePresent: boolean;
  leaseValid: boolean;
  dispatchBoundary: "none" | "not_dispatched" | "dispatching" | "dispatched" | "acknowledged";
  canonicalMutationTruth: CanonicalMutationTruth;
  recoveryObservationAvailable: boolean;
};

export type RuntimeLossDisposition = {
  praxisState: AdaptiveSessionState;
  runtimeTruth: "owned" | "recovery_required" | "closed";
  recoveryRequired: boolean;
  retry: "continue_owned_runtime" | "observe_only" | "fresh_session" | "none";
  reasonCode: string;
};

/** Mechanical lifecycle truth only. It never changes canonical mutation truth. */
export function decideRuntimeLossDisposition(facts: RuntimeLossFacts): RuntimeLossDisposition {
  if (facts.runtimePresent && facts.leaseValid) {
    return {
      praxisState: facts.praxisState,
      runtimeTruth: "owned",
      recoveryRequired: false,
      retry: "continue_owned_runtime",
      reasonCode: "RUNTIME_OWNER_REMAINS_LIVE",
    };
  }
  if (["completed", "failed", "cancelled"].includes(facts.praxisState)) {
    return {
      praxisState: facts.praxisState,
      runtimeTruth: "closed",
      recoveryRequired: false,
      retry: "none",
      reasonCode: "RUNTIME_LOSS_AFTER_TERMINAL_SESSION",
    };
  }
  const possiblyDispatched = ["dispatching", "dispatched", "acknowledged"].includes(
    facts.dispatchBoundary,
  );
  if (facts.canonicalMutationTruth === "unknown" || possiblyDispatched) {
    return {
      praxisState: "recovery_required",
      runtimeTruth: "recovery_required",
      recoveryRequired: true,
      retry: facts.recoveryObservationAvailable ? "observe_only" : "none",
      reasonCode: facts.leaseValid
        ? "RUNTIME_DISAPPEARED_WITH_LIVE_LEASE"
        : "RUNTIME_OWNERSHIP_LOST_AFTER_POSSIBLE_DISPATCH",
    };
  }
  return {
    praxisState: "failed",
    runtimeTruth: "closed",
    recoveryRequired: false,
    retry: "fresh_session",
    reasonCode:
      facts.canonicalMutationTruth === "applied"
        ? "RUNTIME_OWNERSHIP_LOST_AFTER_APPLIED_MUTATION"
        : "RUNTIME_OWNERSHIP_LOST_BEFORE_MUTATION",
  };
}
