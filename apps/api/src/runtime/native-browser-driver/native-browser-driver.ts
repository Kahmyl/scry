import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import {
  closePraxisBrowserResources,
  navigateAndWaitNative,
  openPraxisBrowserServerSession,
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
      ["token", "access_token", "auth_token", "jwt"].includes(cookie.name),
    )?.value;
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
}

class NativeBrowserDriverError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export { waitForDocumentSurface };
