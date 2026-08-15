import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
  type Page,
} from "playwright";

import { playwrightBrowserChannel } from "../browser-runtime-artifacts.js";

export type PraxisBrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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
