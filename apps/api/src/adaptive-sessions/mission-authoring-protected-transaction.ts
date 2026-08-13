import { createHash } from "node:crypto";
import {
  currentPlanSchema,
  protectedTransactionSchema,
  type InteractionTargetIntent,
  type MissionAuthoringIntent,
  type ProtectedTransaction,
} from "@scry/contracts";
import { protectedTransactionDigest } from "@scry/executor";

import { deriveMissionAuthoringTarget } from "./mission-authoring-derivation.js";

type AcquisitionAction = Extract<MissionAuthoringIntent["action"], { kind: "acquire_protected_outputs" }>;

export function compileMissionAuthoringProtectedTransaction(input: {
  operationId: string;
  entryUrl: string;
  action: AcquisitionAction;
  preparation: MissionAuthoringIntent[];
  timeoutMs: number;
  resolvedSyntheticReferences?: Readonly<Record<string, string>>;
}): ProtectedTransaction {
  const inputs: ProtectedTransaction["inputs"] = {};
  const preparationActions: ProtectedTransaction["preparation"]["actions"] = [];
  const assertions: ProtectedTransaction["preparation"]["assertions"] = [];
  const protectedInputTargets: InteractionTargetIntent[] = [];
  for (const intent of input.preparation) {
    const timeoutMs = intent.constraints.timeoutMs;
    switch (intent.action.kind) {
      case "navigate":
        preparationActions.push({ type: "navigate", url: intent.action.url, effect: "read_only", timeoutMs });
        break;
      case "activate":
        preparationActions.push({ type: "clickNavigation", target: target(intent, intent.action.target, ["focusable", "pointer_activatable"]), expectedEffect: { type: "none" }, effect: "read_only", timeoutMs });
        break;
      case "fill": {
        const key = `input_${createHash("sha256").update(intent.intentId).digest("hex").slice(0, 16)}`;
        const field = target(intent, intent.action.target, ["focusable", "accepts_text", "editable", "readable_value"]);
        const protectedReference = intent.action.protectedReferenceId ?? input.resolvedSyntheticReferences?.[intent.intentId];
        if (protectedReference) {
          inputs[key] = { classification: "known_secret", credentialRef: protectedReference };
          preparationActions.push({ type: "fillKnownSecret", input: key, target: field, effect: "replayable_setup", timeoutMs });
          protectedInputTargets.push(field);
        } else {
          inputs[key] = { classification: "public", value: intent.action.publicValue! };
          preparationActions.push({ type: "fillPublicInput", input: key, target: field, effect: "replayable_setup", timeoutMs });
        }
        assertions.push({ type: "fieldValueMatchesInput", target: field, input: key, timeoutMs });
        break;
      }
      case "select": {
        const key = `input_${createHash("sha256").update(intent.intentId).digest("hex").slice(0, 16)}`;
        const field = target(intent, intent.action.target, ["focusable", "selects_option", "readable_value"]);
        inputs[key] = { classification: "public", value: intent.action.value };
        preparationActions.push({ type: "selectPublicInput", input: key, target: field, effect: "replayable_setup", timeoutMs });
        assertions.push({ type: "selectedValueMatchesInput", target: field, input: key, timeoutMs });
        break;
      }
      case "set_checked": {
        const key = `input_${createHash("sha256").update(intent.intentId).digest("hex").slice(0, 16)}`;
        const field = target(intent, intent.action.target, ["focusable", "toggleable"]);
        inputs[key] = { classification: "public", value: intent.action.checked };
        preparationActions.push({ type: "checkPublicInput", input: key, target: field, effect: "replayable_setup", timeoutMs });
        assertions.push({ type: "checkedMatchesInput", target: field, input: key, timeoutMs });
        break;
      }
      case "wait_for":
      case "inspect": {
        const state = intent.action.kind === "wait_for" ? intent.action.state : "visible";
        const semanticTarget = intent.action.target;
        preparationActions.push({ type: "waitFor", target: target(intent, semanticTarget, ["observable"]), state, effect: "read_only", timeoutMs });
        break;
      }
      default:
        throw new Error("MISSION_AUTHORING_PREPARATION_NOT_DETERMINISTIC");
    }
  }
  for (const source of input.action.syntheticProtectedInputs ?? []) {
    const reference = input.resolvedSyntheticReferences?.[`synthetic:${source.semantic}`];
    if (!reference) throw new Error("SYNTHETIC_PROTECTED_INPUT_REFERENCE_UNAVAILABLE");
    const key = `synthetic_${createHash("sha256").update(source.semantic).digest("hex").slice(0, 16)}`;
    const field = targetForAcquisition(source.target, ["focusable", "accepts_text", "editable", "readable_value"]);
    inputs[key] = { classification: "known_secret", credentialRef: reference };
    preparationActions.push({ type: "fillKnownSecret", input: key, target: field, effect: "replayable_setup", timeoutMs: input.timeoutMs });
    assertions.push({ type: "fieldValueMatchesInput", target: field, input: key, timeoutMs: input.timeoutMs });
    protectedInputTargets.push(field);
  }
  if (preparationActions.length === 0) {
    preparationActions.push({
      type: "navigate",
      url: input.entryUrl,
      effect: "read_only",
      timeoutMs: input.timeoutMs,
    });
  }
  const mutationTarget = targetForAcquisition(input.action.mutation.target, ["focusable", "pointer_activatable"]);
  assertions.push({ type: "enabled", target: mutationTarget, timeoutMs: input.timeoutMs });
  const outputs = input.action.outputs.map((output) => {
    const outputTarget = targetForAcquisition(output.target, ["readable_value"]);
    // Output semantics describe the value, not the page's implementation. A generated value may
    // be rendered as a field, static text, a definition value, or a copy-enabled control. Keep the
    // adapter set bounded while allowing the protected extractor to resolve those equivalent shapes.
    const permittedMethods = [
      "semantic_field_value",
      "input_value",
      "text_content",
      "copy_control",
      "protected_network_value",
    ] as const;
    return output.classification === "protected"
      ? { classification: "protected" as const, reference: output.reference, acquisition: { target: outputTarget, prohibitedSourceTargets: protectedInputTargets, classification: "unknown_secret" as const, permittedMethods: [...permittedMethods], objective: { kind: "capture_value" as const, expectedValueType: "unknown_secret" as const }, validation: { minimumLength: 1, maximumLength: 20_000 } }, storage: { credentialName: output.storageName, scope: "project" as const } }
      : { classification: "public" as const, reference: output.reference, acquisition: { target: outputTarget, prohibitedSourceTargets: protectedInputTargets, classification: "public" as const, permittedMethods: [...permittedMethods], objective: { kind: "capture_value" as const, expectedValueType: "public" as const }, validation: { minimumLength: 1, maximumLength: 20_000 } }, storage: { name: output.storageName, scope: "project" as const } };
  });
  const capabilityDigest = digest(JSON.stringify(mutationTarget.requiredCapabilities));
  const transaction = protectedTransactionSchema.parse({
    type: "protectedTransaction",
    operationId: input.operationId,
    entry: { url: input.entryUrl, assertions: [{ type: "url", expected: input.entryUrl, match: "exact", timeoutMs: input.timeoutMs }] },
    inputs,
    preparation: { actions: preparationActions, assertions, effectPolicy: { ignoredRequests: [] } },
    mutation: {
      action: { type: "click", target: mutationTarget, expectedEffect: { type: "none" }, timeoutMs: input.timeoutMs },
      kind: input.action.mutation.kind === "read_only" ? "repeatable" : "one_time",
      dispatchSemantics: input.action.mutation.kind === "read_only" ? "read_only" : "mutation",
      ...(input.action.request ? { request: input.action.request } : {}),
      ...(input.action.response ? { response: input.action.response } : {}),
      reconciliation: { strategy: "persisted_outputs", requiredReferences: outputs.map((output) => output.reference) },
    },
    extraction: {
      outputs,
      externalResourceBindings: input.action.externalResourceBindings ?? [],
      timeoutMs: input.timeoutMs,
      scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: {
      ceremonyIntent: mutationTarget,
      expectedContainerModel: { version: 2, digest: digest(JSON.stringify(mutationTarget)), concept: mutationTarget.concept, scopeKind: mutationTarget.scope.kind, capabilityDigest, structuralPath: [] },
      valueIntent: outputs[0]!.acquisition.target,
      approvedMethods: [...new Set(outputs.flatMap((output) => output.acquisition.permittedMethods))],
      minimumConfidence: 0.5,
      minimumConfidenceMargin: 0,
      recoveryPolicy: "secure_assistance",
      recoveryWindowMs: 60_000,
    },
    continuation: { strategies: [{ mode: "resume_parked_context", reentryUrl: input.entryUrl, assertions: [{ type: "url", expected: input.entryUrl, match: "exact", timeoutMs: input.timeoutMs }], continueAtStepId: `${input.operationId}-continued` }] },
  });
  currentPlanSchema.parse(executablePlanFor(transaction));
  return transaction;
}

export function missionAuthoringProtectedOperationReservation(
  transaction: ProtectedTransaction,
  allowedOrigins: string[],
) {
  return {
    mutationIdentity: transaction.operationId,
    dispatchSemantics: transaction.mutation.dispatchSemantics ?? "mutation",
    programDigest: protectedTransactionDigest(transaction, allowedOrigins),
    safeOutputManifest: transaction.extraction.outputs.map((output) => ({
      reference: output.reference,
      classification: output.classification,
      storageName:
        output.classification === "protected"
          ? output.storage.credentialName
          : output.storage.name,
    })),
  };
}

function executablePlanFor(transaction: ProtectedTransaction) {
  const origin = new URL(transaction.entry.url).origin;
  const continuationSteps = transaction.continuation.strategies.flatMap((strategy) => {
    if (!("continueAtStepId" in strategy)) return [];
    return [{
      id: strategy.continueAtStepId,
      title: "Resume after protected interaction",
      action: { type: "navigate" as const, url: strategy.reentryUrl, timeoutMs: 10_000 },
      assertions: [], onFailure: "stop" as const, evidence: [],
      captureIntent: "transient" as const,
      transientJustification: "Protected continuation contract boundary.",
    }];
  });
  return {
    name: "Mission authoring protected operation",
    objective: "Execute one bounded protected authoring operation",
    preconditions: [], allowedOrigins: [origin],
    budgets: { maxActions: 1 + continuationSteps.length, maxDurationMs: 120_000, maxNavigations: 1 + continuationSteps.length },
    checkpoints: [],
    steps: [{
      id: "protected-operation", title: "Protected operation", action: transaction,
      assertions: [], onFailure: "stop" as const, evidence: [],
      captureIntent: "transient" as const,
      transientJustification: "Protected authoring operation contract boundary.",
    }, ...continuationSteps],
  };
}

function target(intent: MissionAuthoringIntent, semanticTarget: Parameters<typeof deriveMissionAuthoringTarget>[0], capabilities: InteractionTargetIntent["requiredCapabilities"]) {
  const established = deriveMissionAuthoringTarget(
    semanticTarget,
    intent.constraints.allowNonExact,
    intent.authorization.kind,
    capabilities,
  );
  return {
    ...established,
    confidence: {
      ...established.confidence,
      // These targets already completed authoring admission and execution. Replay must retain
      // uniqueness while avoiding first-discovery thresholds inside the isolated capsule.
      minimum: 0.35,
      minimumMargin: 0.05,
      minimumFamilyCount: 1,
    },
  };
}

function targetForAcquisition(semanticTarget: Parameters<typeof deriveMissionAuthoringTarget>[0], capabilities: InteractionTargetIntent["requiredCapabilities"]) {
  return deriveMissionAuthoringTarget(semanticTarget, false, "protected_mutation", capabilities);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
