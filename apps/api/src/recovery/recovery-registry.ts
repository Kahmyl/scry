import type { AgentDecisionBoundary, OperationOutcome } from "@scry/contracts";

export const RECOVERY_PRECEDENCE = [
  "environment_trusted_script",
  "environment_navigation",
  "environment_popup",
  "explicit_boundary",
  "mutation_unknown",
  "effect_observation",
  "objective_completed",
  "fallback",
] as const;

export type RecoveryRuleId = (typeof RECOVERY_PRECEDENCE)[number];

export function resolveRecoveryBoundary(
  outcome: OperationOutcome,
  environment?: {
    environmentId: string;
    allowedOrigins: string[];
    trustedScriptOrigins: string[];
    allowPopups: boolean;
  },
): AgentDecisionBoundary {
  if (outcome.reasonCode === "ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED") {
    return {
      type: "environment_unavailable",
      reasonCode: outcome.reasonCode,
      safeActions: ["create_test_environment", "create_flow_draft"],
      ...(environment && outcome.environmentFailure
        ? {
            environmentRecovery: {
              environmentId: environment.environmentId,
              missingTrustedScriptOrigins: outcome.environmentFailure.missingTrustedScriptOrigins,
              missingOriginClassification: outcome.environmentFailure.missingOriginClassification,
              currentTrustedScriptOrigins: environment.trustedScriptOrigins,
              recoveryTool: "create_test_environment" as const,
              requiresNewFlowDraftAndAuthoringSession: true as const,
            },
          }
        : {}),
    };
  }
  if (
    outcome.reasonCode === "EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED" &&
    environment &&
    outcome.navigationEnvironmentFailure
  ) {
    return {
      type: "environment_unavailable",
      reasonCode: outcome.reasonCode,
      safeActions: ["create_test_environment", "create_flow_draft"],
      navigationRecovery: {
        environmentId: environment.environmentId,
        missingAllowedOrigin: outcome.navigationEnvironmentFailure.missingAllowedOrigin,
        currentAllowedOrigins: environment.allowedOrigins,
        recoveryTools: ["create_test_environment", "create_flow_draft"],
        requiresNewFlowDraftAndAuthoringSession: true,
      },
    };
  }
  if (outcome.reasonCode === "POPUP_NOT_ALLOWED" && environment && !environment.allowPopups) {
    return {
      type: "environment_unavailable",
      reasonCode: outcome.reasonCode,
      safeActions: ["create_test_environment", "create_flow_draft"],
      popupRecovery: {
        environmentId: environment.environmentId,
        currentAllowPopups: false,
        requiredAllowPopups: true,
        currentAllowedOrigins: environment.allowedOrigins,
        recoveryTools: ["create_test_environment", "create_flow_draft"],
        requiresNewFlowDraftAndAuthoringSession: true,
      },
    };
  }
  if (outcome.nextDecisionBoundary) return outcome.nextDecisionBoundary;
  if (outcome.mutationOutcome === "unknown") {
    return {
      type: "mutation_reconciliation_required",
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_run", "get_praxis_session", "reconcile_unknown_operation"],
    };
  }
  if (outcome.mutationOutcome === "applied" && outcome.functionalResult !== "succeeded") {
    return {
      type: "effect_observation_required",
      reasonCode: outcome.reasonCode ?? "EXPECTED_EFFECT_NOT_OBSERVED",
      safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
    };
  }
  return outcome.functionalResult === "succeeded"
    ? { type: "objective_completed", reasonCode: "OPERATION_COMPLETED", safeActions: [] }
    : {
        type: "environment_unavailable",
        reasonCode: outcome.reasonCode ?? "ADAPTIVE_OPERATION_FAILED",
        safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
      };
}
