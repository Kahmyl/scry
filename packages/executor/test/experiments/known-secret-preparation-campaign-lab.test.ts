import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { InteractionTargetIntent, ProtectedTransaction } from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { executePraxisConsumer, registerPraxisVeilAuthority } from "@scry/praxis";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";

import { executeProtectedPreparation } from "../../src/protected-transaction-preparation.js";
import type { ExecuteOptions } from "../../src/types.js";

const origin = "https://campaign-d.test";
const secret = "campaign-d-synthetic-secret-canary";
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
});

afterAll(async () => {
  await browser?.close();
});

describe("Campaign D: known-secret protected preparation", () => {
  it.each([
    {
      name: "ordinary email input",
      html: '<label>Email<input type="email" placeholder="Enter your email"></label>',
      intent: field("login email", "Enter your email"),
      expected: "succeeded",
    },
    {
      name: "native password input",
      html: '<label>Password<input type="password" placeholder="Enter your password"></label>',
      intent: field("login password", "Enter your password"),
      expected: "succeeded",
    },
    {
      name: "masked editable textbox",
      html: '<label id="password-label">Password</label><div role="textbox" contenteditable="true" aria-labelledby="password-label"></div>',
      intent: labelledField("login password", "Password"),
      expected: "succeeded",
    },
    {
      name: "delayed password form",
      html: '<main id="root"></main><script>setTimeout(() => { document.querySelector("#root").innerHTML = `<label>Password<input type="password" placeholder="Enter your password"></label>` }, 250)</script>',
      intent: field("login password", "Enter your password"),
      expected: "succeeded",
    },
    {
      name: "hidden duplicate plus visible password input",
      html: '<label hidden>Password<input type="password" placeholder="Enter your password"></label><label>Password<input type="password" placeholder="Enter your password"></label>',
      intent: field("login password", "Enter your password"),
      expected: "succeeded",
    },
    {
      name: "two visible equivalent password inputs",
      html: '<label>Password<input type="password" placeholder="Enter your password"></label><label>Password<input type="password" placeholder="Enter your password"></label>',
      intent: field("login password", "Enter your password"),
      expected: "PRAXIS_TARGET_AMBIGUOUS",
    },
  ])("characterizes $name", async ({ html, intent, expected }) => {
    const page = await openPage(html);
    try {
      const result = await runPraxis(page, intent);
      expect(result.status === "succeeded" ? "succeeded" : result.code).toBe(expected);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toMatch(/selector|xpath|runtimeId|browserHandle|outerHTML|innerHTML/i);
    } finally {
      await page.context().close();
    }
  });

  it("executes the full protected-preparation wrapper for a password input", async () => {
    const page = await openPage(
      '<label>Password<input type="password" placeholder="Enter your password"></label>',
    );
    try {
      await executeProtectedPreparation(page, transaction(field("login password", "Enter your password")), {
        allowedOrigins: [origin],
        redactor: new SecretRedactor(),
        resolveKnownSecret: async () => secret,
        verifyAssertions: async () => undefined,
      } as never);
      expect(await page.getByPlaceholder("Enter your password").inputValue()).toBe(secret);
    } finally {
      await page.context().close();
    }
  });

  it("reproduces the Vitract failure when cloned authentication is combined with full-history replay", async () => {
    const page = await openAuthenticatedReplayPage();
    const operation = transaction(field("login email", "Enter your email"));
    operation.preparation.actions.unshift({
      type: "navigate",
      url: `${origin}/login`,
      effect: "read_only",
      timeoutMs: 2_000,
    });
    try {
      await expect(
        executeProtectedPreparation(page, operation, {
          allowedOrigins: [origin],
          redactor: new SecretRedactor(),
          resolveKnownSecret: async () => secret,
          verifyAssertions: async () => undefined,
        } as never),
      ).rejects.toMatchObject({
        code: "PREPARATION_PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL",
        retryClass: "safe_to_retry",
      });
      expect(page.url()).toBe(`${origin}/login`);
      const underlying = await runPraxis(page, field("login email", "Enter your email"));
      expect(underlying).toMatchObject({
        status: "failed",
        code: "PRAXIS_NO_CAPABILITY_COMPATIBLE_CONTROL",
        mutationOutcome: "not_started",
      });
    } finally {
      await page.context().close();
    }
  });

  it("reconstructs ephemeral UI with native-first suffix replay", async () => {
    const page = await openAuthenticatedReplayPage();
    const nativeOperations: string[] = [];
    const executeNativeControl: NonNullable<ExecuteOptions["executeNativeControl"]> =
      async (_page, target, nativeOperation) => {
        nativeOperations.push(nativeOperation.type);
        const name = target.preferredEvidence.names[0]!;
        if (nativeOperation.type === "click") {
          await page.getByRole("button", { name, exact: true }).click();
          return;
        }
        if (nativeOperation.type === "fill") {
          await page.getByRole("textbox", { name, exact: true }).fill(nativeOperation.value);
          return;
        }
        throw new Error("NATIVE_TARGET_NOT_FOUND");
      };
    const operation = transaction(field("unused", "unused"));
    operation.inputs = {
      credentialName: { classification: "public", value: "Campaign D credential" },
    };
    operation.preparation.actions = [
      {
        type: "clickNavigation",
        target: button("Add credential"),
        expectedEffect: { type: "none" },
        effect: "read_only",
        timeoutMs: 2_000,
      },
      {
        type: "fillPublicInput",
        input: "credentialName",
        target: labelledField("credential name", "Name"),
        effect: "replayable_setup",
        timeoutMs: 2_000,
      },
    ];
    try {
      await expect(
        executeProtectedPreparation(page, operation, {
          allowedOrigins: [origin],
          redactor: new SecretRedactor(),
          resolveKnownSecret: async () => secret,
          verifyAssertions: async () => undefined,
          executeNativeControl,
        } as never),
      ).resolves.toBeUndefined();
      expect(nativeOperations).toEqual(["click", "fill"]);
      expect(page.url()).toBe(`${origin}/partner/credentials`);
      expect(await page.getByRole("dialog", { name: "Add credential" }).isVisible()).toBe(true);
      expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe(
        "Campaign D credential",
      );
    } finally {
      await page.context().close();
    }
  });
});

async function openPage(html: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto(`${origin}/login`);
  registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
    ),
    userId: "campaign-d",
    environmentId: "campaign-d",
    browserContextId: "campaign-d",
  });
  return page;
}

async function openAuthenticatedReplayPage() {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "session", value: "authenticated", url: origin },
  ]);
  const page = await context.newPage();
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/login") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><main>Authenticated sessions do not render the login form</main>",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><button aria-label="Add credential" onclick="document.querySelector('dialog').showModal()">Add credential</button><dialog aria-label="Add credential"><label>Name<input aria-label="Name"></label></dialog>`,
    });
  });
  await page.goto(`${origin}/partner/credentials`);
  registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
    ),
    userId: "campaign-d",
    environmentId: "campaign-d",
    browserContextId: "campaign-d-authenticated",
  });
  return page;
}

async function runPraxis(page: Page, intent: InteractionTargetIntent) {
  return executePraxisConsumer({
    page,
    intent,
    operation: {
      type: "enter_text",
      input: { reference: "synthetic-reference", classification: "known_secret" },
    },
    context: {
      stepId: "campaign-d",
      channel: "protected",
      ordinal: 0,
      allowedOrigins: [origin],
      timeoutMs: 2_000,
      privacy: {
        state: "protected",
        allowedChannels: ["public_dom", "accessibility"],
        suppressedChannels: ["visual", "ocr"],
      },
    },
    signal: new AbortController().signal,
    resolveInput: async () => secret,
  });
}

function field(concept: string, placeholder: string): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: ["focusable", "accepts_text", "editable", "readable_value"],
    preferredEvidence: {
      roles: ["textbox"],
      names: [],
      labels: [],
      descriptions: [],
      placeholders: [placeholder],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "authentication",
    confidence: { requiredFamilies: [] },
    matching: "exact",
  };
}

function labelledField(concept: string, label: string): InteractionTargetIntent {
  const intent = field(concept, "");
  intent.preferredEvidence.labels = [label];
  intent.preferredEvidence.placeholders = [];
  return intent;
}

function transaction(target: InteractionTargetIntent): ProtectedTransaction {
  return {
    type: "protectedTransaction",
    operationId: "campaign-d-known-secret",
    entry: { url: `${origin}/login`, assertions: [] },
    inputs: {
      login: { classification: "known_secret", credentialRef: "synthetic-reference" },
    },
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [
        {
          type: "fillKnownSecret",
          input: "login",
          target,
          effect: "replayable_setup",
          timeoutMs: 2_000,
        },
      ],
      assertions: [],
    },
    mutation: {
      action: {
        type: "click",
        target: button("submit"),
        expectedEffect: { type: "none" },
        timeoutMs: 2_000,
      },
      kind: "one_time",
      reconciliation: { strategy: "persisted_outputs", requiredReferences: ["value"] },
    },
    extraction: {
      outputs: [
        {
          classification: "protected",
          reference: "value",
          acquisition: {
            target: { ...target, requiredCapabilities: ["readable_value"] },
            classification: "unknown_secret",
            permittedMethods: ["input_value"],
            objective: { kind: "capture_value", expectedValueType: "unknown_secret" },
            validation: { minimumLength: 1, maximumLength: 100 },
          },
          storage: { credentialName: "Synthetic", scope: "project" },
        },
      ],
      timeoutMs: 2_000,
      scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: {
      ceremonyIntent: button("submit"),
      expectedContainerModel: {
        version: 2,
        digest: "a".repeat(64),
        concept: "synthetic",
        scopeKind: "page",
        capabilityDigest: "b".repeat(64),
        structuralPath: [],
      },
      valueIntent: { ...target, requiredCapabilities: ["readable_value"] },
      approvedMethods: ["input_value"],
      minimumConfidence: 0.5,
      minimumConfidenceMargin: 0,
      recoveryPolicy: "abandon",
      recoveryWindowMs: 1_000,
    },
    continuation: { strategies: [] },
  };
}

function button(concept: string): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: ["focusable", "pointer_activatable"],
    preferredEvidence: {
      roles: ["button"],
      names: [concept],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "protected",
    confidence: { requiredFamilies: [] },
    matching: "exact",
  };
}
