import { randomUUID } from "node:crypto";

import { playwrightBrowserChannel } from "@scry/praxis";
import { VeilClipboardCollector } from "@scry/veil";
import { chromium, type BrowserContextOptions } from "playwright";

import {
  BrowserSessionProvenance,
  type ProtectedBrowserSession,
  type SafeBrowserSession,
} from "./browser-session.js";

export type CapsuleFactory = {
  create(input: {
    storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>;
    viewport?: { width: number; height: number };
    browserChannel?: string;
    prepare: (session: ProtectedBrowserSession) => Promise<void>;
  }): Promise<ProtectedBrowserSession>;
};

export class PlaywrightProtectedCapsuleFactory implements CapsuleFactory {
  async create(input: {
    storageState: Awaited<ReturnType<SafeBrowserSession["context"]["storageState"]>>;
    viewport?: { width: number; height: number };
    browserChannel?: string;
    prepare: (session: ProtectedBrowserSession) => Promise<void>;
  }) {
    const configuredChannel = input.browserChannel ?? process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
    const launchChannel = playwrightBrowserChannel(configuredChannel);
    const browser = await chromium.launch({
      headless: true,
      ...(launchChannel ? { channel: launchChannel } : {}),
    });
    const options: BrowserContextOptions = {
      storageState: input.storageState,
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(input.viewport ? { viewport: input.viewport } : {}),
    };
    const context = await browser.newContext(options);
    const page = await context.newPage();
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
