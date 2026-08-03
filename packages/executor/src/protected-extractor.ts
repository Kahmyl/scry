import type {
  AcquisitionIntent,
  ExtractionDiagnostic,
  ProtectedTransaction,
} from "@scry/contracts";
import type { Locator, Page } from "playwright";
import {
  armExpectedEffect,
  GroundingError,
  resolveTarget,
  verifyExpectedEffect,
} from "@scry/praxis";
import { acquireProtectedVisualText } from "@scry/praxis";
import { requirePraxisSuccess } from "@scry/praxis";
import { markVeilProtectedClipboardTouched } from "@scry/veil";

type CandidateState = ExtractionDiagnostic & {
  method?: AcquisitionIntent["permittedMethods"][number];
};

export async function executeProtectedReveal(
  page: Page,
  operation: ProtectedTransaction,
  allowedOrigins: string[],
  signal: AbortSignal = new AbortController().signal,
) {
  const action = operation.mutation.action;
  if (action.type === "click") {
    await requirePraxisSuccess({
      page,
      intent: action.target,
      operation: { type: "activate" },
      expectedEffect: action.expectedEffect,
      context: {
        stepId: operation.operationId,
        channel: "protected",
        ordinal: 0,
        allowedOrigins,
        timeoutMs: action.timeoutMs ?? 10_000,
        privacy: {
          state: "protected",
          allowedChannels: ["public_dom", "accessibility"],
          suppressedChannels: ["visual", "ocr"],
        },
      },
      signal,
    });
    return;
  }
  if (action.target) {
    await requirePraxisSuccess({
      page,
      intent: action.target,
      operation: { type: "press_key", key: action.key },
      expectedEffect: action.expectedEffect,
      context: {
        stepId: operation.operationId,
        channel: "protected",
        ordinal: 0,
        allowedOrigins,
        timeoutMs: action.timeoutMs ?? 10_000,
        privacy: {
          state: "protected",
          allowedChannels: ["public_dom", "accessibility"],
          suppressedChannels: ["visual", "ocr"],
        },
      },
      signal,
    });
    return;
  }
  const beforeUrl = page.url();
  const expectedEffect = armExpectedEffect(page, action.expectedEffect, action.timeoutMs);
  await page.keyboard.press(action.key);
  await verifyExpectedEffect(
    page,
    action.expectedEffect,
    beforeUrl,
    action.timeoutMs,
    expectedEffect,
  );
}

export async function acquireValue(page: Page, acquisition: AcquisitionIntent, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const diagnostics: CandidateState[] = acquisition.permittedMethods.map((method, candidate) => ({
    candidate,
    method,
    attempts: 0,
    durationMs: 0,
    containerResolved: false,
    matchCount: "unknown",
    visibility: "unknown",
    accessibility: "unknown",
  }));
  while (Date.now() < deadline) {
    for (const [index, method] of acquisition.permittedMethods.entries()) {
      if (Date.now() >= deadline) break;
      const diagnostic = diagnostics[index]!;
      const started = Date.now();
      diagnostic.attempts += 1;
      diagnostic.firstAttemptedAt ??= new Date(started).toISOString();
      try {
        const result = await resolveTarget(page, acquisition.target);
        diagnostic.containerResolved = true;
        diagnostic.matchCount = "one";
        diagnostic.visibility = "visible";
        diagnostic.accessibility = "available";
        const value = await acquireByMethod(page, result.locator, method, acquisition.target);
        const normalized = value.trim();
        if (valid(normalized, acquisition.validation)) return { value: normalized, diagnostics };
        diagnostic.lastFailureCode = normalized ? "VALUE_VALIDATION_FAILED" : "VALUE_EMPTY";
      } catch (error) {
        diagnostic.lastFailureCode = error instanceof GroundingError ? error.code : safeCode(error);
        if (error instanceof GroundingError) {
          diagnostic.matchCount = error.code === "TARGET_AMBIGUOUS" ? "many" : "none";
          diagnostic.containerResolved = error.code !== "TARGET_NOT_FOUND";
        }
      } finally {
        diagnostic.durationMs += Date.now() - started;
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
    );
  }
  return { value: undefined, diagnostics };
}

async function acquireByMethod(
  page: Page,
  target: Locator,
  method: AcquisitionIntent["permittedMethods"][number],
  intent: AcquisitionIntent["target"],
): Promise<string> {
  switch (method) {
    case "input_value":
      return target.inputValue();
    case "dom_text":
      return target.textContent().then((value) => value ?? "");
    case "semantic_field_value":
      return target.evaluate((element) =>
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.value
          : (element.textContent ?? ""),
      );
    case "copy_control": {
      const group = target.locator(
        "xpath=ancestor::*[self::fieldset or @role='group' or self::div][1]",
      );
      const copy = group.getByRole("button", { name: /copy/i });
      if ((await copy.count()) !== 1) throw new AcquisitionError("COPY_CONTROL_UNRESOLVED");
      await copy.click();
      const lifecycleOwned = markVeilProtectedClipboardTouched(page);
      const value = await page.evaluate(() => navigator.clipboard.readText());
      if (!lifecycleOwned) await page.evaluate(() => navigator.clipboard.writeText(""));
      return value;
    }
    case "scoped_text_selection":
      return target.evaluate((element) => {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const value = selection?.toString() ?? "";
        selection?.removeAllRanges();
        return value;
      });
    case "focused_keyboard_selection": {
      await target.focus();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      const value = await target.evaluate((element) =>
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value.substring(
              element.selectionStart ?? 0,
              element.selectionEnd ?? element.value.length,
            )
          : (getSelection()?.toString() ?? ""),
      );
      await page.keyboard.press("Escape").catch(() => undefined);
      return value;
    }
    case "approved_network_field":
      throw new AcquisitionError("NETWORK_ADAPTER_REQUIRED");
    case "application_adapter":
      throw new AcquisitionError("APPLICATION_ADAPTER_REQUIRED");
    case "secure_user_assistance":
      throw new AcquisitionError("SECURE_ASSISTANCE_REQUIRED");
    case "protected_visual_reading":
      return acquireProtectedVisualText(page, intent);
  }
}
function valid(value: string, validation: AcquisitionIntent["validation"]) {
  if (value.length < validation.minimumLength || value.length > validation.maximumLength)
    return false;
  if (validation.pattern) {
    try {
      return new RegExp(validation.pattern).test(value);
    } catch {
      return false;
    }
  }
  return true;
}
function safeCode(error: unknown) {
  return error instanceof AcquisitionError ? error.code : "ACQUISITION_METHOD_FAILED";
}
export class AcquisitionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
