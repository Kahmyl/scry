import { createHash } from "node:crypto";

import {
  learnedInteractionRecordSchema,
  type CurrentAction,
  type CurrentPlan,
  type LearnedInteractionRecord,
  type PraxisResult,
} from "@scry/contracts";

export function learnedInteractionsFromPraxis(
  plan: CurrentPlan,
  results: PraxisResult[],
  context: { veilEvidenceClosed: boolean },
): LearnedInteractionRecord[] {
  const steps = new Map(plan.steps.map((step) => [step.id, step]));

  return results.flatMap((result) => {
    if (result.status !== "succeeded" || !result.stepId) return [];
    const step = steps.get(result.stepId);
    if (!step) return [];
    return learnedInteractionsFromAction(step.action, [result], step.id, context);
  });
}

export function learnedInteractionsFromAction(
  action: CurrentAction,
  results: PraxisResult[],
  stepId?: string,
  context: { veilEvidenceClosed: boolean } = { veilEvidenceClosed: false },
): LearnedInteractionRecord[] {
  const target = targetOf(action);
  if (!target) return [];

  return results.flatMap((result) => {
    if (result.status !== "succeeded") return [];
    const expectedEffect = expectedEffectOf(action);
    const expectedEffectVerified =
      result.verification.effect === "passed" || result.verification.effect === "not_required";
    if (
      !expectedEffectVerified ||
      result.mutationOutcome === "unknown" ||
      !context.veilEvidenceClosed
    )
      return [];

    const evidenceFamilies = new Set(result.resolution.evidenceFamilies);
    if (result.verification.effect === "passed") evidenceFamilies.add("effect");

    return [
      learnedInteractionRecordSchema.parse({
        schemaVersion: 1,
        interactionId: result.transactionId,
        stepId: stepId ?? result.stepId,
        intent: target,
        operation: safeOperation(action),
        functionalResult: "passed",
        mutationOutcome: result.mutationOutcome,
        successfulEvidenceFamilies: [...evidenceFamilies],
        scope: target.scope,
        relationships: target.relations,
        capabilityProfile: {
          requiredCapabilities: target.requiredCapabilities,
          adapter: result.resolution.strategy,
        },
        expectedEffect,
        sanitizedFingerprint: {
          fingerprint: result.resolution.target.fingerprint,
          concept: result.resolution.target.concept,
          scopeKind: result.resolution.target.scopeKind,
          capabilityDigest: result.resolution.target.capabilityDigest,
          digest: digest({
            intent: result.report.intentDigest,
            target: result.resolution.target.fingerprint,
            operation: safeOperation(action),
            expectedEffect,
          }),
        },
        qualityFindings: result.qualityFindings,
        usedSelectorHint: false,
        unresolvedMutation: false,
        veilPolicyViolated: false,
        veilEvidenceClosed: context.veilEvidenceClosed,
        expectedEffectVerified: true,
        deterministic: true,
      }),
    ];
  });
}

function targetOf(action: CurrentAction) {
  return "target" in action ? action.target : undefined;
}

function expectedEffectOf(action: CurrentAction): Record<string, unknown> {
  return "expectedEffect" in action ? action.expectedEffect : { type: "none" };
}

function safeOperation(action: CurrentAction): Record<string, unknown> {
  switch (action.type) {
    case "click":
      return { type: "activate" };
    case "fill":
      return {
        type: "enter_text",
        classification:
          action.secretRef || action.capturedSecretRef
            ? "known_secret"
            : action.capturedValueRef
              ? "captured_public"
              : "public",
      };
    case "select":
      return { type: "select_option" };
    case "check":
      return { type: "set_checked", checked: action.checked };
    case "press":
      return { type: "press_key", key: action.key };
    case "scroll":
      return { type: "scroll", direction: action.deltaY >= 0 ? "down" : "up" };
    case "waitFor":
      return { type: "wait_for_state", state: action.state };
    default:
      return { type: action.type };
  }
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
