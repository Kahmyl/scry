import type {
  AcquisitionIntent,
  ExtractionDiagnostic,
  ProtectedTransaction,
} from "@scry/contracts";
import type { Locator, Page } from "playwright";
import type { Readable } from "node:stream";
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

type ProtectedAcquisitionAdapter = (input: {
  page: Page;
  target: Locator;
  acquisition: AcquisitionIntent;
}) => Promise<string>;

const registeredProtectedAdapters = new Map<string, ProtectedAcquisitionAdapter>();

export function registerProtectedAcquisitionAdapter(
  id: string,
  adapter: ProtectedAcquisitionAdapter,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new AcquisitionError("ACQUISITION_ADAPTER_ID_INVALID");
  }
  if (registeredProtectedAdapters.has(id)) {
    throw new AcquisitionError("ACQUISITION_ADAPTER_ALREADY_REGISTERED");
  }
  registeredProtectedAdapters.set(id, adapter);
  return () => registeredProtectedAdapters.delete(id);
}

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
  assertObjectiveMethods(acquisition);
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
        const value = await acquireByMethod(page, result.locator, method, acquisition);
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

export function protectedAcquisitionAdapterRegistry() {
  return {
    input_value: { objectiveTypes: ["capture_value"], implementation: "input_value" },
    text_content: { objectiveTypes: ["capture_value"], implementation: "dom_text" },
    selected_text: { objectiveTypes: ["capture_value"], implementation: "scoped_text_selection" },
    keyboard_copy: {
      objectiveTypes: ["verify_user_copy_experience"],
      implementation: "focused_keyboard_selection",
    },
    copy_control: {
      objectiveTypes: ["capture_value", "verify_user_copy_experience"],
      implementation: "copy_control",
    },
    clipboard_event: {
      objectiveTypes: ["verify_user_copy_experience"],
      implementation: "copy_control",
    },
    download_content: { objectiveTypes: ["capture_value"], implementation: "download_content" },
    protected_network_value: {
      objectiveTypes: ["capture_value"],
      implementation: "approved_network_field",
    },
    ocr_region: { objectiveTypes: ["capture_value"], implementation: "protected_visual_reading" },
  } as const;
}

async function acquireByMethod(
  page: Page,
  target: Locator,
  method: AcquisitionIntent["permittedMethods"][number],
  acquisition: AcquisitionIntent,
): Promise<string> {
  const intent = acquisition.target;
  switch (method) {
    case "input_value":
      return target.inputValue();
    case "text_content":
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
    case "selected_text":
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
    case "keyboard_copy":
    case "clipboard_event":
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
    case "download_content": {
      const [download] = await Promise.all([page.waitForEvent("download"), target.click()]);
      const stream = await download.createReadStream();
      if (!stream) throw new AcquisitionError("DOWNLOAD_STREAM_UNAVAILABLE");
      return readBoundedText(stream, acquisition.validation.maximumLength);
    }
    case "protected_network_value":
    case "approved_network_field": {
      const adapterId = acquisition.adapter?.id;
      const adapter = adapterId ? registeredProtectedAdapters.get(adapterId) : undefined;
      if (!adapter) throw new AcquisitionError("NETWORK_ADAPTER_REQUIRED");
      return adapter({ page, target, acquisition });
    }
    case "application_adapter":
      throw new AcquisitionError("APPLICATION_ADAPTER_REQUIRED");
    case "secure_user_assistance":
      throw new AcquisitionError("SECURE_ASSISTANCE_REQUIRED");
    case "ocr_region":
    case "protected_visual_reading":
      return acquireProtectedVisualText(page, intent);
  }
}

function assertObjectiveMethods(acquisition: AcquisitionIntent) {
  if (!acquisition.objective) return;
  if (process.env.SCRY_PROTECTED_ACQUISITION_ADAPTERS_ENABLED !== "true") {
    throw new AcquisitionError("PROTECTED_ACQUISITION_ADAPTERS_DISABLED");
  }
  const registry = protectedAcquisitionAdapterRegistry();
  const incompatible = acquisition.permittedMethods.filter((method) => {
    const adapter = registry[canonicalMethod(method) as keyof typeof registry];
    return !adapter || !adapter.objectiveTypes.includes(acquisition.objective!.kind as never);
  });
  if (incompatible.length) {
    throw new AcquisitionError("ACQUISITION_OBJECTIVE_METHOD_MISMATCH");
  }
}

function canonicalMethod(method: AcquisitionIntent["permittedMethods"][number]) {
  if (method === "dom_text") return "text_content";
  if (method === "scoped_text_selection") return "selected_text";
  if (method === "focused_keyboard_selection") return "keyboard_copy";
  if (method === "approved_network_field") return "protected_network_value";
  if (method === "protected_visual_reading") return "ocr_region";
  return method;
}

async function readBoundedText(stream: Readable, maximumLength: number) {
  let value = "";
  for await (const chunk of stream) {
    value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (value.length > maximumLength) {
      stream.destroy();
      throw new AcquisitionError("DOWNLOAD_CONTENT_TOO_LARGE");
    }
  }
  return value;
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
