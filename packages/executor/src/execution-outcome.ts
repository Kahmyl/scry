import type { ExecutionReport, PolicyViolationRecord, StepExecutionResult } from "./types.js";

export function classifyOutcome(
  state: ExecutionReport["state"],
  steps: StepExecutionResult[],
  policyViolations: PolicyViolationRecord[],
): ExecutionReport["outcomeClassification"] {
  if (state === "cancelled") return "cancelled";
  if (state === "timed_out") return "execution_timeout";
  if (state === "infrastructure_error") return "infrastructure_failure";
  if (policyViolations.some((item) => item.disposition === "fatal")) return "policy_failure";
  if (steps.some((step) => isAmbiguousTargetError(step.error))) return "inconclusive_plan";
  if (steps.some((step) => step.readiness?.status === "failed")) return "readiness_timeout";
  if (steps.some((step) => step.assertions.some((assertion) => assertion.status === "failed")))
    return "assertion_failure";
  if (steps.some((step) => step.status === "failed" && step.error)) return "inconclusive_plan";
  const evaluatedAssertions = steps
    .flatMap((step) => step.assertions)
    .filter((assertion) => assertion.status !== "unevaluated");
  const configuredReadiness = steps.some((step) => step.readiness?.status === "passed");
  const finalEvidence = steps.some((step) =>
    step.artifacts.some((artifact) => artifact.observation?.captureIntent === "final"),
  );
  const transientEvidence = steps.some((step) =>
    step.artifacts.some((artifact) => artifact.observation?.captureIntent === "transient"),
  );
  if (transientEvidence && !finalEvidence && evaluatedAssertions.length === 0)
    return "transient_observation";
  if (state === "passed" && evaluatedAssertions.length === 0 && !configuredReadiness)
    return "inconclusive_plan";
  return state === "passed" ? "passed" : "inconclusive_plan";
}

function isAmbiguousTargetError(error?: string) {
  return Boolean(
    error &&
    (error.includes("Target is ambiguous:") ||
      error.includes("strict mode violation") ||
      /resolved to \d+ elements/i.test(error)),
  );
}
