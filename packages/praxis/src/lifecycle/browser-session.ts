import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from "playwright";
import { randomUUID } from "node:crypto";

import { playwrightBrowserChannel } from "../browser-runtime-artifacts.js";

export type PraxisBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export type PraxisBrowserOwnership = {
  ownerKind: "safe_browser" | "protected_capsule" | "runtime_browser";
  ownerId: string;
  browserId: string;
  contextId: string;
  pageId: string;
  events: Array<{ milestone: string; at: string }>;
};

export async function openPraxisBrowserSession(options: {
  browserChannel?: string;
  headless?: boolean;
  context?: BrowserContextOptions;
} = {}): Promise<PraxisBrowserSession> {
  const channel = playwrightBrowserChannel(options.browserChannel);
  const launchOptions: LaunchOptions = {
    headless: options.headless ?? true,
    ...(channel ? { channel } : {}),
  };
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext(options.context);
    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    await boundedBrowserClose(browser.close(), 5_000).catch(() => undefined);
    throw error;
  }
}

export async function openPraxisBrowserServerSession(
  options: BrowserContextOptions = {},
  owner: { kind: PraxisBrowserOwnership["ownerKind"]; ownerId: string } = {
    kind: "runtime_browser",
    ownerId: randomUUID(),
  },
) {
  const browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
  const server = await chromium.launchServer({
    headless: true,
    ...(browserChannel === "chromium" ? {} : { channel: browserChannel }),
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const events: PraxisBrowserOwnership["events"] = [];
  const record = (milestone: string) => events.push({ milestone, at: new Date().toISOString() });
  const ownership: PraxisBrowserOwnership = {
    ownerKind: owner.kind,
    ownerId: owner.ownerId,
    browserId: randomUUID(),
    contextId: randomUUID(),
    pageId: randomUUID(),
    events,
  };
  record("created");
  record("ownership_acquired");
  const closeClient = browser.close.bind(browser);
  let forceClosed = false;
  const forceClose = async () => {
    if (forceClosed) return;
    forceClosed = true;
    record("force_close_started");
    await server.kill();
    record("force_close_completed");
  };
  browser.close = async (closeOptions) => {
    record("close_requested");
    record("graceful_close_started");
    try {
      await closeClient(closeOptions);
      await server.close();
      record("graceful_close_completed");
    } catch (error) {
      await forceClose().catch(() => undefined);
      throw error;
    }
  };
  browser.once("disconnected", () => {
    record("process_exit_observed");
    record("ownership_released");
  });
  try {
    const context = await browser.newContext({ ...options, acceptDownloads: false });
    const page = await context.newPage();
    const browserProcessId = server.process().pid;
    return {
      browser,
      context,
      page,
      forceClose,
      ownership,
      ...(browserProcessId === undefined ? {} : { browserProcessId }),
    };
  } catch (error) {
    await forceClose().catch(() => undefined);
    throw error;
  }
}

export async function closePraxisBrowserResources(
  context: BrowserContext | undefined,
  browser: Browser | undefined,
  timeoutMs = 5_000,
): Promise<void> {
  if (context) await boundedBrowserClose(context.close(), timeoutMs).catch(() => undefined);
  if (browser) await boundedBrowserClose(browser.close(), timeoutMs).catch(() => undefined);
}

export async function boundedBrowserClose(
  operation: Promise<unknown>,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser shutdown timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
