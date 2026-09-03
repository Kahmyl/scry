import type { RunEvent } from "@scry/contracts";
import type { SecretRedactor } from "@scry/policy";
import type { Page } from "playwright";

import type { DiagnosticRecord } from "./types.js";

export function attachDiagnostics(
  page: Page,
  diagnostics: DiagnosticRecord[],
  emit: (type: RunEvent["type"], payload: Record<string, unknown>) => Promise<void>,
  redactor: SecretRedactor,
  isProtectedCaptureActive: () => boolean = () => false,
) {
  page.on("console", () => {
    if (isProtectedCaptureActive()) return;
    const diagnostic: DiagnosticRecord = {
      type: "console",
      occurredAt: new Date().toISOString(),
      message: "PAGE_CONSOLE_MESSAGE_OMITTED",
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.console", diagnostic);
  });
  page.on("pageerror", () => {
    if (isProtectedCaptureActive()) return;
    const diagnostic: DiagnosticRecord = {
      type: "page_error",
      occurredAt: new Date().toISOString(),
      message: "PAGE_ERROR_MESSAGE_OMITTED",
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.page_error", diagnostic);
  });
  page.on("requestfailed", (request) => {
    if (isProtectedCaptureActive()) return;
    const diagnostic: DiagnosticRecord = {
      type: "request_failed",
      occurredAt: new Date().toISOString(),
      message: "REQUEST_FAILURE_DETAILS_OMITTED",
      url: safeDiagnosticOrigin(request.url()),
      method: request.method(),
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.request_failed", diagnostic);
  });
}

export function attachNetworkCapture(
  page: Page,
  records: Array<Record<string, unknown>>,
  redactor: SecretRedactor,
  activity?: { active: Map<string, { url: string; resourceType: string }> },
  isProtectedCaptureActive: () => boolean = () => false,
) {
  page.on("request", (request) => {
    activity?.active.set(request.url(), {
      url: request.url(),
      resourceType: request.resourceType(),
    });
    if (isProtectedCaptureActive()) return;
    records.push({
      type: "request",
      occurredAt: new Date().toISOString(),
      method: request.method(),
      url: redactor.redact(request.url()),
      resourceType: request.resourceType(),
    });
  });
  page.on("response", (response) => {
    if (isProtectedCaptureActive()) return;
    const record: Record<string, unknown> = {
      type: "response",
      occurredAt: new Date().toISOString(),
      method: response.request().method(),
      url: redactor.redact(response.url()),
      status: response.status(),
    };
    records.push(record);
    if (response.status() < 400) return;
    // Diagnostic evidence deliberately contains metadata only. Reading a body here
    // can wait forever on streaming/error responses and retain unneeded plaintext.
    // Protected output acquisition has its own exact response authority.
    record.responseBodyOmitted = "privacy_metadata_only";
  });
  const complete = (request: { url(): string }) => activity?.active.delete(request.url());
  page.on("requestfinished", complete);
  page.on("requestfailed", complete);
}

function safeDiagnosticOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid-origin";
  }
}
