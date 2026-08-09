import { randomUUID } from "node:crypto";

import { VeilClipboardCollector } from "@scry/veil";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

import {
  BrowserSessionProvenance,
  type ProtectedBrowserSession,
  type SafeBrowserSession,
} from "./browser-session.js";

export type CapsuleFactory = {
  create(input: {
    storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>;
    sessionStorage?: { origin: string; entries: Array<[string, string]> };
    viewport?: { width: number; height: number };
    browserChannel?: string;
    prepare: (session: ProtectedBrowserSession) => Promise<void>;
  }): Promise<ProtectedBrowserSession>;
};

export class PlaywrightProtectedCapsuleFactory implements CapsuleFactory {
  constructor(
    private readonly openBrowser: (options?: BrowserContextOptions) => Promise<{
      browser: Browser;
      context: BrowserContext;
      page: Page;
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
    const { browser, context, page } = await this.openBrowser(options);
    if (input.sessionStorage) {
      await context.addInitScript(({ origin, entries }) => {
        if (window.location.origin !== origin) return;
        for (const [key, value] of entries) window.sessionStorage.setItem(key, value);
      }, input.sessionStorage);
    }
    const provenance = new BrowserSessionProvenance(randomUUID(), "protected");
    const clipboardCollector = new VeilClipboardCollector(page);
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
        let outcome: "destroyed" | "force_terminated" = "destroyed";
        try {
          await context.close();
          await browser.close();
        } catch {
          outcome = "force_terminated";
          await browser.close().catch(() => undefined);
        }
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
