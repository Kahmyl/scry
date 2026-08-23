import { randomUUID } from "node:crypto";

import { destroyPraxisIsolatedSession, installPraxisSessionStorage } from "@scry/praxis";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

import {
  BrowserSessionProvenance,
  type ProtectedBrowserSession,
  type SafeBrowserSession,
} from "@scry/praxis";
import { createVeilClipboardCollector } from "@scry/praxis";
import type { CapsuleFactory } from "./protected-transaction-runtime.js";

export type { CapsuleFactory } from "./protected-transaction-runtime.js";

export class PlaywrightProtectedCapsuleFactory implements CapsuleFactory {
  constructor(
    private readonly openBrowser: (options?: BrowserContextOptions) => Promise<{
      browser: Browser;
      context: BrowserContext;
      page: Page;
      forceClose?: () => Promise<void>;
      browserProcessId?: number;
    }>,
  ) {}

  async create(input: {
    storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>;
    sessionStorage?: { origin: string; entries: Array<[string, string]> };
    viewport?: { width: number; height: number };
    browserChannel?: string;
    prepare: (session: ProtectedBrowserSession) => Promise<void>;
  }) {
    const options: BrowserContextOptions = {
      storageState: input.storageState,
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(input.viewport ? { viewport: input.viewport } : {}),
    };
    const { browser, context, page, forceClose } = await this.openBrowser(options);
    if (input.sessionStorage) {
      await installPraxisSessionStorage(context, input.sessionStorage);
    }
    const provenance = new BrowserSessionProvenance(randomUUID(), "protected");
    const clipboardCollector = createVeilClipboardCollector(page);
    let destroyed = false;
    const session: ProtectedBrowserSession = {
      browser,
      context,
      page,
      provenance,
      clipboardCollector,
      destroy: async () => {
        if (destroyed) return "destroyed";
        destroyed = true;
        const outcome = await destroyPraxisIsolatedSession({
          context,
          browser,
          ...(forceClose ? { forceClose } : {}),
        });
        if (provenance.value() !== "destroyed") provenance.transition("destroyed");
        return outcome;
      },
    };
    try {
      await input.prepare(session);
      return session;
    } catch (error) {
      await session.destroy();
      throw error;
    }
  }
}
