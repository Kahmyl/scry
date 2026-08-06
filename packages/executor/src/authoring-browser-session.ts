import type { ExecutionPolicy } from "@scry/contracts";
import {
  playwrightBrowserChannel,
  registerPraxisVeilAuthority,
} from "@scry/praxis";
import { VeilAuthority } from "@scry/veil";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";

export type AuthoringBrowserSessionState =
  | "active"
  | "releasing"
  | "released"
  | "crashed";

export type AuthoringBrowserSession = {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  state(): AuthoringBrowserSessionState;
  documentEpoch(): number;
  observeDocument(): Promise<{
    documentEpoch: number;
    url: string;
  }>;
  close(): Promise<void>;
};

export async function createAuthoringBrowserSession(input: {
  sessionId: string;
  environmentId: string;
  veilAdmissionKey: string;
  browserChannel: string;
  policy: ExecutionPolicy;
}): Promise<AuthoringBrowserSession> {
  if (!input.sessionId) {
    throw new Error("AUTHORING_SESSION_ID_REQUIRED");
  }

  if (!input.environmentId) {
    throw new Error("AUTHORING_ENVIRONMENT_REQUIRED");
  }

  if (!input.veilAdmissionKey) {
    throw new Error("VEIL_ADMISSION_KEY_REQUIRED");
  }

  const browserChannel = playwrightBrowserChannel(input.browserChannel);
  const browser = await chromium.launch({
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {}),
  });

  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    context = await browser.newContext();
    page = await context.newPage();

    const unregisterVeil = registerPraxisVeilAuthority(page, {
      authority: new VeilAuthority(resolveVeilPolicyForExecution(input.policy)),
      userId: "probe-authoring",
      environmentId: input.environmentId,
      browserContextId: `probe-authoring-${input.sessionId}`,
    });

    let lifecycle: AuthoringBrowserSessionState = "active";
    let epoch = 0;
    let lastDocumentToken: string | undefined;
    let closed = false;

    browser.on("disconnected", () => {
      if (!closed) {
        lifecycle = "crashed";
      }
    });

    return {
      browser,
      context,
      page,

      state() {
        return lifecycle;
      },

      documentEpoch() {
        return epoch;
      },

      async observeDocument() {
        if (lifecycle !== "active") {
          throw new Error("AUTHORING_BROWSER_SESSION_NOT_ACTIVE");
        }

        await page!.waitForLoadState("domcontentloaded");

        const documentToken = await page!.evaluate(() => {
          const key = "__scryAuthoringDocumentToken";
          const documentState = document as unknown as Record<string, unknown>;

          if (typeof documentState[key] !== "string") {
            documentState[key] = `${Date.now()}-${Math.random()}`;
          }

          return documentState[key] as string;
        });

        if (documentToken !== lastDocumentToken) {
          lastDocumentToken = documentToken;
          epoch += 1;
        }

        return {
          documentEpoch: epoch,
          url: page!.url(),
        };
      },

      async close() {
        if (closed) {
          return;
        }

        closed = true;
        lifecycle = "releasing";
        unregisterVeil();

        try {
          await context!.close();
        } finally {
          await browser.close();
          lifecycle = "released";
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
}
