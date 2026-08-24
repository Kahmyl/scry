import { describe, expect, it } from "vitest";

import { RECOVERY_PRECEDENCE, resolveRecoveryBoundary } from "../src/recovery/recovery-registry.js";

describe("typed recovery registry", () => {
  const environment = {
    environmentId: "66666666-6666-4666-8666-666666666666",
    allowedOrigins: ["https://app.example.test"],
    trustedScriptOrigins: [],
    allowPopups: false,
  };

  it("publishes one explicit precedence order", () => {
    expect(RECOVERY_PRECEDENCE).toEqual([
      "environment_trusted_script",
      "environment_navigation",
      "environment_popup",
      "explicit_boundary",
      "mutation_unknown",
      "effect_observation",
      "objective_completed",
      "fallback",
    ]);
  });

  it("prioritizes exact environment recovery over generic effect recovery", () => {
    const result = resolveRecoveryBoundary(
      {
        reasonCode: "EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED",
        mutationOutcome: "applied",
        functionalResult: "failed",
        navigationEnvironmentFailure: {
          missingAllowedOrigin: "https://docs.example.test",
        },
        nextDecisionBoundary: {
          type: "effect_observation_required",
          reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
          safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
        },
      } as never,
      environment as never,
    );

    expect(result).toMatchObject({
      type: "environment_unavailable",
      reasonCode: "EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED",
      safeActions: ["create_test_environment", "create_flow_draft"],
      navigationRecovery: {
        environmentId: environment.environmentId,
        missingAllowedOrigin: "https://docs.example.test",
        currentAllowedOrigins: environment.allowedOrigins,
        requiresNewFlowDraftAndAuthoringSession: true,
      },
    });
  });

  it("projects popup denial as factual replacement-environment recovery", () => {
    const result = resolveRecoveryBoundary(
      {
        reasonCode: "POPUP_NOT_ALLOWED",
        mutationOutcome: "not_applied",
        functionalResult: "failed",
        nextDecisionBoundary: {
          type: "environment_unavailable",
          reasonCode: "POPUP_NOT_ALLOWED",
          safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
        },
      } as never,
      environment as never,
    );

    expect(result).toMatchObject({
      type: "environment_unavailable",
      reasonCode: "POPUP_NOT_ALLOWED",
      safeActions: ["create_test_environment", "create_flow_draft"],
      popupRecovery: {
        environmentId: environment.environmentId,
        currentAllowPopups: false,
        requiredAllowPopups: true,
        currentAllowedOrigins: environment.allowedOrigins,
        requiresNewFlowDraftAndAuthoringSession: true,
      },
    });
  });

  it("keeps UNKNOWN behind reconciliation rather than redispatch", () => {
    expect(
      resolveRecoveryBoundary(
        {
          mutationOutcome: "unknown",
          functionalResult: "failed",
        } as never,
        environment as never,
      ),
    ).toMatchObject({
      type: "mutation_reconciliation_required",
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_run", "get_praxis_session", "reconcile_unknown_operation"],
    });
  });

  it("preserves an upstream factual boundary when no stronger recovery applies", () => {
    const explicit = {
      type: "effect_observation_required",
      reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
      safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
    };

    expect(
      resolveRecoveryBoundary(
        {
          mutationOutcome: "applied",
          functionalResult: "failed",
          nextDecisionBoundary: explicit,
        } as never,
        environment as never,
      ),
    ).toEqual(explicit);
  });
});
