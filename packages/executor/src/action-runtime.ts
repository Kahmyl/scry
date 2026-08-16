import { randomUUID } from "node:crypto";

import type { CurrentAction, RunEvent } from "@scry/contracts";
import {
  executePraxisConsumer,
  authenticateProtectedReferencedTargets,
  pressPageKey,
  PraxisConsumerError,
  wheelPage,
  type PraxisConsumerInput,
  type PraxisConsumerContext,
} from "@scry/praxis";
import type { SecretRedactor } from "@scry/policy";
import type { VeilRuntimeCoordinator } from "@scry/veil";
import type { Page } from "playwright";

import { capturePublicGeneratedValue } from "./public-value-capture.js";
import type { ExecuteOptions } from "./types.js";
import { navigateAndWaitNative } from "@scry/praxis";

export async function executeAction(
  page: Page,
  action: CurrentAction,
  options: ExecuteOptions,
  signal: AbortSignal,
  redactor: SecretRedactor,
  capturedSecrets: Map<string, string>,
  capturedValues: Map<string, string>,
  privacyGate?: VeilRuntimeCoordinator,
  emitEvent?: (type: RunEvent["type"], payload: Record<string, unknown>) => Promise<void>,
  praxisContext?: PraxisConsumerContext,
) {
  throwIfAborted(signal);
  const preDispatchDeadlineAt = actionDeadline(action, praxisContext);
  switch (action.type) {
    case "protectedTransaction":
      throw new InfrastructureDependencyError(
        "Protected transactions must be delegated to ProtectedTransactionKernel",
      );
    case "capturePublicValue": {
      const captured = await capturePublicGeneratedValue(
        page,
        action.capture.acquisition,
        action.capture.timeoutMs,
      );
      capturedValues.set(action.reference, captured.value);
      if (options.publicValueCapture) {
        await options.publicValueCapture({
          operationId: action.operationId,
          reference: action.reference,
          name: action.storage.name,
          value: captured.value,
          scope: action.storage.scope,
        });
      }
      return;
    }
    case "navigate":
      await (options.executeNativeNavigation ?? navigateAndWaitNative)(
        page,
        new URL(action.url, options.plan.allowedOrigins[0]).href,
        options.plan.allowedOrigins,
        action.timeoutMs,
        options.policy.trustedScriptOrigins,
      );
      return;
    case "sameOriginRequest": {
      if (!options.executeSameOriginRequest) {
        throw new InfrastructureDependencyError("SAME_ORIGIN_REQUEST_DRIVER_REQUIRED");
      }
      if (!privacyGate) throw new InfrastructureDependencyError("SAME_ORIGIN_REQUEST_PRIVACY_GATE_REQUIRED");
      const operationId = `browser-session-request-${randomUUID()}`;
      try {
        // Cookie/token access and dispatch are inside the Veil gap; driver callbacks receive
        // only the typed public request and never authenticate material or response bytes.
        await privacyGate.prepare(operationId, {
          mode: "protected_recording_gap",
          videoMaskEstablished: false,
        });
        await privacyGate.beginProtected();
        await options.onPrivacyBoundary?.("entered");
        await options.executeSameOriginRequest(
          page,
          {
            method: action.method, path: action.path, expectedStatus: action.expectedStatus,
            ...(action.body ? { body: action.body } : {}),
            ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
          },
          options.plan.allowedOrigins,
          action.method === "GET"
            ? undefined
            : async () => {
                await options.onMutationDispatch?.();
              },
        );
        await privacyGate.markCaptured();
        await privacyGate.beginSafeBoundary();
        await privacyGate.confirmSafeBoundary({
          kind: "known_safe_navigation",
          urlPattern: exactUrlPattern(page.url()),
        });
        await options.onPrivacyBoundary?.("verified");
      } catch (error) {
        await privacyGate.seal({ code: "SAME_ORIGIN_REQUEST_PRIVACY_FAILED" })
          .then(() => options.onPrivacyBoundary?.("sealed"))
          .catch(() => undefined);
        throw error;
      }
      return;
    }
    case "click":
      await requirePraxisWithNoCapabilityRetry({
        page,
        intent: action.target,
        operation: {
          type: "activate",
          ...(action.activationMechanism ? { mechanism: action.activationMechanism } : {}),
        },
        // Popup ownership is verified by the authoring session/kernel after it adopts
        // a distinct page; Praxis cannot establish that browser-session invariant.
        expectedEffect:
          options.expectedEffectVerificationOwner === "kernel" || action.expectedEffect.type === "new_page"
            ? { type: "none" }
            : action.expectedEffect,
        context: {
          ...praxisContextAt(praxisContext, preDispatchDeadlineAt),
          dispatchSemantics: action.dispatchSemantics ?? "mutation",
        },
        signal,
      });
      return;
    case "fill": {
      let value =
        action.value ??
        (action.capturedValueRef ? capturedValues.get(action.capturedValueRef) : undefined);
      if (value !== undefined && action.capturedValueRef && options.publicValueResolver) {
        value = await options.publicValueResolver(value);
      }
      if (value === undefined && action.generatedValueRef) {
        value = await (options.publicValueResolver ?? missingPublicValueResolver)(
          action.generatedValueRef,
        );
      }
      if (value === undefined && action.capturedSecretRef) {
        const credentialReference = capturedSecrets.get(action.capturedSecretRef);
        if (!credentialReference) throw new Error("PROTECTED_INPUT_REFERENCE_UNAVAILABLE");
        if (!options.secretResolver) throw new Error("PROTECTED_INPUT_RESOLVER_UNAVAILABLE");
        try {
          value = await options.secretResolver(credentialReference);
        } catch (error) {
          throw new InfrastructureDependencyError(
            `Captured credential resolution failed: ${errorMessage(error)}`,
          );
        }
      }
      if (value === undefined && action.secretRef) {
        if (!options.secretResolver) throw new Error("PROTECTED_INPUT_RESOLVER_UNAVAILABLE");
        try {
          value = await options.secretResolver(action.secretRef);
        } catch (error) {
          throw new InfrastructureDependencyError(
            `Protected credential resolution failed: ${errorMessage(error)}`,
          );
        }
      }
      if (value === undefined) throw new Error("PROTECTED_INPUT_REFERENCE_UNAVAILABLE");

      const protectedFill = Boolean(action.secretRef || action.capturedSecretRef);
      if (protectedFill) redactor.add(value);
      if (protectedFill && privacyGate) {
        const operationId = `known-secret-fill-${randomUUID()}`;
        let privacyEntered = false;
        let privacyTransition: Promise<void> | undefined;
        const beginProtectedDispatch = async () => {
          if (!privacyTransition) {
            privacyTransition = (async () => {
              await privacyGate.prepare(operationId, {
                mode: "protected_recording_gap",
                videoMaskEstablished: false,
              });
              await privacyGate.beginProtected();
              privacyEntered = true;
              await options.onPrivacyBoundary?.("entered");
              await options.onMutationDispatch?.();
            })();
          }
          await privacyTransition;
        };
        try {
          await requirePraxisWithNoCapabilityRetry({
            page,
            intent: action.target,
            operation: {
              type: "enter_text",
              input: { reference: "resolved-input", classification: "known_secret" },
            },
            context: {
              ...praxisContextAt(praxisContext, preDispatchDeadlineAt),
              beforeMutation: beginProtectedDispatch,
            },
            signal,
            resolveInput: async () => value!,
          });
          if (!privacyEntered) {
            throw new Error("PROTECTED_FILL_DISPATCH_BOUNDARY_NOT_ENTERED");
          }
          await privacyGate.markCaptured();
          await privacyGate.beginSafeBoundary();
          await privacyGate.confirmSafeBoundary({
            kind: "known_secret_registered",
            referenceType: action.secretRef ? "vault" : "captured",
          });
          await options.onPrivacyBoundary?.("verified");
        } catch (error) {
          const gateState = (privacyGate as VeilRuntimeCoordinator & {
            state?: () => unknown;
          }).state?.();
          if (privacyEntered || (gateState !== undefined && gateState !== "normal")) {
            await privacyGate.seal({ code: "KNOWN_SECRET_FILL_FAILED" })
              .then(() => options.onPrivacyBoundary?.("sealed"))
              .catch(() => undefined);
          }
          throw error;
      }
      } else {
        await requirePraxisWithNoCapabilityRetry({
          page,
          intent: action.target,
          operation: {
            type: "enter_text",
            input: {
              reference: "resolved-input",
              classification: action.capturedValueRef ? "captured_public" : "public",
            },
          },
          context: praxisContextAt(praxisContext, preDispatchDeadlineAt),
          signal,
          resolveInput: async () => value!,
        });
      }
      return;
    }
    case "protectedAuthentication": {
      if (!privacyGate) throw new InfrastructureDependencyError("PROTECTED_AUTHENTICATION_PRIVACY_GATE_REQUIRED");
      if (!options.secretResolver) throw new InfrastructureDependencyError("PROTECTED_INPUT_RESOLVER_UNAVAILABLE");
      const fields: Array<{ targetReference: string; resolveValue: () => Promise<string> }> = [];
      const operationId = `protected-authentication-${randomUUID()}`;
      try {
        for (const field of action.fields) {
          if (!field.target.authoritativeReference)
            throw new Error("PROTECTED_AUTHENTICATION_EXACT_TARGET_REQUIRED");
          fields.push({
            targetReference: field.target.authoritativeReference,
            resolveValue: async () => {
              const value = await options.secretResolver!(field.secretRef);
              redactor.add(value);
              return value;
            },
          });
        }
        if (!action.submitTarget.authoritativeReference)
          throw new Error("PROTECTED_AUTHENTICATION_EXACT_SUBMIT_REQUIRED");
        await privacyGate.prepare(operationId, {
          mode: "protected_recording_gap",
          videoMaskEstablished: false,
        });
        await privacyGate.beginProtected();
        await options.onPrivacyBoundary?.("entered");
        await authenticateProtectedReferencedTargets(page, {
          fields,
          submitReference: action.submitTarget.authoritativeReference,
        }, options.onMutationDispatch);
        await privacyGate.markCaptured();
        await privacyGate.beginSafeBoundary();
        await privacyGate.confirmSafeBoundary({
          kind: "known_secret_registered",
          referenceType: "vault",
        });
        await options.onPrivacyBoundary?.("verified");
      } catch (error) {
        await privacyGate.seal({ code: "PROTECTED_AUTHENTICATION_FAILED" })
          .then(() => options.onPrivacyBoundary?.("sealed"))
          .catch(() => undefined);
        throw error;
      } finally {
        fields.splice(0);
      }
      return;
    }
    case "select":
      await requirePraxisWithNoCapabilityRetry({
        page,
        intent: action.target,
        operation: {
          type: "select_option",
          input: { reference: "selected-option", classification: "public" },
        },
        context: praxisContextAt(praxisContext, preDispatchDeadlineAt),
        signal,
        resolveInput: async () => action.value,
      });
      return;
    case "check":
      await requirePraxisWithNoCapabilityRetry({
        page,
        intent: action.target,
        operation: { type: "set_checked", checked: action.checked },
        context: praxisContextAt(praxisContext, preDispatchDeadlineAt),
        signal,
      });
      return;
    case "press":
      if (action.target && approvedKey(action.key)) {
        await requirePraxisWithNoCapabilityRetry({
          page,
          intent: action.target,
          operation: { type: "press_key", key: action.key },
          context: {
            ...praxisContextAt(praxisContext, preDispatchDeadlineAt),
            dispatchSemantics: action.dispatchSemantics ?? "mutation",
          },
          signal,
        });
      } else if (action.target) {
        throw new Error("PRAXIS_UNSUPPORTED_TARGET_KEY");
      } else {
        assertActionDeadline(preDispatchDeadlineAt);
        if (action.dispatchSemantics !== "read_only") await options.onMutationDispatch?.();
        await pressPageKey(page, action.key);
      }
      return;
    case "scroll":
      if (action.target) {
        await requirePraxisWithNoCapabilityRetry({
          page,
          intent: action.target,
          operation: { type: "scroll", direction: action.deltaY >= 0 ? "down" : "up" },
          context: praxisContextAt(praxisContext, preDispatchDeadlineAt),
          signal,
        });
      } else {
        assertActionDeadline(preDispatchDeadlineAt);
        await wheelPage(page, action.deltaY);
      }
      return;
    case "waitFor":
      await requirePraxisWithNoCapabilityRetry({
        page,
        intent: action.target,
        operation: { type: "wait_for_state", state: action.state },
        context: praxisContextAt(praxisContext, preDispatchDeadlineAt),
        signal,
      });
      return;
    case "screenshot":
      return;
  }
}

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;

function actionDeadline(action: CurrentAction, context?: PraxisConsumerContext) {
  const authored = "timeoutMs" in action ? action.timeoutMs : undefined;
  return performance.now() + (authored ?? context?.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
}

async function requirePraxisWithNoCapabilityRetry(input: PraxisConsumerInput) {
  const deadline = input.context.preDispatchDeadlineAt;
  for (;;) {
    const result = await executePraxisConsumer(input);
    if (result.status === "succeeded") return result;
    if (
      ![
        "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL",
        "PRAXIS_TARGET_SCOPE_NOT_FOUND",
      ].includes(result.code) ||
      deadline === undefined ||
      performance.now() >= deadline
    )
      throw new PraxisConsumerError(result);
  }
}

function praxisContextAt(context: PraxisConsumerContext | undefined, deadline: number) {
  assertActionDeadline(deadline);
  return { ...requirePraxisContext(context), preDispatchDeadlineAt: deadline };
}

function assertActionDeadline(deadline: number) {
  if (deadline - performance.now() <= 0) throw new ActionPreDispatchTimeoutError();
}

export class ActionPreDispatchTimeoutError extends Error {
  override name = "ActionPreDispatchTimeoutError";
  constructor() {
    super("ACTION_PRE_DISPATCH_TIMED_OUT");
  }
}

export async function missingSecretResolver(reference: string): Promise<string> {
  throw new Error(`No secret resolver configured for reference: ${reference}`);
}

export class InfrastructureDependencyError extends Error {
  override name = "InfrastructureDependencyError";
}

export function requirePraxisContext(
  context: PraxisConsumerContext | undefined,
): PraxisConsumerContext {
  if (!context) throw new Error("PRAXIS_CONTEXT_REQUIRED");
  return context;
}

function approvedKey(
  key: string,
): key is
  "Enter" | "Space" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" {
  return [
    "Enter",
    "Space",
    "Escape",
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ].includes(key);
}

async function missingPublicValueResolver(reference: string): Promise<string> {
  throw new Error(
    `Generated public value ${reference} cannot be resolved because no public-value resolver is configured`,
  );
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error("Execution aborted");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function exactUrlPattern(url: string): string {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 480)}$`;
}
