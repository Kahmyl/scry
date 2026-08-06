import {
  currentActionSchema,
  currentPlanSchema,
  type CurrentAction,
  type ExecutionPolicy,
} from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
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

import { executeAction } from "./action-runtime.js";
import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";

export type AuthoringBrowserSessionState =
  | "active"
  | "suspended"
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
  interact(action: CurrentAction): Promise<{
    documentEpoch: number;
    url: string;
  }>;
  suspend(): void;
  resume(): void;
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

    const plan = currentPlanSchema.parse({
      name: "Interactive authoring",
      objective: "Execute one bounded interactive authoring action",
      preconditions: [],
      allowedOrigins: input.policy.allowedOrigins,
      budgets: {
        maxActions: Math.max(1, input.policy.maxActions ?? 1),
        maxDurationMs: Math.max(
          1_000,
          input.policy.maxDurationMs ?? 30_000,
        ),
        maxNavigations: Math.max(
          1,
          input.policy.maxNavigations ?? 1,
        ),
      },
      checkpoints: [],
      steps: [
        {
          id: "authoring-placeholder",
          title: "Interactive authoring placeholder",
          action: {
            type: "screenshot",
            name: "authoring-placeholder",
            fullPage: false,
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "transient",
          transientJustification:
            "Internal placeholder used only to satisfy the reusable plan contract.",
        },
      ],
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

      async interact(candidate) {
        if (lifecycle !== "active") {
          throw new Error("AUTHORING_BROWSER_SESSION_NOT_ACTIVE");
        }

        const action = currentActionSchema.parse(candidate);

        if (
          action.type === "protectedTransaction" ||
          action.type === "capturePublicValue" ||
          (action.type === "fill" &&
            (action.secretRef ||
              action.capturedSecretRef ||
              action.capturedValueRef ||
              action.generatedValueRef))
        ) {
          throw new Error("AUTHORING_INTERACTION_NOT_ALLOWED");
        }

        interactionOrdinal += 1;

        await executeAction(
          page!,
          action,
          {
            plan,
            policy: input.policy,
            outputDirectory: ".",
            environmentId: input.environmentId,
          },
          new AbortController().signal,
          new SecretRedactor(),
          new Map(),
          new Map(),
          undefined,
          undefined,
          {
            runId: input.sessionId,
            stepId: `authoring-${interactionOrdinal}`,
            channel: "action",
            ordinal: interactionOrdinal,
            allowedOrigins: input.policy.allowedOrigins,
            timeoutMs:
              "timeoutMs" in action && action.timeoutMs
                ? action.timeoutMs
                : 30_000,
          },
        );

        return observe();
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
