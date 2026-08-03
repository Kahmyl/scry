import { RuntimePolicyError, RuntimeRequestPolicy } from "@scry/policy";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";

import type { ExecuteOptions } from "./types.js";

export function attachCapabilityGuards(
  context: BrowserContext,
  primaryPage: Page,
  options: ExecuteOptions,
  reject: (error: RuntimePolicyError) => Promise<void>,
) {
  context.on("page", (page) => {
    if (page === primaryPage || options.policy.allowPopups) return;
    void reject(
      new RuntimePolicyError("POPUP_NOT_ALLOWED", "Popup or new page was blocked"),
    ).finally(() => void page.close().catch(() => undefined));
  });
  primaryPage.on("download", (download) => {
    if (options.policy.allowDownloads) return;
    void reject(
      new RuntimePolicyError(
        "DOWNLOAD_NOT_ALLOWED",
        "Download was blocked",
        download.suggestedFilename(),
      ),
    ).finally(() => void download.cancel().catch(() => undefined));
  });
}

export async function attachRequestInterception(
  context: BrowserContext,
  page: Page,
  requestPolicy: RuntimeRequestPolicy,
  reject: (
    error: RuntimePolicyError,
    context?: { fatal?: boolean; resourceType?: string },
  ) => Promise<void>,
): Promise<CDPSession> {
  const session = await context.newCDPSession(page);
  const frameTree = (await session.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  const primaryFrameId = frameTree.frameTree.frame.id;
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }],
  });
  session.on(
    "Fetch.requestPaused",
    (parameters: {
      requestId: string;
      frameId?: string;
      resourceType?: string;
      request: { url: string };
    }) => {
      void (async () => {
        const isPrimaryDocument =
          parameters.resourceType === "Document" && parameters.frameId === primaryFrameId;
        try {
          if (isPrimaryDocument) await requestPolicy.assertAllowed(parameters.request.url);
          else await requestPolicy.assertSafeSubresource(parameters.request.url);
          await session.send("Fetch.continueRequest", { requestId: parameters.requestId });
        } catch (error) {
          const violation =
            error instanceof RuntimePolicyError
              ? error
              : new RuntimePolicyError(
                  "ORIGIN_NOT_ALLOWED",
                  `Request policy check failed: ${errorMessage(error)}`,
                  parameters.request.url,
                );
          await reject(violation, {
            resourceType: parameters.resourceType ?? "Other",
            fatal: isPrimaryDocument,
          });
          await session
            .send("Fetch.failRequest", {
              requestId: parameters.requestId,
              errorReason: "BlockedByClient",
            })
            .catch(() => undefined);
        }
      })();
    },
  );
  return session;
}

export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error("Execution aborted");
}

export function isBrowserInfrastructureFailure(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("browser has been closed") ||
    message.includes("browser closed") ||
    message.includes("browser disconnected") ||
    message.includes("target page, context or browser has been closed") ||
    message.includes("target closed")
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function canonicalVeilOrigin(currentUrl: string | undefined, fallback: string): string {
  try {
    const origin = currentUrl ? new URL(currentUrl).origin : "null";
    if (origin !== "null") return origin;
  } catch {
    /* use policy origin */
  }
  return new URL(fallback).origin;
}

export async function stopBrowser(
  context: BrowserContext | undefined,
  browser: Browser | undefined,
) {
  await Promise.allSettled([
    context ? boundedClose(context.close()) : Promise.resolve(),
    browser ? boundedClose(browser.close()) : Promise.resolve(),
  ]);
}

export async function boundedClose(operation: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser shutdown timed out")), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
