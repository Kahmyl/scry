import {
  currentActionSchema,
  type CurrentAction,
  type ExecutionPolicy,
  type ExpectedEffect,
  type OperationOutcome,
} from "@scry/contracts";
import { playwrightBrowserChannel, registerPraxisVeilAuthority } from "@scry/praxis";
import { VeilAuthority, VeilRuntimeCoordinator } from "@scry/veil";
import type { Browser, BrowserContext, Page } from "playwright";

import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";
import { BrowserSessionProvenance } from "./browser-session.js";

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
  openBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }>;
  executeInteraction(input: {
    browser: Browser;
    context: BrowserContext;
    provenance: BrowserSessionProvenance;
    page: Page;
    action: CurrentAction;
    ordinal: number;
    operationId: string;
    correlationId?: string;
    mutationIdentity?: string;
    expectedEffect?: ExpectedEffect;
    resolveEffectPage?: () => Promise<Page | undefined>;
    objectiveDelta?: string;
    signal?: AbortSignal;
    privacyGate: VeilRuntimeCoordinator;
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

  playwrightBrowserChannel(input.browserChannel);
  const opened = await input.openBrowser();
  const browser = opened.browser;
  let context: BrowserContext | undefined = opened.context;
  let page: Page | undefined = opened.page;

  try {
    const veilPolicy = resolveVeilPolicyForExecution(input.policy);
    const veilRegistration = {
      authority: new VeilAuthority(veilPolicy),
      userId: "probe-authoring",
      environmentId: input.environmentId,
      browserContextId: `probe-authoring-${input.sessionId}`,
    };
    const unregisterVeil = [registerPraxisVeilAuthority(page, veilRegistration)];
    const privacyGate = new VeilRuntimeCoordinator(
      [],
      async () => undefined,
      5_000,
      veilPolicy.digest,
      `authoring:${input.sessionId}`,
    );

    let lifecycle: AuthoringBrowserSessionState = "active";
    let epoch = 0;
    let lastDocumentToken: string | undefined;
    let interactionOrdinal = 0;
    let closed = false;
    const provenance = new BrowserSessionProvenance(`authoring-${input.sessionId}`, "safe");

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
      get page() {
        return page!;
      },

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
        const popupCandidate =
          (action.type === "click" || action.type === "press") &&
          expectedEffect.type === "new_page"
            ? waitForPopup(context!, ("timeoutMs" in action ? action.timeoutMs : undefined) ?? 10_000)
            : undefined;

        const outcome = await input
          .executeInteraction({
            browser,
            context: context!,
            provenance,
            page: page!,
            action,
            ordinal: interactionOrdinal,
            operationId,
            privacyGate,
            ...(interactionContext.correlationId
              ? { correlationId: interactionContext.correlationId }
              : {}),
            ...(interactionContext.mutationIdentity
              ? { mutationIdentity: interactionContext.mutationIdentity }
              : {}),
            expectedEffect,
            ...(popupCandidate
              ? {
                  resolveEffectPage: async () => {
                    const popup = await popupCandidate.resolve();
                    if (!popup) return undefined;
                    const popupTimeoutMs = ("timeoutMs" in action ? action.timeoutMs : undefined) ?? 10_000;
                    await popup.waitForURL((url) => url.href !== "about:blank", { timeout: popupTimeoutMs })
                      .catch(() => { throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED"); });
                    await popup.waitForLoadState("domcontentloaded", { timeout: popupTimeoutMs })
                      .catch(() => { throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED"); });
                    if (popup === page) throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
                    const popupOrigin = new URL(popup.url()).origin;
                    if (!input.policy.allowedOrigins.includes(popupOrigin) ||
                      (expectedEffect.type === "new_page" && expectedEffect.origin && popupOrigin !== new URL(expectedEffect.origin).origin)) {
                      await popup.close().catch(() => undefined);
                      throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
                    }
                    page = popup;
                    unregisterVeil.push(registerPraxisVeilAuthority(popup, veilRegistration));
                    return popup;
                  },
                }
              : {}),
            ...(interactionContext.objectiveDelta
              ? { objectiveDelta: interactionContext.objectiveDelta }
              : {}),
            ...(interactionContext.signal ? { signal: interactionContext.signal } : {}),
          })
          .finally(() => popupCandidate?.dispose());
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
          unregisterVeil.forEach((unregister) => unregister());
          await privacyGate.seal({ code: "AUTHORING_OPERATION_CANCELLED" }).catch(() => undefined);
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
        unregisterVeil.forEach((unregister) => unregister());
        await privacyGate.finalize().catch(() => undefined);

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

function waitForPopup(context: BrowserContext, timeoutMs: number) {
  let settled = false;
  let resolve!: (page: Page | undefined) => void;
  const result = new Promise<Page | undefined>((done) => {
    resolve = done;
  });
  const onPage = async (candidate: Page) => {
    if (settled) return;
    settled = true;
    // The event establishes distinct ownership immediately. Readiness is bounded by
    // the operation timeout in resolveEffectPage, never by this listener's race.
    resolve(candidate);
  };
  context.on("page", onPage);
  return {
    resolve: () =>
      Promise.race([
        result,
        new Promise<undefined>((done) => setTimeout(() => done(undefined), timeoutMs)),
      ]),
    dispose() {
      settled = true;
      context.off("page", onPage);
      resolve(undefined);
    },
  };
}
