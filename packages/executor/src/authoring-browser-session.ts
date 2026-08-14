import {
  currentActionSchema,
  operationOutcomeSchema,
  type CurrentAction,
  type ExecutionPolicy,
  type ExpectedEffect,
  type OperationOutcome,
} from "@scry/contracts";
import {
  observeSemanticPageContext,
  playwrightBrowserChannel,
  registerPraxisVeilAuthority,
} from "@scry/praxis";
import { VeilAuthority, VeilRuntimeCoordinator } from "@scry/veil";
import type { Browser, BrowserContext, Page } from "playwright";

import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";
import { BrowserSessionProvenance } from "./browser-session.js";
import { installThirdPartyScriptFence } from "./native-browser-navigation.js";
import { runProtectedStage } from "./protected-stage-supervisor.js";

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
  openBrowser(): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
    forceClose?: () => Promise<void>;
    browserProcessId?: number;
  }>;
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
  const forceClose = opened.forceClose;
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
    const pageOwnership = expectedPageOwnership(context, () => page!);
    const allowedDocumentOrigins = new Set(input.policy.allowedOrigins);
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.resourceType() !== "document") return route.continue();
      try {
        if (allowedDocumentOrigins.has(new URL(request.url()).origin)) return route.continue();
      } catch {
        // Invalid document URLs are denied below.
      }
      pageOwnership.rejectDocument(request.url());
      await route.abort("blockedbyclient");
    });
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
          (action.type === "click" || action.type === "press") && expectedEffect.type === "new_page"
            ? pageOwnership.arm(("timeoutMs" in action ? action.timeoutMs : undefined) ?? 10_000)
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
                    const { candidates, rejectedDocumentUrl } = await popupCandidate.resolve();
                    if (rejectedDocumentUrl) {
                      throw new Error("EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED");
                    }
                    if (candidates.length === 0) return undefined;
                    if (candidates.length !== 1) {
                      await Promise.all(
                        candidates.map((candidate) => candidate.close().catch(() => undefined)),
                      );
                      throw new Error("EXPECTED_NEW_PAGE_AMBIGUOUS");
                    }
                    const popup = candidates[0]!;
                    const popupTimeoutMs =
                      ("timeoutMs" in action ? action.timeoutMs : undefined) ?? 10_000;
                    await installThirdPartyScriptFence(
                      popup,
                      new Set([
                        ...input.policy.allowedOrigins,
                        ...(input.policy.trustedScriptOrigins ?? []),
                      ]),
                    );
                    await popup
                      .waitForURL((url) => url.href !== "about:blank", { timeout: popupTimeoutMs })
                      .catch(() => {
                        throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
                      });
                    await popup
                      .waitForLoadState("domcontentloaded", { timeout: popupTimeoutMs })
                      .catch(() => {
                        throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
                      });
                    if (popup === page) throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
                    const popupOrigin = new URL(popup.url()).origin;
                    if (
                      !input.policy.allowedOrigins.includes(popupOrigin) ||
                      (expectedEffect.type === "new_page" &&
                        expectedEffect.origin &&
                        popupOrigin !== new URL(expectedEffect.origin).origin)
                    ) {
                      await popup.close().catch(() => undefined);
                      throw new Error("EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED");
                    }
                    const previousPage = page!;
                    page = popup;
                    popupCandidate.adopt(popup);
                    unregisterVeil.push(registerPraxisVeilAuthority(popup, veilRegistration));
                    await previousPage.close().catch(() => undefined);
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
        // Context enrichment is informational. Its failure must never erase a
        // completed interaction outcome or manufacture mutation uncertainty.
        const semanticPageContext = await observeSemanticPageContext(page!).catch(
          (error: unknown) => {
            console.warn(
              "SEMANTIC_PAGE_CONTEXT_UNAVAILABLE",
              error instanceof Error ? error.message : "UNKNOWN_CONTEXT_FAILURE",
            );
            return undefined;
          },
        );
        return {
          ...observation,
          outcome: operationOutcomeSchema.parse({
            ...outcome,
            ...(semanticPageContext ? { semanticPageContext } : {}),
          }),
        };
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
          await boundedAuthoringClose("authoring_context_cancel", () => context!.close());
        } finally {
          await boundedAuthoringClose("authoring_browser_cancel", () => browser.close()).catch(() =>
            forceClose?.(),
          );
        }
      },

      async close() {
        if (closed) {
          return;
        }

        closed = true;
        lifecycle = "releasing";
        unregisterVeil.forEach((unregister) => unregister());
        await boundedAuthoringClose("authoring_veil_finalize", () => privacyGate.finalize()).catch(
          () => privacyGate.seal({ code: "AUTHORING_FINALIZATION_TIMEOUT" }),
        );

        try {
          await boundedAuthoringClose("authoring_context_close", () => context!.close());
        } finally {
          await boundedAuthoringClose("authoring_browser_close", () => browser.close()).catch(
            async (error) => {
              if (!forceClose) throw error;
              await boundedAuthoringClose("authoring_browser_force_close", forceClose);
            },
          );
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

function boundedAuthoringClose(stage: string, work: () => Promise<unknown>) {
  return runProtectedStage({
    stage,
    timeoutMs: 2_000,
    timeoutCode: "AUTHORING_BROWSER_CLOSE_TIMEOUT",
    dispatchPosition: "post_dispatch",
    work,
  });
}

function expectedPageOwnership(context: BrowserContext, currentPage: () => Page) {
  type Capture = {
    pages: Page[];
    adopted?: Page;
    rejectedDocumentUrl?: string;
    first: Promise<void>;
    signalFirst: () => void;
  };
  let active: Capture | undefined;
  context.on("page", (candidate) => {
    if (candidate === currentPage()) return;
    if (!active) {
      void candidate.close().catch(() => undefined);
      return;
    }
    active.pages.push(candidate);
    active.signalFirst();
  });
  return {
    rejectDocument(url: string) {
      if (!active) return;
      active.rejectedDocumentUrl ??= url;
      active.signalFirst();
    },
    arm(timeoutMs: number) {
      if (active) throw new Error("EXPECTED_NEW_PAGE_CAPTURE_ALREADY_ACTIVE");
      let signalFirst!: () => void;
      const capture: Capture = {
        pages: [],
        first: new Promise<void>((resolve) => {
          signalFirst = resolve;
        }),
        signalFirst: () => signalFirst(),
      };
      active = capture;
      return {
        async resolve() {
          await Promise.race([
            capture.first,
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
          ]);
          if (capture.pages.length) await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            candidates: [...capture.pages],
            rejectedDocumentUrl: capture.rejectedDocumentUrl,
          };
        },
        adopt(page: Page) {
          capture.adopted = page;
        },
        async dispose() {
          if (active === capture) active = undefined;
          await Promise.all(
            capture.pages
              .filter((candidate) => candidate !== capture.adopted)
              .map((candidate) => candidate.close().catch(() => undefined)),
          );
        },
      };
    },
  };
}
