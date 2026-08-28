import { currentActionSchema, expectedEffectSchema } from "@scry/contracts";
import type { CurrentAction, ExpectedEffect } from "@scry/contracts";

export type HistoricalOperationAuthority =
  | { kind: "usable_authority"; action: CurrentAction }
  | {
      kind: "malformed_authority";
      reasonCode: "RECONCILIATION_ACTION_MISSING" | "RECONCILIATION_ACTION_MALFORMED";
    }
  | {
      kind: "unsupported_historical_authority";
      reasonCode: "RECONCILIATION_ACTION_UNSUPPORTED";
    }
  | {
      kind: "insufficient_reconciliation_authority";
      reasonCode:
        | "RECONCILIATION_EXPECTED_EFFECT_MALFORMED"
        | "RECONCILIATION_BASELINE_MISSING"
        | "RECONCILIATION_PROVIDER_BINDING_MISSING";
    };

export type UsableHistoricalReconciliationAuthority = {
  kind: "usable_authority";
  action: CurrentAction;
  expectedEffect: ExpectedEffect;
};
export type HistoricalReconciliationAuthority =
  | Exclude<HistoricalOperationAuthority, { kind: "usable_authority" }>
  | UsableHistoricalReconciliationAuthority;

/**
 * Durable authoring JSON predates the current TypeScript process. Parse it at
 * the recovery boundary; never reconstruct or coerce historical mutation truth.
 */
export function classifyHistoricalOperationAuthority(value: unknown): HistoricalOperationAuthority {
  if (value === null || value === undefined) {
    return { kind: "malformed_authority", reasonCode: "RECONCILIATION_ACTION_MISSING" };
  }
  const parsed = currentActionSchema.safeParse(value);
  if (parsed.success) return { kind: "usable_authority", action: parsed.data };
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  ) {
    return {
      kind: "unsupported_historical_authority",
      reasonCode: "RECONCILIATION_ACTION_UNSUPPORTED",
    };
  }
  return { kind: "malformed_authority", reasonCode: "RECONCILIATION_ACTION_MALFORMED" };
}

/** Validate every durable fact required to perform observation-only reconciliation. */
export function classifyHistoricalReconciliationAuthority(input: {
  action: unknown;
  expectedEffect: unknown;
  baseline: unknown;
  localEvidence: unknown;
}): HistoricalReconciliationAuthority {
  const action = classifyHistoricalOperationAuthority(input.action);
  if (action.kind !== "usable_authority") return action;
  const expectedEffect = expectedEffectSchema.safeParse(input.expectedEffect);
  if (!expectedEffect.success)
    return {
      kind: "insufficient_reconciliation_authority",
      reasonCode: "RECONCILIATION_EXPECTED_EFFECT_MALFORMED",
    };
  if (expectedEffect.data.type !== "none" && input.baseline === null)
    return {
      kind: "insufficient_reconciliation_authority",
      reasonCode: "RECONCILIATION_BASELINE_MISSING",
    };
  if (
    typeof input.localEvidence === "object" &&
    input.localEvidence !== null &&
    "activeBinding" in input.localEvidence &&
    !(input.localEvidence as { activeBinding?: unknown }).activeBinding
  )
    return {
      kind: "insufficient_reconciliation_authority",
      reasonCode: "RECONCILIATION_PROVIDER_BINDING_MISSING",
    };
  return { kind: "usable_authority", action: action.action, expectedEffect: expectedEffect.data };
}
