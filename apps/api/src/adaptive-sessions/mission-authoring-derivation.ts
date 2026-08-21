import { createHash } from "node:crypto";
import type {
  CurrentAction,
  ExpectedEffect,
  ExecutionMode,
  InteractionTargetIntent,
  MissionAuthoringIntent,
  MissionAuthoringSemanticTarget,
  ProtectedTransaction,
} from "@scry/contracts";

export function deriveMissionAuthoringOperation(input: {
  turnId: string;
  intent: MissionAuthoringIntent;
  protectedTransaction?: ProtectedTransaction;
}): {
  operationId: string;
  idempotencyKey: string;
  action: CurrentAction;
  expectedEffect: ExpectedEffect;
  mode: ExecutionMode;
} {
  const { intent } = input;
  const identity = missionAuthoringOperationIdentity(input.turnId, intent.intentId);
  const target = (
    target: MissionAuthoringSemanticTarget,
    requiredCapabilities: InteractionTargetIntent["requiredCapabilities"],
  ) =>
    deriveTarget(
      target,
      intent.constraints.allowNonExact,
      intent.authorization.kind,
      requiredCapabilities,
    );
  const action: CurrentAction = (() => {
    switch (intent.action.kind) {
      case "navigate":
        return {
          type: "navigate",
          url: intent.action.url,
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "activate":
        return {
          type: "click",
          target: target(intent.action.target, ["focusable", "pointer_activatable"]),
          expectedEffect: deriveEffect(intent.expectedEffect, target),
          dispatchSemantics:
            intent.action.semanticEffect === "read_context_transition" ? "read_only" : "mutation",
          ...(intent.action.activationMechanism
            ? { activationMechanism: intent.action.activationMechanism }
            : {}),
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "fill":
        return intent.action.protectedReferenceId
          ? {
              type: "fill",
              target: target(intent.action.target, ["focusable", "accepts_text", "editable"]),
              secretRef: intent.action.protectedReferenceId,
              timeoutMs: intent.constraints.timeoutMs,
            }
          : {
              type: "fill",
              target: target(intent.action.target, ["focusable", "accepts_text", "editable"]),
              value: intent.action.publicValue!,
              timeoutMs: intent.constraints.timeoutMs,
            };
      case "authenticate":
        return {
          type: "protectedAuthentication",
          fields: intent.action.fields.map((field) => ({
            target: target(field.target, ["focusable", "accepts_text", "editable"]),
            secretRef: field.protectedReferenceId,
          })),
          submitTarget: target(intent.action.submitTarget, ["focusable", "pointer_activatable"]),
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "select":
        return {
          type: "select",
          target: target(intent.action.target, ["focusable", "selects_option"]),
          value: intent.action.value,
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "set_checked":
        return {
          type: "check",
          target: target(intent.action.target, ["focusable", "toggleable"]),
          checked: intent.action.checked,
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "press":
        return {
          type: "press",
          ...(intent.action.target
            ? { target: target(intent.action.target, ["focusable", "keyboard_activatable"]) }
            : {}),
          key: intent.action.key,
          dispatchSemantics:
            intent.action.semanticEffect === "read_context_transition" ? "read_only" : "mutation",
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "wait_for":
        return {
          type: "waitFor",
          target: target(intent.action.target, ["observable"]),
          state: intent.action.state,
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "inspect":
        return {
          type: "waitFor",
          target: target(intent.action.target, ["observable"]),
          state: "visible",
          timeoutMs: intent.constraints.timeoutMs,
        };
      case "acquire_protected_outputs": {
        if (!input.protectedTransaction)
          throw new Error("MISSION_AUTHORING_PROTECTED_TRANSACTION_REQUIRED");
        return input.protectedTransaction;
      }
      case "same_origin_request":
        return {
          type: "sameOriginRequest",
          method: intent.action.method,
          path: intent.action.path,
          ...(intent.action.body ? { body: intent.action.body } : {}),
          expectedStatus: intent.action.expectedStatus,
          authentication: intent.action.authentication,
          timeoutMs: intent.constraints.timeoutMs,
        };
    }
  })();
  return {
    ...identity,
    action,
    expectedEffect: deriveEffect(intent.expectedEffect, target),
    mode: deriveMode(intent.authorization.kind),
  };
}

export function missionAuthoringOperationIdentity(turnId: string, intentId: string) {
  return {
    operationId: `m2-${digest(`${turnId}:${intentId}`).slice(0, 40)}`,
    idempotencyKey: `m2-${digest(`${turnId}:${intentId}:operation`).slice(0, 48)}`,
  };
}

export function deriveMissionAuthoringTarget(
  target: MissionAuthoringSemanticTarget,
  allowNonExact: boolean,
  authorization: MissionAuthoringIntent["authorization"]["kind"],
  requiredCapabilities: InteractionTargetIntent["requiredCapabilities"],
): InteractionTargetIntent {
  const role = target.role ? [target.role] : [];
  const names = target.name ? [target.name] : [];
  const labels = target.label ? [target.label] : [];
  const placeholders = target.placeholder ? [target.placeholder] : [];
  const text = target.text;
  return {
    concept: target.concept,
    ...(target.reference ? { authoritativeReference: target.reference } : {}),
    requiredCapabilities,
    preferredEvidence: {
      roles: role,
      names,
      labels,
      descriptions: [],
      placeholders,
      inputTypes: [],
      testIds: target.testId ? [target.testId] : [],
      ...(text ? { expectedText: text } : {}),
    },
    scope: target.scope
      ? {
          kind: target.scope.kind,
          ...(target.scope.name ? { name: target.scope.name } : {}),
          ...(target.scope.direct !== undefined ? { direct: target.scope.direct } : {}),
        }
      : { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk:
      authorization === "authentication"
        ? "authentication"
        : authorization === "protected_mutation"
          ? "protected"
          : authorization.startsWith("live")
            ? "live"
            : "ordinary",
    confidence: { requiredFamilies: [] },
    matching: allowNonExact && target.exact === false ? "non_exact" : "exact",
  };
}

const deriveTarget = deriveMissionAuthoringTarget;

function deriveEffect(
  effect: MissionAuthoringIntent["expectedEffect"],
  target: (
    input: MissionAuthoringSemanticTarget,
    capabilities: InteractionTargetIntent["requiredCapabilities"],
  ) => InteractionTargetIntent,
): ExpectedEffect {
  switch (effect.kind) {
    case "none":
      return { type: "none" };
    case "navigation":
      return {
        type: "navigation",
        ...(effect.url || effect.urlPattern ? { url: effect.url ?? effect.urlPattern } : {}),
        match: effect.match,
      };
    case "target_visibility":
      return {
        type: "visibility_change",
        target: target(effect.target, ["observable"]),
        visible: effect.visible,
      };
    case "target_value":
      return {
        type: "value_change",
        target: target(effect.target, ["readable_value"]),
        ...(effect.expected ? { expected: effect.expected } : {}),
      };
    case "target_state": {
      const capabilities: InteractionTargetIntent["requiredCapabilities"] = [];
      if (effect.checked !== undefined) capabilities.push("toggleable");
      if (effect.enabled !== undefined) capabilities.push("observable");
      return {
        type: "state_change",
        target: target(effect.target, capabilities),
        ...(effect.checked === undefined ? {} : { checked: effect.checked }),
        ...(effect.enabled === undefined ? {} : { enabled: effect.enabled }),
      };
    }
    case "new_page":
      return { type: "new_page", ...(effect.origin ? { origin: effect.origin } : {}) };
  }
}

function deriveMode(kind: MissionAuthoringIntent["authorization"]["kind"]): ExecutionMode {
  return ["live_mutation", "protected_mutation"].includes(kind)
    ? "transact"
    : kind === "live_read"
      ? "observe"
      : "rehearse";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
