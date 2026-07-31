import type { TestPlan } from "./plan.js";
import type { ExecutionPolicyV1 } from "./policy.js";

export type PolicyViolation = {
  code: "ORIGIN_NOT_ALLOWED" | "ACTION_BUDGET_EXCEEDED" | "DURATION_BUDGET_EXCEEDED" | "NAVIGATION_BUDGET_EXCEEDED";
  message: string;
};

export type PlanRiskDiagnostic = {
  severity: "error" | "warning";
  code:
    | "FINAL_EVIDENCE_WITHOUT_READINESS"
    | "UNSETTLED_TERMINAL_ACTION"
    | "UNSETTLED_EVIDENCE_CAPTURE"
    | "NAVIGATION_CONTROL_IS_NOT_DESTINATION_PROOF"
    | "TRANSIENT_CAPTURE_USED_AS_PROOF"
    | "READINESS_EXCEEDS_RUN_BUDGET"
    | "FIXED_DELAY_READINESS"
    | "TECHNICAL_READINESS_ONLY"
    | "BROAD_SELECTOR"
    | "READINESS_CONSUMES_RUN_BUDGET"
    | "SECRET_CAPTURE_SCREENSHOT_RISK";
  message: string;
  suggestion: string;
  stepId: string;
};

export function analyzePlanRisks(plan: TestPlan): {
  errors: PlanRiskDiagnostic[];
  warnings: PlanRiskDiagnostic[];
} {
  if (plan.protocolVersion === "1") return { errors: [], warnings: [] };
  const diagnostics: PlanRiskDiagnostic[] = [];
  const usesProtectedValues = plan.steps.some((step) =>
    step.action.type === "captureSecret"
    || (step.action.type === "fill" && Boolean(step.action.secretRef || step.action.capturedSecretRef))
  );
  let unsettledReactionStep: string | undefined;
  const reactionTypes = new Set(["navigate", "click", "press", "select", "check"]);
  for (const [index, step] of plan.steps.entries()) {
    if (usesProtectedValues && (step.action.type === "screenshot" || step.evidence.includes("screenshot"))) {
      diagnostics.push(error(
        "SECRET_CAPTURE_SCREENSHOT_RISK",
        step.id,
        "Screenshots are unsafe in a run that displays or enters a protected value because pixels cannot be reliably redacted.",
        "Remove screenshot actions and screenshot evidence from this Flow. Scry automatically disables video and trace for protected-value runs and redacts textual evidence.",
      ));
    }
    const isReaction = reactionTypes.has(step.action.type);
    const capturesFinalEvidence =
      step.captureIntent === "final"
      && (step.evidence.includes("screenshot") || step.evidence.includes("dom"));
    const isExplicitCapture = step.action.type === "screenshot";
    if (isReaction) unsettledReactionStep = step.id;

    if (isReaction && capturesFinalEvidence && !step.after) {
      diagnostics.push(error(
        "FINAL_EVIDENCE_WITHOUT_READINESS",
        step.id,
        "Final evidence would be captured immediately after an action that may render asynchronously.",
        "Add an after condition describing the destination state, or explicitly mark the capture transient with a justification.",
      ));
    }
    if (isExplicitCapture && unsettledReactionStep && step.captureIntent === "final") {
      diagnostics.push(error(
        "UNSETTLED_EVIDENCE_CAPTURE",
        step.id,
        `Final evidence follows unsettled reaction step "${unsettledReactionStep}".`,
        "Add readiness to the reaction step before capturing final evidence.",
      ));
    }
    if (index === plan.steps.length - 1 && isReaction && step.captureIntent === "final" && !step.after) {
      diagnostics.push(error(
        "UNSETTLED_TERMINAL_ACTION",
        step.id,
        "The journey ends before Scry can establish that the application finished reacting.",
        "Add semantic readiness for the completed destination state.",
      ));
    }
    if (step.captureIntent === "transient" && step.assertions.length > 0) {
      diagnostics.push(error(
        "TRANSIENT_CAPTURE_USED_AS_PROOF",
        step.id,
        "A deliberately transient capture cannot be used as completed-state proof.",
        "Move assertions to a later final step with readiness, or remove them from the transient capture.",
      ));
    }
    if (step.after) {
      unsettledReactionStep = undefined;
      if (step.after.timeoutMs > plan.budgets.maxDurationMs) {
        diagnostics.push(error(
          "READINESS_EXCEEDS_RUN_BUDGET",
          step.id,
          "The readiness timeout exceeds the complete run duration budget.",
          "Reduce the readiness timeout or increase the run duration budget within policy.",
        ));
      } else if (step.after.timeoutMs >= plan.budgets.maxDurationMs * 0.75) {
        diagnostics.push(warning(
          "READINESS_CONSUMES_RUN_BUDGET",
          step.id,
          "This readiness timeout can consume most of the run budget.",
          "Leave enough time for later actions, assertions, stabilization, and evidence capture.",
        ));
      }
      if (step.after.conditions.some((condition) => condition.type === "delay")) {
        diagnostics.push(warning(
          "FIXED_DELAY_READINESS",
          step.id,
          "A fixed delay cannot prove that the application is ready.",
          "Prefer visible text, populated content, URL change, loader disappearance, or a completed request.",
        ));
      }
      if (step.after.conditions.every((condition) => ["domStable", "networkQuiet", "delay"].includes(condition.type))) {
        diagnostics.push(warning(
          "TECHNICAL_READINESS_ONLY",
          step.id,
          "Only technical settling is configured; a stable page can still show the wrong result.",
          "Add at least one semantic readiness condition tied to expected application content.",
        ));
      }
      const actionTarget = step.action.type === "click" ? step.action.target : undefined;
      if (actionTarget && step.after.conditions.some((condition) =>
        "target" in condition && JSON.stringify(condition.target) === JSON.stringify(actionTarget))
      ) {
        diagnostics.push(error(
          "NAVIGATION_CONTROL_IS_NOT_DESTINATION_PROOF",
          step.id,
          "The control used to start navigation is also being used as proof that destination content rendered.",
          "Wait for content that exists only in the destination, such as its heading, form, or operation controls.",
        ));
      }
    }
    const locators = [
      ...(step.action.type !== "navigate" && step.action.type !== "scroll" && step.action.type !== "screenshot" && step.action.type !== "press" ? [step.action.target] : []),
      ...(step.after?.conditions.flatMap((condition) => "target" in condition ? [condition.target] : []) ?? []),
    ];
    if (locators.some((locator) => locator.strategy === "css" && ["*", "body", "html"].includes(locator.value.trim()))) {
      diagnostics.push(warning(
        "BROAD_SELECTOR",
        step.id,
        "A broad selector can match before the intended content is ready.",
        "Target the smallest stable container or use user-visible text and roles.",
      ));
    }
  }
  return {
    errors: diagnostics.filter((item) => item.severity === "error"),
    warnings: diagnostics.filter((item) => item.severity === "warning"),
  };
}

function error(code: PlanRiskDiagnostic["code"], stepId: string, message: string, suggestion: string): PlanRiskDiagnostic {
  return { severity: "error", code, stepId, message, suggestion };
}

function warning(code: PlanRiskDiagnostic["code"], stepId: string, message: string, suggestion: string): PlanRiskDiagnostic {
  return { severity: "warning", code, stepId, message, suggestion };
}

export function validatePlanAgainstPolicy(
  plan: TestPlan,
  policy: ExecutionPolicyV1,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const policyOrigins = new Set(policy.allowedOrigins.map((value) => new URL(value).origin));

  for (const origin of plan.allowedOrigins) {
    if (!policyOrigins.has(new URL(origin).origin)) {
      violations.push({
        code: "ORIGIN_NOT_ALLOWED",
        message: `Plan origin is not allowed by policy: ${origin}`,
      });
    }
  }
  if (plan.budgets.maxActions > policy.maxActions || plan.steps.length > policy.maxActions) {
    violations.push({
      code: "ACTION_BUDGET_EXCEEDED",
      message: "Plan exceeds the policy action budget",
    });
  }
  if (plan.budgets.maxDurationMs > policy.maxDurationMs) {
    violations.push({
      code: "DURATION_BUDGET_EXCEEDED",
      message: "Plan exceeds the policy duration budget",
    });
  }
  const navigations = plan.steps.filter((step) => step.action.type === "navigate").length;
  if (
    plan.budgets.maxNavigations > policy.maxNavigations ||
    navigations > policy.maxNavigations
  ) {
    violations.push({
      code: "NAVIGATION_BUDGET_EXCEEDED",
      message: "Plan exceeds the policy navigation budget",
    });
  }
  return violations;
}
