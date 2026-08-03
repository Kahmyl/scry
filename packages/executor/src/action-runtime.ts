import { randomUUID } from "node:crypto";

import type { CurrentAction, RunEvent } from "@scry/contracts";
import {
  requirePraxisSuccess,
  resolveTargetLocator,
  type PraxisConsumerContext,
} from "@scry/praxis";
import type { SecretRedactor } from "@scry/policy";
import type { VeilRuntimeCoordinator } from "@scry/veil";
import type { Locator, Page } from "playwright";

import { capturePublicGeneratedValue } from "./public-value-capture.js";
import type { ExecuteOptions } from "./types.js";

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
      await page.goto(new URL(action.url, options.plan.allowedOrigins[0]).href, {
        waitUntil: "domcontentloaded",
        ...optionalTimeout(action.timeoutMs),
      });
      await waitForApplicationRender(page, action.timeoutMs);
      return;
    case "click":
      await requirePraxisSuccess({
        page,
        intent: action.target,
        operation: { type: "activate" },
        expectedEffect: action.expectedEffect,
        context: requirePraxisContext(praxisContext),
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
        if (!credentialReference)
          throw new Error(`Captured secret "${action.capturedSecretRef}" is unavailable`);
        try {
          value = await (options.secretResolver ?? missingSecretResolver)(credentialReference);
        } catch (error) {
          throw new InfrastructureDependencyError(
            `Captured credential resolution failed: ${errorMessage(error)}`,
          );
        }
      }
      if (value === undefined && action.secretRef) {
        try {
          value = await (options.secretResolver ?? missingSecretResolver)(action.secretRef);
        } catch (error) {
          throw new InfrastructureDependencyError(
            `Protected credential resolution failed: ${errorMessage(error)}`,
          );
        }
      }
      if (value === undefined)
        throw new Error(`Captured secret "${action.capturedSecretRef}" is unavailable`);

      const protectedFill = Boolean(action.secretRef || action.capturedSecretRef);
      if (protectedFill) redactor.add(value);
      const locator = protectedFill ? await resolveTargetLocator(page, action.target) : undefined;
      if (locator) await maskSensitiveLocator(locator);
      if (protectedFill && privacyGate) {
        const operationId = `known-secret-fill-${randomUUID()}`;
        try {
          await privacyGate.prepare(operationId, {
            mode: "protected_recording_gap",
            videoMaskEstablished: false,
          });
          await privacyGate.beginProtected();
          await locator!.fill(value, optionalTimeout(action.timeoutMs));
          const valuePresent = await locator!.evaluate((element) =>
            "value" in (element as HTMLInputElement)
              ? (element as HTMLInputElement).value.length > 0
              : (element.textContent ?? "").length > 0,
          );
          if (!valuePresent) throw new Error("LOCAL_STATE_NOT_OBSERVED");
          await privacyGate.markCaptured();
          await privacyGate.beginSafeBoundary();
          await privacyGate.confirmSafeBoundary({
            kind: "known_secret_registered",
            referenceType: action.secretRef ? "vault" : "captured",
          });
        } catch (error) {
          await privacyGate.seal({ code: "KNOWN_SECRET_FILL_FAILED" }).catch(() => undefined);
          throw error;
        }
      } else {
        await requirePraxisSuccess({
          page,
          intent: action.target,
          operation: {
            type: "enter_text",
            input: {
              reference: "resolved-input",
              classification: action.capturedValueRef ? "captured_public" : "public",
            },
          },
          context: requirePraxisContext(praxisContext),
          signal,
          resolveInput: async () => value!,
        });
      }
      return;
    }
    case "select":
      await requirePraxisSuccess({
        page,
        intent: action.target,
        operation: {
          type: "select_option",
          input: { reference: "selected-option", classification: "public" },
        },
        context: requirePraxisContext(praxisContext),
        signal,
        resolveInput: async () => action.value,
      });
      return;
    case "check":
      await requirePraxisSuccess({
        page,
        intent: action.target,
        operation: { type: "set_checked", checked: action.checked },
        context: requirePraxisContext(praxisContext),
        signal,
      });
      return;
    case "press":
      if (action.target && approvedKey(action.key)) {
        await requirePraxisSuccess({
          page,
          intent: action.target,
          operation: { type: "press_key", key: action.key },
          context: requirePraxisContext(praxisContext),
          signal,
        });
      } else if (action.target) {
        throw new Error("PRAXIS_UNSUPPORTED_TARGET_KEY");
      } else {
        await page.keyboard.press(action.key);
      }
      return;
    case "scroll":
      if (action.target) {
        await requirePraxisSuccess({
          page,
          intent: action.target,
          operation: { type: "scroll", direction: action.deltaY >= 0 ? "down" : "up" },
          context: requirePraxisContext(praxisContext),
          signal,
        });
      } else {
        await page.mouse.wheel(0, action.deltaY);
      }
      return;
    case "waitFor":
      await requirePraxisSuccess({
        page,
        intent: action.target,
        operation: { type: "wait_for_state", state: action.state },
        context: requirePraxisContext(praxisContext),
        signal,
      });
      return;
    case "screenshot":
      return;
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

async function waitForApplicationRender(page: Page, timeoutMs = 10_000) {
  const mountSelector = await page.evaluate(() => {
    for (const selector of ["#root", "#app", "#__next"]) {
      if (document.querySelector(selector)) return selector;
    }
    return undefined;
  });
  if (!mountSelector) return;

  try {
    await page.waitForFunction(
      (selector) => {
        const mount = document.querySelector(selector);
        if (!mount) return false;
        const text = (mount.textContent ?? "").replace(/\s+/g, " ").trim();
        const hasContent = mount.childElementCount > 0 || text.length > 0;
        const isLoadingPlaceholder =
          /^(loading|please wait|initializing|starting)([.…!]*|\s+.*)?$/i.test(text);
        return hasContent && !isLoadingPlaceholder;
      },
      mountSelector,
      { timeout: timeoutMs },
    );
  } catch {
    const visibleText = await page
      .locator(mountSelector)
      .innerText()
      .catch(() => "");
    if (/^(loading|please wait|initializing|starting)([.…!]*|\s+.*)?$/i.test(visibleText.trim())) {
      throw new Error(
        `Application remained in its loading state (${JSON.stringify(visibleText.trim())})`,
      );
    }
    throw new Error(
      `Application shell loaded, but ${mountSelector} remained empty and the application did not render`,
    );
  }
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
}

async function maskSensitiveLocator(locator: Locator) {
  await locator.evaluate((element) => {
    element.setAttribute("data-scry-redacted", "true");
    const htmlElement = element as HTMLElement;
    htmlElement.style.setProperty("color", "transparent", "important");
    htmlElement.style.setProperty("-webkit-text-fill-color", "transparent", "important");
    htmlElement.style.setProperty("background", "#000", "important");
    htmlElement.style.setProperty("border-color", "#000", "important");
    htmlElement.style.setProperty("caret-color", "transparent", "important");
    htmlElement.style.setProperty("text-shadow", "none", "important");
  });
}

async function missingPublicValueResolver(reference: string): Promise<string> {
  throw new Error(
    `Generated public value ${reference} cannot be resolved because no public-value resolver is configured`,
  );
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error("Execution aborted");
}

function optionalTimeout(timeoutMs: number | undefined): { timeout?: number } {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
