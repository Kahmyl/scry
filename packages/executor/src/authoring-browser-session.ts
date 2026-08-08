import {
  currentActionSchema,
  type CurrentAction,
  type ExecutionPolicy,
  type ExpectedEffect,
  type OperationOutcome,
} from "@scry/contracts";
import { playwrightBrowserChannel, registerPraxisVeilAuthority } from "@scry/praxis";
import { VeilAuthority } from "@scry/veil";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";

export type AuthoringBrowserSessionState =
  "active" | "suspended" | "releasing" | "released" | "crashed";

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
  interact(
    action: CurrentAction,
    context?: {
      operationId?: string;
      correlationId?: string;
      mutationIdentity?: string;
      expectedEffect?: ExpectedEffect;
      objectiveDelta?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    documentEpoch: number;
    url: string;
    outcome: OperationOutcome;
  }>;
  suspend(): void;
  resume(): void;
  cancelActiveOperation(): Promise<void>;
  close(): Promise<void>;
};

export async function createAuthoringBrowserSession(input: {
  sessionId: string;
  environmentId: string;
  veilAdmissionKey: string;
  browserChannel: string;
  policy: ExecutionPolicy;
  executeInteraction(input: {
    page: Page;
    action: CurrentAction;
    ordinal: number;
    operationId: string;
    correlationId?: string;
    mutationIdentity?: string;
    expectedEffect?: ExpectedEffect;
    objectiveDelta?: string;
    signal?: AbortSignal;
  }): Promise<OperationOutcome>;
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
    let interactionOrdinal = 0;
    let closed = false;

    browser.on("disconnected", () => {
      if (!closed) {
        lifecycle = "crashed";
      }
    });

    async function observe() {
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
    }

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

      observeDocument: observe,

      async interact(candidate, interactionContext = {}) {
        if (lifecycle !== "active") {
          throw new Error("AUTHORING_BROWSER_SESSION_NOT_ACTIVE");
        }

        const action = currentActionSchema.parse(candidate);

        interactionOrdinal += 1;

        const operationId =
          interactionContext.operationId ?? `authoring-interaction-${interactionOrdinal}`;
        const expectedEffect = interactionContext.expectedEffect ?? { type: "none" };

        const outcome = await input.executeInteraction({
          page: page!,
          action,
          ordinal: interactionOrdinal,
          operationId,
          ...(interactionContext.correlationId
            ? { correlationId: interactionContext.correlationId }
            : {}),
          ...(interactionContext.mutationIdentity
            ? { mutationIdentity: interactionContext.mutationIdentity }
            : {}),
          expectedEffect,
          ...(interactionContext.objectiveDelta
            ? { objectiveDelta: interactionContext.objectiveDelta }
            : {}),
          ...(interactionContext.signal ? { signal: interactionContext.signal } : {}),
        });
        const observation = await observe();
        return { ...observation, outcome };
      },

      suspend() {
        if (lifecycle !== "active") {
          throw new Error("AUTHORING_BROWSER_SESSION_NOT_ACTIVE");
        }

        lifecycle = "suspended";
      },

      resume() {
        if (lifecycle !== "suspended") {
          throw new Error("AUTHORING_BROWSER_SESSION_NOT_SUSPENDED");
        }

        lifecycle = "active";
      },

      async cancelActiveOperation() {
        if (closed) return;
        closed = true;
        lifecycle = "crashed";
        try {
          unregisterVeil();
          await context!.close();
        } finally {
          await browser.close().catch(() => undefined);
        }
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
