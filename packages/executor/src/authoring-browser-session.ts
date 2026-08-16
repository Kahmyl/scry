import {
  currentActionSchema,
  operationOutcomeSchema,
  type CurrentAction,
  type ExecutionPolicy,
  type ExpectedEffect,
  type OperationOutcome,
} from "@scry/contracts";
import {
  closePraxisPage,
  closePraxisBrowser,
  closePraxisContext,
  createPraxisExpectedPageOwnership,
  observeSemanticPageContext,
  playwrightBrowserChannel,
  registerPraxisVeilAuthority,
  settlePraxisPopup,
  installThirdPartyScriptFence,
  waitForPraxisLoadState,
} from "@scry/praxis";
import { VeilAuthority, VeilRuntimeCoordinator } from "@scry/veil";
import type { Browser, BrowserContext, Page } from "playwright";

import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";
import { BrowserSessionProvenance } from "./browser-session.js";
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
    semanticPageContext: NonNullable<OperationOutcome["semanticPageContext"]>;
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
  protection?: "ordinary" | "protected";
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
    const pageOwnership = createPraxisExpectedPageOwnership(context, () => page!);
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
    const provenance = new BrowserSessionProvenance(
      `authoring-${input.sessionId}`,
      input.protection === "protected" ? "protected" : "safe",
    );

    browser.on("disconnected", () => {
      if (!closed) {
        lifecycle = "crashed";
      }
    });

    async function observe(maximumWaitMs?: number) {
      if (lifecycle !== "active") {
        throw new Error("AUTHORING_BROWSER_SESSION_NOT_ACTIVE");
      }

      await waitForPraxisLoadState(
        page!,
        "domcontentloaded",
        maximumWaitMs === undefined ? {} : { timeout: maximumWaitMs },
      );

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

      const semanticPageContext = await observeSemanticPageContext(page!);
      return {
        documentEpoch: epoch,
        url: page!.url(),
        semanticPageContext,
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
                      throw newPageOriginNotAllowed(rejectedDocumentUrl);
                    }
                    if (candidates.length === 0) return undefined;
                    if (candidates.length !== 1) {
                      await Promise.all(candidates.map(closePraxisPage));
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
                    await settlePraxisPopup(popup, popupTimeoutMs);
                    if (popup === page) throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
                    const popupOrigin = new URL(popup.url()).origin;
                    if (
                      !input.policy.allowedOrigins.includes(popupOrigin) ||
                      (expectedEffect.type === "new_page" &&
                        expectedEffect.origin &&
                        popupOrigin !== new URL(expectedEffect.origin).origin)
                    ) {
                      await closePraxisPage(popup);
                      throw newPageOriginNotAllowed(popupOrigin);
                    }
                    const previousPage = page!;
                    page = popup;
                    popupCandidate.adopt(popup);
                    unregisterVeil.push(registerPraxisVeilAuthority(popup, veilRegistration));
                    await closePraxisPage(previousPage);
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
        const observation = await observe(1_500).catch(() => ({
          documentEpoch: epoch,
          url: page!.url(),
        }));
        // Context enrichment is informational. Its failure must never erase a
        // completed interaction outcome or manufacture mutation uncertainty.
        const semanticPageContext = await observeSettledSemanticPageContext({
          page: page!,
          settle: action.type === "navigate" || expectedEffect.type === "navigation"
            || expectedEffect.type === "new_page",
          ...(interactionContext.signal ? { signal: interactionContext.signal } : {}),
          maximumWaitMs: Math.min(
            1_500,
            "timeoutMs" in action && typeof action.timeoutMs === "number" ? action.timeoutMs : 1_500,
          ),
        }).catch(
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
          await boundedAuthoringClose("authoring_context_cancel", () => closePraxisContext(context!));
        } finally {
          await boundedAuthoringClose("authoring_browser_cancel", () => closePraxisBrowser(browser)).catch(() =>
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
          await boundedAuthoringClose("authoring_context_close", () => closePraxisContext(context!));
        } finally {
          await boundedAuthoringClose("authoring_browser_close", () => closePraxisBrowser(browser)).catch(
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
    if (context) await closePraxisContext(context).catch(() => undefined);
    await closePraxisBrowser(browser).catch(() => undefined);
    throw error;
  }
}

function newPageOriginNotAllowed(url: string) {
  const missingAllowedOrigin = new URL(url).origin;
  return Object.assign(new Error("EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED"), {
    safeNavigationEnvironmentFailure: { missingAllowedOrigin },
  });
}

async function observeSettledSemanticPageContext(input: {
  page: Page;
  settle: boolean;
  signal?: AbortSignal;
  maximumWaitMs: number;
}) {
  if (!input.settle) return observeSemanticPageContext(input.page);
  const deadline = performance.now() + input.maximumWaitMs;
  let priorSignature: string | undefined;
  while (!input.signal?.aborted && performance.now() <= deadline) {
    const context = await observeSemanticPageContext(input.page);
    if (context.controls.length > 0) {
      const signature = JSON.stringify({
        authority: {
          pageId: context.authority.pageId,
          documentEpoch: context.authority.documentEpoch,
          url: context.authority.url,
        },
        controls: context.controls.map(({ reference: _reference, ...control }) => control),
      });
      if (signature === priorSignature) return context;
      priorSignature = signature;
    } else {
      priorSignature = undefined;
    }
    await boundedDelay(Math.min(75, Math.max(0, deadline - performance.now())), input.signal);
  }
  // An empty or still-changing snapshot is not stable evidence. The completed
  // interaction remains authoritative; callers may make a fresh observation.
  return undefined;
}

function boundedDelay(milliseconds: number, signal?: AbortSignal) {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
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
