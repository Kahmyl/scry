import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ExpectedEffect, InteractionTargetIntent } from "@scry/contracts";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import {
  closePraxisBrowserResources,
  navigateAndWaitNative,
  openPraxisBrowserServerSession,
  requirePraxisSuccess,
  resolveTargetLocator,
  verifyExpectedEffect,
  waitForDocumentSurface,
} from "@scry/praxis";

@Injectable()
export class NativeBrowserDriver {
  async openBrowser(
    options: BrowserContextOptions = {},
    owner: { kind: "safe_browser" | "protected_capsule" | "runtime_browser"; ownerId: string } = {
      kind: "runtime_browser",
      ownerId: randomUUID(),
    },
  ) {
    return openPraxisBrowserServerSession(options, owner);
  }

  async closeBrowser(browser: Browser, context: BrowserContext) {
    await closePraxisBrowserResources(context, browser);
  }

  async navigateAndWait(
    page: Page,
    url: string,
    allowedOrigins: Iterable<string>,
    timeout = 30_000,
    trustedScriptOrigins: Iterable<string> = [],
  ) {
    await navigateAndWaitNative(page, url, allowedOrigins, timeout, trustedScriptOrigins);
  }

  async sameOriginRequest(
    page: Page,
    request: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: Record<string, string | number | boolean | null>;
      expectedStatus: { min: number; max: number };
      timeoutMs?: number;
    },
    allowedOrigins: string[],
    beforeDispatch?: () => Promise<void>,
  ) {
    const pageUrl = new URL(page.url());
    const url = new URL(request.path, pageUrl);
    if (url.origin !== pageUrl.origin || !allowedOrigins.includes(url.origin)) {
      throw new NativeBrowserDriverError("NATIVE_SAME_ORIGIN_REQUEST_DENIED");
    }
    const cookies = await page.context().cookies(url.origin);
    const token = cookies.find((cookie) =>
      ["token", "access_token", "auth_token", "jwt"].includes(cookie.name))?.value;
    await beforeDispatch?.();
    const response = await page.context().request.fetch(url.href, {
      method: request.method,
      ...(request.body === undefined ? {} : { data: request.body }),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
    });
    const status = response.status();
    await response.dispose();
    if (status < request.expectedStatus.min || status > request.expectedStatus.max) {
      throw new NativeBrowserDriverError("NATIVE_SAME_ORIGIN_STATUS_UNEXPECTED");
    }
    return { status, classification: "expected" as const };
  }

  /** @deprecated Qualification compatibility only; product execution calls Praxis directly. */
  async resolveSemanticTarget(page: Page, intent: InteractionTargetIntent, _waitTimeoutMs = 0) {
    return resolveTargetLocator(page, intent);
  }

  /** @deprecated Qualification compatibility only; product execution calls Praxis directly. */
  async executeSemanticControl(
    page: Page,
    intent: InteractionTargetIntent,
    operation:
      | { type: "click"; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "fill"; value: string; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number; protected: boolean }
      | { type: "select"; value: string; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "check"; checked: boolean; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "press"; key: "Enter" | "Space" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"; timeoutMs?: number; resolutionTimeoutMs?: number; preDispatchDeadlineAt?: number }
      | { type: "scroll"; deltaY: number }
      | { type: "waitFor"; state: "visible" | "hidden" | "attached" | "detached"; timeoutMs?: number },
    beforeDispatch?: () => Promise<void>,
  ) {
    const praxisOperation = operation.type === "click"
      ? { type: "activate" as const }
      : operation.type === "fill"
        ? { type: "enter_text" as const, input: { reference: "compatibility-input", classification: operation.protected ? "known_secret" as const : "public" as const } }
        : operation.type === "select"
          ? { type: "select_option" as const, input: { reference: "compatibility-input", classification: "public" as const } }
          : operation.type === "check"
            ? { type: "set_checked" as const, checked: operation.checked }
            : operation.type === "press"
              ? { type: "press_key" as const, key: operation.key }
              : operation.type === "scroll"
                ? { type: "scroll" as const, direction: operation.deltaY >= 0 ? "down" as const : "up" as const }
                : { type: "wait_for_state" as const, state: operation.state };
    await requirePraxisSuccess({
      page,
      intent,
      operation: praxisOperation,
      context: {
        stepId: "native-driver-compatibility",
        channel: "action",
        ordinal: 0,
        allowedOrigins: [new URL(page.url()).origin],
        timeoutMs: "timeoutMs" in operation ? operation.timeoutMs ?? 10_000 : 10_000,
        privacy: { state: "normal", allowedChannels: ["public_dom", "accessibility", "visual", "ocr"], suppressedChannels: [] },
        ...(beforeDispatch ? { beforeMutation: beforeDispatch } : {}),
      },
      signal: new AbortController().signal,
      ...((operation.type === "fill" || operation.type === "select")
        ? { resolveInput: async () => operation.value }
        : {}),
    });
  }

  /** @deprecated Qualification compatibility only; product execution calls Praxis directly. */
  async verifyExpectedEffect(page: Page, effect: ExpectedEffect, beforeUrl: string, timeoutMs: number) {
    await verifyExpectedEffect(page, effect, beforeUrl, timeoutMs);
  }
}

class NativeBrowserDriverError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export { waitForDocumentSurface };
