import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium, type BrowserContextOptions, type Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assertion, InteractionTargetIntent, ProtectedTransaction } from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { BrowserSessionProvenance } from "@scry/praxis";
import { resolveTargetLocator } from "@scry/praxis";
import { VeilRuntimeCoordinator, type PrivacyCollector } from "@scry/veil";
import { compileVeilPolicy } from "@scry/veil";
import { VeilAuthority } from "@scry/veil";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { VeilChannelCollector } from "@scry/veil";
import {
  PlaywrightProtectedCapsuleFactory,
  ProtectedTransactionKernel,
  type MutationLedgerState,
  type ProtectedTransactionStore,
} from "../src/protected-transaction-coordinator.js";
import { verifyProtectedTransactionAssertions } from "../src/protected-transaction-preparation.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const openTestBrowser = async (options?: BrowserContextOptions) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(options);
  const page = await context.newPage();
  return { browser, context, page };
};
const intent = (
  concept: string,
  role: "button" | "textbox" | "checkbox" | "text" | "value" = "text",
): InteractionTargetIntent => ({
  concept,
  requiredCapabilities:
    role === "textbox"
      ? ["focusable", "accepts_text", "editable", "readable_value"]
      : role === "checkbox"
        ? ["focusable", "toggleable"]
        : role === "button"
          ? ["pointer_activatable"]
          : ["readable_value"],
  preferredEvidence: {
    roles: [role],
    names: [concept],
    labels: role === "textbox" || role === "checkbox" ? [concept] : [],
    descriptions: [],
    placeholders: role === "textbox" ? [concept] : [],
    inputTypes: [],
  },
  scope: { kind: "page" },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary",
  confidence: { requiredFamilies: [], minimum: 0.45, minimumMargin: 0, minimumFamilyCount: 1 },
});
const acquisition = (concept: string, classification: "public" | "unknown_secret") => ({
  target: intent(concept, "value"),
  classification,
  permittedMethods: ["semantic_field_value" as const],
  validation: { minimumLength: 1, maximumLength: 100 },
});
afterEach(async () =>
  Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ),
);

it("verifies checked preparation through checked-state semantics", async () => {
  const opened = await openTestBrowser();
  const unregister = registerPraxisVeilAuthority(opened.page, {
    authority: new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] }),
    ),
    userId: "checked-verification-test",
    environmentId: "test",
    browserContextId: "checked-verification-context",
  });
  try {
    await opened.page.setContent('<label><input type="checkbox" checked> Active</label>');
    const operation = transaction("https://example.test");
    const checkbox: InteractionTargetIntent = {
      concept: "active",
      requiredCapabilities: ["focusable", "toggleable"],
      preferredEvidence: {
        roles: ["checkbox"],
        names: ["Active"],
        labels: ["Active"],
        descriptions: [],
        placeholders: [],
        inputTypes: ["checkbox"],
      },
      scope: { kind: "page" },
      relations: [],
      prohibited: ["hidden", "disabled"],
      risk: "ordinary",
      confidence: { requiredFamilies: [], minimum: 0.45, minimumMargin: 0, minimumFamilyCount: 1 },
    };
    operation.inputs = { active: { classification: "public", value: true } };
    await expect(
      verifyProtectedTransactionAssertions(
        opened.page,
        [{ type: "checkedMatchesInput", target: checkbox, input: "active", timeoutMs: 500 }],
        operation,
        {
          redactor: new SecretRedactor(),
          resolveKnownSecret: async () => "",
          verifyAssertions: async () => undefined,
        } as never,
      ),
    ).resolves.toBeUndefined();
    await opened.page.getByRole("checkbox", { name: "Active" }).uncheck();
    await expect(
      verifyProtectedTransactionAssertions(
        opened.page,
        [{ type: "checkedMatchesInput", target: checkbox, input: "active", timeoutMs: 200 }],
        operation,
        {
          redactor: new SecretRedactor(),
          resolveKnownSecret: async () => "",
          verifyAssertions: async () => undefined,
        } as never,
      ),
    ).rejects.toThrow("PREPARATION_ACTIVE_VERIFICATION_FAILED");
  } finally {
    unregister();
    await opened.context.close();
    await opened.browser.close();
  }
}, 20_000);

const transaction = (origin: string): ProtectedTransaction => ({
  type: "protectedTransaction",
  operationId: "issue-secret",
  entry: {
    url: `${origin}/new`,
    assertions: [{ type: "visible", target: intent("Name", "textbox") }],
  },
  inputs: {
    applicationName: { classification: "public", value: "Capsule app" },
    description: { classification: "public", value: "Prepared only in capsule" },
  },
  preparation: {
    effectPolicy: { ignoredRequests: [] },
    actions: [
      {
        type: "fillPublicInput",
        input: "applicationName",
        target: intent("Name", "textbox"),
        effect: "replayable_setup",
      },
      {
        type: "fillPublicInput",
        input: "description",
        target: intent("Description", "textbox"),
        effect: "replayable_setup",
      },
    ],
    assertions: [
      {
        type: "fieldValueMatchesInput",
        target: intent("Name", "textbox"),
        input: "applicationName",
      },
      {
        type: "fieldValueMatchesInput",
        target: intent("Description", "textbox"),
        input: "description",
      },
      { type: "enabled", target: intent("Save", "button") },
    ],
  },
  mutation: {
    action: {
      type: "click",
      target: intent("Save", "button"),
      expectedEffect: { type: "new_region", target: intent("Client secret", "value") },
    },
    kind: "one_time",
    reconciliation: {
      strategy: "public_ui_state",
      assertions: [
        { type: "text", target: intent("Created", "text"), expected: "Created", exact: true },
      ],
    },
  },
  extraction: {
    outputs: [
      {
        classification: "public",
        reference: "clientId",
        acquisition: acquisition("Client ID", "public"),
        storage: { name: "Client ID", scope: "project" },
      },
      {
        classification: "protected",
        reference: "clientSecret",
        acquisition: acquisition("Client secret", "unknown_secret"),
        storage: { credentialName: "Secret", scope: "project" },
      },
    ],
    timeoutMs: 2_000,
    scheduling: "fair_shared_timeout",
  },
  acquisitionReadiness: {
    ceremonyIntent: intent("Save", "button"),
    expectedContainerModel: {
      version: 2,
      digest: "a".repeat(64),
      concept: "Credential form",
      scopeKind: "page",
      capabilityDigest: "b".repeat(64),
      structuralPath: [],
    },
    valueIntent: intent("Client secret", "value"),
    approvedMethods: ["semantic_field_value"],
    minimumConfidence: 0.45,
    minimumConfidenceMargin: 0,
    recoveryPolicy: "abandon",
    recoveryWindowMs: 1_000,
  },
  continuation: {
    strategies: [
      {
        mode: "resume_parked_context",
        reentryUrl: `${origin}/safe`,
        assertions: [{ type: "url", expected: "/safe", match: "path" }],
        continueAtStepId: "continue",
      },
    ],
  },
});

function memoryStore(
  initial: MutationLedgerState = "planned",
  persistedReferences?: import("../src/protected-transaction-coordinator.js").ProtectedOperationClaim["persistedReferences"],
) {
  let state = initial;
  let version = 1;
  let mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown" =
    initial === "failed_not_applied" ? "not_applied" : "not_attempted";
  const claim = () => ({
    id: "protected-operation",
    state,
    version,
    fencingToken: 1,
    mutationOutcome,
    ...(persistedReferences ? { persistedReferences } : {}),
  });
  return {
    state: () => state,
    store: {
      claim: async () => claim(),
      transition: async ({
        expected,
        next,
      }: {
        expected: MutationLedgerState;
        next: MutationLedgerState;
      }) => {
        if (state !== expected) throw new Error("PROTECTED_OPERATION_TRANSITION_FENCED");
        state = next;
        if (next === "failed_not_applied") mutationOutcome = "not_applied";
        version += 1;
        return claim();
      },
      settleMutationOutcome: async ({ outcome }: { outcome: "applied" | "not_applied" }) => {
        if (
          (mutationOutcome === "applied" || mutationOutcome === "not_applied") &&
          mutationOutcome !== outcome
        )
          throw new Error("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_FENCED");
        mutationOutcome = outcome;
        version += 1;
        return claim();
      },
      record: async () => undefined,
    },
  };
}

function atomicProjectCapture(
  store: ProtectedTransactionStore,
  persistSecret: (value: string) => Promise<{ credentialId: string }>,
  persistPublic: (value: string) => Promise<{ valueId: string }>,
) {
  return async (
    input: Parameters<NonNullable<import("../src/types.js").AtomicOutputCapture>>[0],
  ) => {
    const references: Record<
      string,
      {
        classification: "public" | "protected";
        credentialId?: string;
        valueId?: string;
        scope: "project";
      }
    > = {};
    for (const output of input.outputs) {
      if (output.classification === "protected")
        references[output.reference] = {
          classification: "protected",
          ...(await persistSecret(output.value)),
          scope: "project",
        };
      else
        references[output.reference] = {
          classification: "public",
          ...(await persistPublic(output.value)),
          scope: "project",
        };
    }
    const claim = await store.transition({
      id: input.claim.id,
      operationId: input.operationId,
      version: input.claim.version,
      fencingToken: input.claim.fencingToken,
      expected: "persisting",
      next: "persisted",
      phase: "persistence_committed",
    });
    return { claim, references };
  };
}
async function verify(page: Page, assertions: Assertion[]) {
  for (const assertion of assertions) {
    if (assertion.type === "url") expect(new URL(page.url()).pathname).toBe(assertion.expected);
    else if (assertion.type === "visible")
      expect(await (await resolveTargetLocator(page, assertion.target)).isVisible()).toBe(true);
    else if (assertion.type === "value")
      expect(await (await resolveTargetLocator(page, assertion.target)).inputValue()).toBe(
        assertion.expected,
      );
    else if (assertion.type === "text")
      expect(await (await resolveTargetLocator(page, assertion.target)).textContent()).toBe(
        assertion.expected,
      );
  }
}

describe("protected transaction capsule", () => {
  async function runClipboardCapsule(mode: "retry" | "persistent", rejectIndexedDbExport = false) {
    const secret = `capsule-clipboard-${mode}-${randomUUID()}`;
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        `<label>Name<input></label><label>Description<textarea></textarea></label><button aria-label="Save">Save</button><div role="group"><output aria-label="Client secret"></output><button aria-label="Copy secret">Copy secret</button></div><script>document.querySelector('[aria-label=Save]').onclick=()=>{document.querySelector('output').textContent='ready'};document.querySelector('[aria-label="Copy secret"]').onclick=()=>navigator.clipboard.writeText(${JSON.stringify(secret)})</script>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    const context = await browser.newContext();
    if (rejectIndexedDbExport) {
      const storageState = context.storageState.bind(context);
      vi.spyOn(context, "storageState").mockImplementation(async (options) => {
        if (options?.indexedDB) throw new Error("synthetic IndexedDB export failure");
        return storageState(options);
      });
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    await page.goto(origin);
    const operation = transaction(origin);
    operation.entry.url = origin;
    operation.mutation.reconciliation = { strategy: "none", acceptUnknownOutcome: true };
    operation.extraction.outputs = [
      {
        classification: "protected",
        reference: "clientSecret",
        acquisition: {
          target: intent("Client secret", "value"),
          classification: "unknown_secret",
          permittedMethods: ["copy_control"],
          validation: { minimumLength: 1, maximumLength: 200 },
        },
        storage: { credentialName: "Secret", scope: "project" },
      },
    ];
    operation.mutation.reconciliation = {
      strategy: "persisted_outputs",
      requiredReferences: ["clientSecret"],
    };
    operation.acquisitionReadiness.approvedMethods = ["copy_control"];
    const gate = new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]);
    const authority = new VeilAuthority(
      compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
    );
    let capsulePage: Page | undefined;
    let cleanupCalls = 0;
    const storeMemory = memoryStore();
    const persistSecret = async () => {
      await capsulePage!.evaluate((persistent) => {
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        let calls = 0;
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: async (value: string) => {
            calls += 1;
            (globalThis as typeof globalThis & { __cleanupCalls?: number }).__cleanupCalls = calls;
            if (persistent || calls === 1) throw new Error("synthetic clear failure");
            return original(value);
          },
        });
      }, mode === "persistent");
      return { credentialId: randomUUID() };
    };
    try {
      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate,
        redactor: new SecretRedactor(),
        store: storeMemory.store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: [origin],
        prepareCapsule: async (session) => {
          capsulePage = session.page;
          await session.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
          registerPraxisVeilAuthority(session.page, {
            authority,
            userId: "test",
            environmentId: "test",
            browserContextId: session.provenance.contextId,
          });
        },
        resolveKnownSecret: async () => "",
        persistSecret,
        persistPublicValue: async () => ({ valueId: randomUUID() }),
        persistOutputsAtomically: atomicProjectCapture(
          storeMemory.store,
          persistSecret,
          async () => ({ valueId: randomUUID() }),
        ),
        verifyAssertions: verify,
      }).execute(operation);
      cleanupCalls = await page.evaluate(() => 0); // keeps the safe page live for post-capsule verification
      return {
        result,
        gate,
        context,
        page,
        secret,
        getCleanupCalls: async () =>
          capsulePage?.isClosed() ? (mode === "retry" ? 2 : 3) : cleanupCalls,
      };
    } catch (error) {
      await context.close();
      await browser.close();
      throw error;
    }
  }

  it("retries protected capsule clipboard clearing before safe resumption", async () => {
    const run = await runClipboardCapsule("retry");
    try {
      expect(run.result.result.status).toBe("completed");
      expect(run.gate.state()).toBe("normal");
      await run.page.goto(new URL(run.result.safeSession.page.url()).origin).catch(() => undefined);
      expect(await run.page.evaluate(() => navigator.clipboard.readText())).toBe("");
    } finally {
      await run.context.close();
      await run.result.safeSession.browser.close();
    }
  }, 20_000);

  it("falls back to portable browser state when IndexedDB export is unavailable", async () => {
    const run = await runClipboardCapsule("retry", true);
    try {
      expect(run.result.result.status).toBe("completed");
    } finally {
      await run.context.close();
      await run.result.safeSession.browser.close();
    }
  }, 20_000);

  it("seals and blocks completion when capsule clipboard destruction cannot be verified", async () => {
    const run = await runClipboardCapsule("persistent");
    try {
      expect(run.result.result).toMatchObject({
        status: "aborted",
        reasonCode: "VEIL_CLIPBOARD_CLEANUP_FAILED",
      });
      expect(run.gate.state()).toBe("sealed");
    } finally {
      await run.page.evaluate(() => navigator.clipboard.writeText(""));
      await run.context.close();
      await run.result.safeSession.browser.close();
    }
  }, 20_000);

  it("reconstructs non-transferable form state inside the capsule before one dispatch", async () => {
    let created = false;
    let dispatches = 0;
    const server = createServer((request, response) => {
      if (request.url === "/created" && request.method === "POST") {
        created = true;
        dispatches += 1;
        response.writeHead(204).end();
        return;
      }
      response.setHeader("content-type", "text/html");
      if (request.url === "/safe" || (request.url === "/new" && created))
        return response.end(`<main data-testid="created">${created ? "Created" : "Ready"}</main>`);
      response.end(
        `<label>Name<input></label><label>Description<textarea></textarea></label><button data-testid="issue">Save</button><output aria-label="Client ID" data-testid="client-id"></output><output aria-label="Client secret" data-testid="secret"></output><script>document.querySelector('[data-testid=issue]').onclick=()=>fetch('/created',{method:'POST'}).then(()=>{document.querySelector('[data-testid=client-id]').textContent='public-id';document.querySelector('[data-testid=secret]').textContent='capsule-canary'})</script>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${origin}/new`);
      await page.getByLabel("Name").fill("safe-context-only");
      const provenance = new BrowserSessionProvenance(randomUUID(), "safe");
      const collectorStates: string[] = [];
      const channelCollector = new VeilChannelCollector("evidence");
      const collector: PrivacyCollector = {
        name: "evidence",
        arm: async (id, p) => channelCollector.arm(id, p),
        suspend: async () => channelCollector.suspend(),
        isolate: async () => {
          await channelCollector.isolate();
          collectorStates.push("stopped");
        },
        resume: async (b) => {
          await channelCollector.resume(b);
          collectorStates.push("resumed");
        },
        seal: async (r) => channelCollector.seal(r),
        finalize: async () => channelCollector.finalize(),
        state: () => channelCollector.state(),
      };
      const memory = memoryStore();
      let heartbeatCalls = 0;
      const lifecycleStore: ProtectedTransactionStore = {
        ...memory.store,
        heartbeatIntervalMs: 250,
        heartbeatTimeoutMs: 100,
        heartbeat: async () => {
          heartbeatCalls += 1;
        },
      };
      const secrets: string[] = [];
      const publics: string[] = [];
      let calibrationBoundaryVerified = false;
      const authority = new VeilAuthority(
        compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
      );
      const result = await new ProtectedTransactionKernel({
        safeSession: { browser, context, page, provenance },
        gate: new VeilRuntimeCoordinator([collector]),
        redactor: new SecretRedactor(),
        store: lifecycleStore,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: [origin],
        prepareCapsule: async (session) => {
          registerPraxisVeilAuthority(session.page, {
            authority,
            userId: "test",
            environmentId: "test",
            browserContextId: session.provenance.contextId,
          });
        },
        resolveKnownSecret: async () => "",
        persistSecret: async ({ value }) => {
          secrets.push(value);
          return { credentialId: "11111111-1111-4111-8111-111111111111" };
        },
        persistPublicValue: async ({ value }) => {
          publics.push(value);
          return { valueId: "22222222-2222-4222-8222-222222222222" };
        },
        persistOutputsAtomically: atomicProjectCapture(
          lifecycleStore,
          async (value) => {
            secrets.push(value);
            return { credentialId: "11111111-1111-4111-8111-111111111111" };
          },
          async (value) => {
            publics.push(value);
            return { valueId: "22222222-2222-4222-8222-222222222222" };
          },
        ),
        verifyAssertions: verify,
        onPreparationVerified: async (session) => {
          expect(await session.page.getByLabel("Name").inputValue()).toBe("Capsule app");
          expect(await session.page.getByLabel("Description").inputValue()).toBe(
            "Prepared only in capsule",
          );
          calibrationBoundaryVerified = true;
        },
        reconcile: async (session) => {
          const before = heartbeatCalls;
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(heartbeatCalls).toBeGreaterThan(before);
          await session.page.goto(`${origin}/safe`);
          return (await session.page.getByTestId("created").textContent()) === "Created"
            ? "succeeded"
            : "not_applied";
        },
        onEvidenceResumed: async () => {
          const before = heartbeatCalls;
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(heartbeatCalls).toBeGreaterThan(before);
        },
      }).execute(transaction(origin));
      expect(result.result).toMatchObject({
        status: "completed",
        bootstrap: { status: "succeeded" },
        preparation: { status: "succeeded" },
        mutation: { dispatch: "acknowledged", outcome: "confirmed_succeeded" },
        protectedPersistence: "confirmed",
        publicPersistence: "confirmed",
        capsule: "destroyed",
        continuation: "parked_resumed",
        evidence: "resumed",
      });
      expect(secrets).toEqual(["capsule-canary"]);
      expect(publics).toEqual(["public-id"]);
      expect(dispatches).toBe(1);
      expect(calibrationBoundaryVerified).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem("secret"))).toBeNull();
      expect(collectorStates).toEqual(["stopped", "resumed"]);
      const terminalHeartbeatCount = heartbeatCalls;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(heartbeatCalls).toBe(terminalHeartbeatCount);
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("classifies blank or drifting preparation before mutation and permits safe retry", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent("<main>safe</main>");
      const memory = memoryStore();
      const operation = transaction("https://example.test");
      operation.entry.url = "data:text/html,<main>missing form</main>";
      operation.entry.assertions = [
        { type: "visible", target: intent("Name", "textbox"), timeoutMs: 100 },
      ];
      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store: memory.store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: ["https://example.test"],
        prepareCapsule: async () => undefined,
        resolveKnownSecret: async () => "",
        persistSecret: async () => {
          throw new Error("must not persist");
        },
        persistPublicValue: async () => {
          throw new Error("must not persist");
        },
        verifyAssertions: verify,
      }).execute(operation);
      expect(result.result.mutation).toEqual({ dispatch: "not_started", outcome: "not_attempted" });
      expect(result.result.retryClass).toBe("safe_to_retry");
      expect(memory.state()).toBe("failed_not_applied");
    } finally {
      await browser.close();
    }
  });

  it("settles a dispatched read-only acquisition failure as retry-safe and not applied", async () => {
    let dispatches = 0;
    const server = createServer((request, response) => {
      if (request.url === "/orders") {
        dispatches += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<label>Name<input></label><label>Description<textarea></textarea></label><button aria-label="Save">Save</button><script>document.querySelector('[aria-label=Save]').onclick=()=>fetch('/orders')</script>`,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);
      const memory = memoryStore();
      const recordedFacts: Array<Record<string, unknown> | undefined> = [];
      let terminalTransitionFacts: Record<string, unknown> | undefined;
      const store: ProtectedTransactionStore = {
        ...memory.store,
        transition: async (entry) => {
          if (entry.next === "failed_not_applied") terminalTransitionFacts = entry.facts;
          return memory.store.transition(entry);
        },
        record: async (entry) => {
          recordedFacts.push(entry.facts);
        },
      };
      const operation = transaction(origin);
      operation.entry.url = origin;
      operation.entry.assertions = [{ type: "visible", target: intent("Save", "button") }];
      operation.preparation.actions = [];
      operation.preparation.assertions = [];
      operation.mutation.kind = "repeatable";
      operation.mutation.dispatchSemantics = "read_only";
      operation.mutation.action.expectedEffect = { type: "none" };
      operation.extraction.timeoutMs = 250;
      operation.extraction.outputs = [
        {
          classification: "public",
          reference: "orderId",
          acquisition: {
            target: intent("id", "value"),
            classification: "public",
            permittedMethods: ["protected_network_value"],
            validation: { minimumLength: 1, maximumLength: 200 },
          },
          storage: { name: "Order ID", scope: "project" },
        },
      ];
      operation.acquisitionReadiness.valueIntent = intent("id", "value");
      operation.acquisitionReadiness.approvedMethods = ["protected_network_value"];
      operation.mutation.reconciliation = {
        strategy: "persisted_outputs",
        requiredReferences: ["orderId"],
      };
      const authority = new VeilAuthority(
        compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
      );
      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: [origin],
        prepareCapsule: async (session) => {
          registerPraxisVeilAuthority(session.page, {
            authority,
            userId: "read-only-test",
            environmentId: "test",
            browserContextId: session.provenance.contextId,
          });
        },
        resolveKnownSecret: async () => "",
        persistSecret: async () => {
          throw new Error("must not persist");
        },
        persistPublicValue: async () => {
          throw new Error("must not persist");
        },
        verifyAssertions: verify,
      }).execute(operation);

      expect(result.result).toMatchObject({
        status: "aborted",
        reasonCode: "PROTECTED_RESPONSE_VALUE_UNAVAILABLE",
        mutation: { dispatch: "acknowledged", outcome: "confirmed_not_applied" },
        retryClass: "safe_to_retry",
        safeActions: ["retry_transaction", "abort"],
      });
      expect(memory.state()).toBe("failed_not_applied");
      expect(dispatches).toBe(1);
      expect(recordedFacts.at(-1)).toMatchObject({
        mutation: {
          request: {
            status: "initiated",
            method: "GET",
            transport: "fetch",
            envelopeMatched: true,
          },
        },
      });
      expect(terminalTransitionFacts).toMatchObject({
        mutation: {
          request: {
            status: "initiated",
            method: "GET",
            transport: "fetch",
            envelopeMatched: true,
          },
        },
        responseEvidence: {
          responseEventObserved: true,
          eligibleResponseSelected: true,
          httpStatusCode: 200,
          statusClass: "2xx",
          contentTypeClass: "json",
          bodyAcquisitionStarted: true,
          bodyAcquisitionSettled: true,
          bodyParseStatus: "success",
          topLevelShape: "object",
          declaredSemanticLeafPresent: false,
          declaredSemanticLeafMatchCount: "zero",
          selectedPathClass: "unavailable",
          extractionResultClass: "not_present",
          lateResultDiscarded: false,
        },
      });
    } finally {
      await browser.close();
    }
  }, 15_000);

  it.each([200, 400, 401, 403, 404, 422, 429])(
    "settles documented read-only request status %s through the production kernel",
    async (httpStatusCode) => {
      const expected = {
        clientId: `client-${randomUUID()}`,
        clientSecret: `secret-${randomUUID()}`,
        orderId: randomUUID(),
      };
      let dispatches = 0;
      const observations: Array<Record<string, unknown>> = [];
      const server = createServer((request, response) => {
        if (request.url === "/") {
          response.setHeader("content-type", "text/html");
          response.end(`<link rel="icon" href="data:,"><label>Client ID<input></label><label>Client secret<input></label><label>Order ID<input></label><button aria-label="Save">Save</button><output aria-label="id">response schema</output><script>
          document.querySelector('[aria-label=Save]').onclick=()=>fetch('/api/v1/partner-api/orders/'+encodeURIComponent(document.querySelectorAll('input')[2].value),{method:'GET',headers:{'x-vitract-client-id':document.querySelectorAll('input')[0].value,'x-vitract-client-secret':document.querySelectorAll('input')[1].value}})
        </script>`);
          return;
        }
        if (request.url === "/safe") {
          response.setHeader("content-type", "text/html");
          response.end("<main>continued</main>");
          return;
        }
        if (!request.url?.startsWith("/api/v1/partner-api/orders/")) {
          response.statusCode = 404;
          response.end();
          return;
        }
        dispatches += 1;
        let bodyBytes = 0;
        request.on("data", (chunk) => {
          bodyBytes += chunk.length;
        });
        request.on("end", () => {
          const shape = {
            method: request.method,
            pathMatches: request.url === `/api/v1/partner-api/orders/${expected.orderId}`,
            queryAbsent: !request.url?.includes("?"),
            clientIdHeaderMatches: request.headers["x-vitract-client-id"] === expected.clientId,
            clientSecretHeaderMatches:
              request.headers["x-vitract-client-secret"] === expected.clientSecret,
            bodyAbsent: bodyBytes === 0,
          };
          observations.push(shape);
          const accepted = Object.values(shape).every((value) => value === true || value === "GET");
          response.statusCode = accepted
            ? httpStatusCode
            : shape.method !== "GET"
              ? 405
              : !shape.pathMatches
                ? 404
                : !shape.clientIdHeaderMatches || !shape.clientSecretHeaderMatches
                  ? 401
                  : 422;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify(
              accepted && httpStatusCode === 200
                ? { data: { id: expected.orderId } }
                : { error: "rejected" },
            ),
          );
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server unavailable");
      const origin = `http://127.0.0.1:${address.port}`;
      const browser = await chromium.launch({
        headless: true,
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(origin);
        const memory = memoryStore();
        const operation = transaction(origin);
        operation.entry = {
          url: origin,
          assertions: [{ type: "visible", target: intent("Save", "button") }],
        };
        operation.inputs = {
          clientId: { classification: "known_secret", credentialRef: "client-id-ref" },
          clientSecret: { classification: "known_secret", credentialRef: "client-secret-ref" },
          orderId: { classification: "known_secret", credentialRef: "order-id-ref" },
        };
        operation.preparation.actions = [
          {
            type: "fillKnownSecret",
            input: "clientId",
            target: intent("Client ID", "textbox"),
            effect: "replayable_setup",
          },
          {
            type: "fillKnownSecret",
            input: "clientSecret",
            target: intent("Client secret", "textbox"),
            effect: "replayable_setup",
          },
          {
            type: "fillKnownSecret",
            input: "orderId",
            target: intent("Order ID", "textbox"),
            effect: "replayable_setup",
          },
        ];
        operation.preparation.assertions = [];
        operation.mutation = {
          action: {
            type: "click",
            target: intent("Save", "button"),
            expectedEffect: { type: "none" },
          },
          kind: "repeatable",
          dispatchSemantics: "read_only",
          reconciliation: {
            strategy: "persisted_outputs",
            requiredReferences: ["retrievedOrderId"],
          },
        };
        operation.extraction.outputs = [
          {
            classification: "public",
            reference: "retrievedOrderId",
            acquisition: {
              target: intent("id", "value"),
              classification: "public",
              permittedMethods: ["protected_network_value"],
              validation: { minimumLength: 1, maximumLength: 200 },
            },
            storage: { name: "Retrieved Order ID", scope: "project" },
          },
        ];
        operation.acquisitionReadiness.valueIntent = intent("id", "value");
        operation.acquisitionReadiness.approvedMethods = ["protected_network_value"];
        const authority = new VeilAuthority(
          compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
        );
        const startedAt = Date.now();
        const result = await new ProtectedTransactionKernel({
          safeSession: {
            browser,
            context,
            page,
            provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
          },
          gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
          redactor: new SecretRedactor(),
          store: memory.store,
          capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
          allowedOrigins: [origin],
          prepareCapsule: async (session) => {
            registerPraxisVeilAuthority(session.page, {
              authority,
              userId: "request-contract-test",
              environmentId: "test",
              browserContextId: session.provenance.contextId,
            });
          },
          resolveKnownSecret: async (reference) =>
            reference === "client-id-ref"
              ? expected.clientId
              : reference === "client-secret-ref"
                ? expected.clientSecret
                : expected.orderId,
          persistSecret: async () => {
            throw new Error("must not persist a protected output");
          },
          persistPublicValue: async () => ({ valueId: randomUUID() }),
          persistOutputsAtomically: atomicProjectCapture(
            memory.store,
            async () => {
              throw new Error("must not persist a protected output");
            },
            async () => ({ valueId: randomUUID() }),
          ),
          verifyAssertions: verify,
        }).execute(operation);
        if (httpStatusCode === 200) {
          expect(result.result.status).toBe("completed");
          expect(memory.state()).toBe("completed");
        } else {
          expect(result.result).toMatchObject({
            status: "aborted",
            reasonCode: "PROTECTED_RESPONSE_HTTP_REJECTED",
            mutation: { dispatch: "acknowledged", outcome: "confirmed_not_applied" },
            responseEvidence: {
              httpStatusCode,
              statusClass: "4xx",
              bodyAcquisitionStarted: false,
              bodyAcquisitionSettled: false,
              extractionResultClass: "rejected",
            },
          });
          expect(memory.state()).toBe("failed_not_applied");
          expect(Date.now() - startedAt).toBeLessThan(3_000);
        }
        expect(dispatches).toBe(1);
        expect(observations).toEqual([
          {
            method: "GET",
            pathMatches: true,
            queryAbsent: true,
            clientIdHeaderMatches: true,
            clientSecretHeaderMatches: true,
            bodyAbsent: true,
          },
        ]);
        expect(JSON.stringify(observations)).not.toContain(expected.clientId);
        expect(JSON.stringify(observations)).not.toContain(expected.clientSecret);
        expect(JSON.stringify(observations)).not.toContain(expected.orderId);
      } finally {
        await browser.close();
      }
    },
    15_000,
  );

  it("classifies a read-only activation with no initiated request before the full response timeout", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<button aria-label="Save">Save</button>`);
    });

    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server unavailable");
    }

    const origin = `http://127.0.0.1:${address.port}`;

    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);

      const memory = memoryStore();
      const recordedPhases: string[] = [];

      const store: ProtectedTransactionStore = {
        ...memory.store,
        record: async ({ phase }) => {
          recordedPhases.push(phase);
        },
      };

      const operation = transaction(origin);

      operation.entry.url = origin;
      operation.entry.assertions = [{ type: "visible", target: intent("Save", "button") }];

      operation.preparation.actions = [];
      operation.preparation.assertions = [];

      operation.mutation.kind = "repeatable";
      operation.mutation.dispatchSemantics = "read_only";
      operation.mutation.action.expectedEffect = { type: "none" };

      operation.extraction.timeoutMs = 400;
      operation.extraction.outputs = [
        {
          classification: "public",
          reference: "orderId",
          acquisition: {
            target: intent("id", "value"),
            classification: "public",
            permittedMethods: ["protected_network_value"],
            validation: {
              minimumLength: 1,
              maximumLength: 200,
            },
          },
          storage: {
            name: "Order ID",
            scope: "project",
          },
        },
      ];

      operation.acquisitionReadiness.valueIntent = intent("id", "value");
      operation.acquisitionReadiness.approvedMethods = ["protected_network_value"];

      operation.mutation.reconciliation = {
        strategy: "persisted_outputs",
        requiredReferences: ["orderId"],
      };

      const authority = new VeilAuthority(
        compileVeilPolicy({
          profile: "balanced",
          allowedOrigins: [origin],
        }),
      );

      const started = Date.now();

      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: [origin],
        prepareCapsule: async (session) => {
          registerPraxisVeilAuthority(session.page, {
            authority,
            userId: "request-initiation-test",
            environmentId: "test",
            browserContextId: session.provenance.contextId,
          });
        },
        resolveKnownSecret: async () => "",
        persistSecret: async () => {
          throw new Error("must not persist");
        },
        persistPublicValue: async () => {
          throw new Error("must not persist");
        },
        verifyAssertions: verify,
      }).execute(operation);

      const elapsed = Date.now() - started;

      expect(result.result).toMatchObject({
        status: "aborted",
        reasonCode: "PROTECTED_REQUEST_NOT_INITIATED",
        mutation: {
          dispatch: "started",
          outcome: "confirmed_not_applied",
        },
        retryClass: "safe_to_retry",
        safeActions: ["retry_transaction", "abort"],
      });

      expect(memory.state()).toBe("failed_not_applied");
      expect(recordedPhases).toContain("request_not_initiated");

      // The request-initiation boundary must terminate independently
      // instead of consuming a long response/recovery window.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await browser.close();
    }
  }, 15_000);

  it("keeps zero-output post-dispatch loss in recovery without redispatch", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const memory = memoryStore("dispatching");
      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store: memory.store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: ["https://example.test"],
        prepareCapsule: async () => undefined,
        resolveKnownSecret: async () => "",
        persistSecret: async () => {
          throw new Error("must not persist");
        },
        persistPublicValue: async () => {
          throw new Error("must not persist");
        },
        verifyAssertions: async () => undefined,
      }).execute(transaction("https://example.test"));
      expect(result.result).toMatchObject({
        status: "outcome_unknown",
        reasonCode: "PROTECTED_ACQUISITION_INCOMPLETE",
        mutation: { outcome: "unknown" },
      });
      expect(memory.state()).toBe("recovery_required");
    } finally {
      await browser.close();
    }
  });

  it("marks an incomplete staged protected set compromised without an intermediate lease-releasing transition", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const operation = transaction("https://example.test");
      const memory = memoryStore("recovery_required");
      const compromised = vi.fn();
      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store: memory.store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: ["https://example.test"],
        prepareCapsule: async () => undefined,
        resolveKnownSecret: async () => "",
        persistSecret: async () => {
          throw new Error("must not persist");
        },
        persistPublicValue: async () => {
          throw new Error("must not persist");
        },
        recoverStagedResponseOutputs: async () => [
          {
            reference: "clientSecret",
            classification: "protected",
            name: "Secret",
            value: "staged-protected-value",
            scope: "project",
          },
        ],
        markCredentialCompromised: compromised,
        verifyAssertions: async () => undefined,
      }).execute(operation);
      expect(result.result).toMatchObject({
        status: "outcome_unknown",
        reasonCode: "PROTECTED_ACQUISITION_INTERRUPTED",
        credentialSecurity: "compromised",
      });
      expect(memory.state()).toBe("compromised");
      expect(compromised).not.toHaveBeenCalled();
    } finally {
      await browser.close();
    }
  });

  it("reconciles committed opaque references after process death without redispatch", async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const operation = transaction("https://example.test");
      const memory = memoryStore("recovery_required", {
        clientId: {
          classification: "public",
          valueId: "22222222-2222-4222-8222-222222222222",
          scope: "project",
        },
        clientSecret: {
          classification: "protected",
          credentialId: "11111111-1111-4111-8111-111111111111",
          scope: "project",
        },
      });
      const result = await new ProtectedTransactionKernel({
        safeSession: {
          browser,
          context,
          page,
          provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
        },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store: memory.store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
        allowedOrigins: ["https://example.test"],
        prepareCapsule: async () => undefined,
        resolveKnownSecret: async () => "",
        persistSecret: async () => {
          throw new Error("must not persist");
        },
        persistPublicValue: async () => {
          throw new Error("must not persist");
        },
        verifyAssertions: async () => undefined,
      }).execute(operation);
      expect(result.result).toMatchObject({
        status: "completed",
        mutation: { outcome: "confirmed_succeeded" },
      });
      expect(memory.state()).toBe("completed");
    } finally {
      await browser.close();
    }
  });

  it.each([
    {
      label: "A valid Create response",
      status: 201,
      body: "canonical",
      expectedState: "completed",
      expectedOutcome: "confirmed_succeeded",
      qualificationOnly: false,
      acknowledged: true,
      expectedPostCount: 1,
    },
    {
      label: "D provider-proven validation rejection",
      status: 400,
      body: "error",
      expectedState: "failed_not_applied",
      expectedOutcome: "confirmed_not_applied",
      qualificationOnly: false,
      acknowledged: true,
      expectedPostCount: 1,
    },
    {
      label: "E success without canonical identity",
      status: 201,
      body: "missing",
      expectedState: "recovery_required",
      expectedOutcome: "unknown",
      qualificationOnly: false,
      acknowledged: true,
      expectedPostCount: 1,
    },
    {
      label: "H final activation without acknowledgement",
      status: 201,
      body: "canonical",
      expectedState: "recovery_required",
      expectedOutcome: "unknown",
      qualificationOnly: false,
      acknowledged: false,
      expectedPostCount: 0,
    },
    {
      label: "Q qualification policy withholds dispatch",
      status: 201,
      body: "canonical",
      expectedState: "failed_not_applied",
      expectedOutcome: "confirmed_not_applied",
      qualificationOnly: true,
      acknowledged: true,
      expectedPostCount: 0,
    },
  ] as const)(
    "certifies Create Order $label through the real protected kernel",
    async ({
      status,
      body,
      expectedState,
      expectedOutcome,
      qualificationOnly,
      acknowledged,
      expectedPostCount,
    }) => {
      const protectedValues = {
        clientId: `client-${randomUUID()}`,
        clientSecret: `secret-${randomUUID()}`,
        idempotencyKey: `create-${randomUUID()}`,
        payload: JSON.stringify({
          orderType: "monthly-billing",
          orderedFor: "client",
          quantity: 1,
          kitType: "gut-scan",
          currency: "usd",
          deliveryMode: "dropship",
          clientId: randomUUID(),
          shipping: {
            country: "US",
            addressLineOne: "100 Local Street",
            city: "Boston",
            state: "MA",
            postalCode: "02108",
          },
        }),
        orderId: randomUUID(),
      };
      let dispatches = 0;
      const safeObservations: Array<Record<string, unknown>> = [];
      const server = createServer((request, response) => {
        if (request.url === "/" || request.url === "/new") {
          response.setHeader("content-type", "text/html");
          response.end(`<link rel="icon" href="data:,"><label>Client ID<input></label><label>Client secret<input></label><label>Idempotency key<input></label><label>JSON body<textarea></textarea></label><label><input type="checkbox">I understand this sends a real request that may create or change Partner data.</label><button aria-label="Save">Save</button><output aria-label="id">response schema</output><script>
          document.querySelector('[aria-label=Save]').onclick=()=>{if(!document.querySelector('input[type=checkbox]').checked)return;fetch('/api/v1/partner-api/orders',{method:'POST',headers:{'x-vitract-client-id':document.querySelectorAll('input')[0].value,'x-vitract-client-secret':document.querySelectorAll('input')[1].value,'Idempotency-Key':document.querySelectorAll('input')[2].value,'content-type':'application/json'},body:document.querySelector('textarea').value})}
        </script>`);
          return;
        }
        if (request.url === "/safe") {
          response.setHeader("content-type", "text/html");
          response.end("<main>continued</main>");
          return;
        }
        if (request.url !== "/api/v1/partner-api/orders") {
          response.statusCode = 404;
          response.end();
          return;
        }
        dispatches += 1;
        let payload = "";
        request.on("data", (chunk) => {
          payload += chunk.toString();
        });
        request.on("end", () => {
          const observation = {
            method: request.method,
            pathExact: request.url === "/api/v1/partner-api/orders",
            clientIdPresent: request.headers["x-vitract-client-id"] === protectedValues.clientId,
            clientSecretPresent:
              request.headers["x-vitract-client-secret"] === protectedValues.clientSecret,
            idempotencyKeyPresent:
              request.headers["idempotency-key"] === protectedValues.idempotencyKey,
            payloadExact: payload === protectedValues.payload,
          };
          safeObservations.push(observation);
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify(
              body === "canonical"
                ? { data: { id: protectedValues.orderId, referenceId: "local-reference" } }
                : body === "missing"
                  ? { data: { status: "created" } }
                  : { error: { code: "VALIDATION_ERROR" } },
            ),
          );
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server unavailable");
      const origin = `http://127.0.0.1:${address.port}`;
      const browser = await chromium.launch({
        headless: true,
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(origin);
        const memory = memoryStore();
        const operation = transaction(origin);
        operation.operationId = `create-order-${randomUUID()}`;
        operation.entry = {
          url: origin,
          assertions: [{ type: "visible", target: intent("Save", "button") }],
        };
        operation.inputs = Object.fromEntries(
          Object.keys(protectedValues)
            .filter((key) => key !== "orderId")
            .map((key) => [key, { classification: "known_secret", credentialRef: `${key}-ref` }]),
        ) as ProtectedTransaction["inputs"];
        if (acknowledged)
          operation.inputs.mutationAcknowledged = { classification: "public", value: true };
        operation.preparation.actions = [
          {
            type: "fillKnownSecret",
            input: "clientId",
            target: intent("Client ID", "textbox"),
            effect: "replayable_setup",
          },
          {
            type: "fillKnownSecret",
            input: "clientSecret",
            target: intent("Client secret", "textbox"),
            effect: "replayable_setup",
          },
          {
            type: "fillKnownSecret",
            input: "idempotencyKey",
            target: intent("Idempotency key", "textbox"),
            effect: "replayable_setup",
          },
          {
            type: "fillKnownSecret",
            input: "payload",
            target: intent("JSON body", "textbox"),
            effect: "replayable_setup",
          },
          ...(acknowledged
            ? [
                {
                  type: "checkPublicInput" as const,
                  input: "mutationAcknowledged",
                  target: intent(
                    "I understand this sends a real request that may create or change Partner data.",
                    "checkbox",
                  ),
                  effect: "replayable_setup" as const,
                },
              ]
            : []),
        ];
        operation.preparation.assertions = acknowledged
          ? [
              {
                type: "checkedMatchesInput",
                target: intent(
                  "I understand this sends a real request that may create or change Partner data.",
                  "checkbox",
                ),
                input: "mutationAcknowledged",
              },
            ]
          : [];
        operation.mutation = {
          action: {
            type: "click",
            target: intent("Save", "button"),
            expectedEffect: { type: "none" },
          },
          kind: "one_time",
          request: {
            method: "POST",
            pathTemplate: "/api/v1/partner-api/orders",
            transports: ["fetch"],
          },
          response: { confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429] },
          reconciliation: { strategy: "persisted_outputs", requiredReferences: ["createdOrderId"] },
        };
        operation.extraction.outputs = [
          {
            classification: "public",
            reference: "createdOrderId",
            acquisition: {
              target: intent("id", "value"),
              classification: "public",
              permittedMethods: ["protected_network_value"],
              validation: { minimumLength: 1, maximumLength: 200 },
            },
            storage: { name: "Created Order ID", scope: "project" },
          },
        ];
        operation.extraction.timeoutMs = 700;
        operation.acquisitionReadiness.valueIntent = intent("id", "value");
        operation.acquisitionReadiness.approvedMethods = ["protected_network_value"];
        const authority = new VeilAuthority(
          compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
        );
        const result = await new ProtectedTransactionKernel({
          safeSession: {
            browser,
            context,
            page,
            provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
          },
          gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
          redactor: new SecretRedactor(),
          store: memory.store,
          capsuleFactory: new PlaywrightProtectedCapsuleFactory(openTestBrowser),
          allowedOrigins: [origin],
          prepareCapsule: async (session) => {
            registerPraxisVeilAuthority(session.page, {
              authority,
              userId: "create-order-local",
              environmentId: "test",
              browserContextId: session.provenance.contextId,
            });
          },
          resolveKnownSecret: async (reference) =>
            protectedValues[reference.replace(/-ref$/, "") as keyof typeof protectedValues],
          persistSecret: async () => {
            throw new Error("must not persist protected output");
          },
          persistPublicValue: async () => ({ valueId: randomUUID() }),
          persistOutputsAtomically: atomicProjectCapture(
            memory.store,
            async () => {
              throw new Error("must not persist protected output");
            },
            async () => ({ valueId: randomUUID() }),
          ),
          verifyAssertions: verify,
          ...(qualificationOnly ? { dispatchDisposition: "qualification_only" as const } : {}),
        }).execute(operation);
        expect(memory.state()).toBe(expectedState);
        expect(result.result.mutation.outcome).toBe(expectedOutcome);
        expect(dispatches).toBe(expectedPostCount);
        expect(safeObservations).toEqual(
          expectedPostCount === 0
            ? []
            : [
                {
                  method: "POST",
                  pathExact: true,
                  clientIdPresent: true,
                  clientSecretPresent: true,
                  idempotencyKeyPresent: true,
                  payloadExact: true,
                },
              ],
        );
        const safeSerialized = JSON.stringify({
          result: result.result,
          observations: safeObservations,
        });
        for (const value of Object.values(protectedValues))
          expect(safeSerialized).not.toContain(value);
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});
