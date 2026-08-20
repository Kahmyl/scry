import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { Assertion, InteractionTargetIntent, ProtectedTransaction } from "@scry/contracts";
import { currentPlanSchema } from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { resolveTargetLocator } from "@scry/praxis";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { compileVeilPolicy, VeilAuthority, VeilChannelCollector, VeilRuntimeCoordinator } from "@scry/veil";

import { BrowserSessionProvenance } from "../../src/browser-session.js";
import {
  PlaywrightProtectedCapsuleFactory,
  ProtectedTransactionKernel,
  type MutationLedgerState,
  type ProtectedOperationClaim,
  type ProtectedTransactionStore,
} from "../../src/protected-transaction-coordinator.js";

type Shape = "page" | "dialog" | "drawer" | "delayed";

let server: ReturnType<typeof createServer>;
let origin: string;
let browser: Browser;
const dispatches = new Map<Shape, number>();
const syntheticSecret = "synthetic-protected-campaign-canary";

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (request.method === "POST" && url.pathname.startsWith("/dispatch/")) {
      const shape = url.pathname.split("/").at(-1) as Shape;
      dispatches.set(shape, (dispatches.get(shape) ?? 0) + 1);
      response.writeHead(204).end();
      return;
    }
    response.setHeader("content-type", "text/html");
    if (url.pathname === "/safe") return response.end("<!doctype html><main>Safe continuation</main>");
    const shape = (url.pathname.split("/").at(-1) ?? "page") as Shape;
    response.end(documentFor(shape));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("campaign lab server unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("disposable protected-transaction architecture campaigns", () => {
  it.each(["page", "dialog", "drawer", "delayed"] as const)(
    "completes the %s campaign with one dispatch and atomic opaque outputs",
    async (shape) => {
      const started = performance.now();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${origin}/scenario/${shape}`);
      const memory = memoryStore();
      const persisted: Array<{ classification: "public" | "protected"; value: string }> = [];
      const authority = new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }));
      const operation = transaction(shape);
      expect(() => currentPlanSchema.parse(planFor(operation))).not.toThrow();
      const result = await new ProtectedTransactionKernel({
        safeSession: { browser, context, page, provenance: new BrowserSessionProvenance(randomUUID(), "safe") },
        gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
        redactor: new SecretRedactor(),
        store: memory.store,
        capsuleFactory: new PlaywrightProtectedCapsuleFactory(async () => {
          const capsuleBrowser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
          const capsuleContext = await capsuleBrowser.newContext();
          return { browser: capsuleBrowser, context: capsuleContext, page: await capsuleContext.newPage() };
        }),
        allowedOrigins: [origin],
        prepareCapsule: async (session) => {
          registerPraxisVeilAuthority(session.page, { authority, userId: "lab", environmentId: "lab", browserContextId: session.provenance.contextId });
        },
        resolveKnownSecret: async () => "",
        persistSecret: async () => { throw new Error("non-atomic secret persistence forbidden"); },
        persistPublicValue: async () => { throw new Error("non-atomic public persistence forbidden"); },
        persistOutputsAtomically: async (input) => {
          expect(input.outputs).toHaveLength(3);
          persisted.push(...input.outputs.map((output) => ({ classification: output.classification, value: output.value })));
          const references = Object.fromEntries(input.outputs.map((output, index) => [
            output.reference,
            output.classification === "protected"
              ? { classification: "protected" as const, credentialId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, scope: "project" as const }
              : { classification: "public" as const, valueId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`, scope: "project" as const },
          ]));
          const claim = await memory.store.transition({
            id: input.claim.id, operationId: input.operationId, version: input.claim.version,
            fencingToken: input.claim.fencingToken, expected: "persisting", next: "persisted", phase: "persistence_committed",
          });
          return { claim, references };
        },
        verifyAssertions,
      }).execute(operation);
      try {
        expect(result.result).toMatchObject({
          status: "completed",
          preparation: { status: "succeeded" },
          mutation: { dispatch: "acknowledged", outcome: "confirmed_succeeded" },
          protectedPersistence: "confirmed",
          publicPersistence: "confirmed",
          capsule: "destroyed",
        });
        expect(dispatches.get(shape)).toBe(1);
        expect(persisted).toHaveLength(3);
        expect(persisted.filter((output) => output.classification === "protected")).toHaveLength(1);
        expect(JSON.stringify(result.result)).not.toContain(syntheticSecret);
        expect(JSON.stringify(result.result)).not.toMatch(/selector|xpath|runtimeId|fingerprint|browserHandle|outerHTML|innerHTML/i);
        expect(performance.now() - started).toBeLessThan(8_000);
      } finally {
        await context.close();
        if (result.safeSession.browser !== browser) await result.safeSession.browser.close();
      }
    },
    15_000,
  );

  it("refuses duplicate protected mutation links before dispatch", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<a href="#same" aria-label="Generate">Generate</a><a href="#same" aria-label="Generate">Generate</a>`);
    const candidates = page.getByRole("link", { name: "Generate", exact: true });
    const eligible = await eligibleCount(candidates);
    let prototypeDispatches = 0;
    if (eligible === 1) prototypeDispatches += 1;
    expect(eligible).toBe(2);
    expect(prototypeDispatches).toBe(0);
    await context.close();
  });
});

function transaction(shape: Shape): ProtectedTransaction {
  const scope = shape === "dialog"
    ? { kind: "dialog" as const, name: "Credential ceremony" }
    : shape === "drawer"
      ? { kind: "region" as const, name: "Credential drawer" }
      : { kind: "page" as const };
  const name = target("Credential name", "textbox", ["focusable", "accepts_text", "editable", "readable_value"], scope);
  const environment = target("Environment", "combobox", ["focusable", "selects_option", "readable_value"], scope);
  const generate = target("Generate", "button", ["focusable", "pointer_activatable"], scope, "protected");
  return {
    type: "protectedTransaction", operationId: `campaign-${shape}`,
    entry: { url: `${origin}/scenario/${shape}`, assertions: [{ type: "visible", target: name, timeoutMs: 2_000 }] },
    inputs: {
      credentialName: { classification: "public", value: `Campaign ${shape}` },
      environment: { classification: "public", value: "test" },
    },
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [
        { type: "fillPublicInput", input: "credentialName", target: name, effect: "replayable_setup", timeoutMs: 2_000 },
        { type: "selectPublicInput", input: "environment", target: environment, effect: "replayable_setup", timeoutMs: 2_000 },
      ],
      assertions: [
        { type: "fieldValueMatchesInput", target: name, input: "credentialName", timeoutMs: 2_000 },
        { type: "fieldValueMatchesInput", target: environment, input: "environment", timeoutMs: 2_000 },
        { type: "enabled", target: generate, timeoutMs: 2_000 },
      ],
    },
    mutation: {
      action: { type: "click", target: generate, expectedEffect: { type: "none" }, timeoutMs: 2_000 },
      kind: "one_time",
      reconciliation: { strategy: "persisted_outputs", requiredReferences: ["account", "clientId", "clientSecret"] },
    },
    extraction: {
      outputs: [
        output("account", "public", "Account", scope),
        output("clientId", "public", "Client ID", scope),
        output("clientSecret", "protected", "Client secret", scope),
      ],
      timeoutMs: 3_000, scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: {
      ceremonyIntent: generate,
      expectedContainerModel: { version: 2, digest: "a".repeat(64), concept: "Credential ceremony", scopeKind: scope.kind, capabilityDigest: "b".repeat(64), structuralPath: [] },
      valueIntent: target("Client secret", "textbox", ["readable_value"], scope, "protected"),
      approvedMethods: ["input_value"], minimumConfidence: 0.5, minimumConfidenceMargin: 0,
      recoveryPolicy: "abandon", recoveryWindowMs: 1_000,
    },
    continuation: { strategies: [{ mode: "resume_parked_context", reentryUrl: `${origin}/safe`, assertions: [{ type: "url", expected: "/safe", match: "path", timeoutMs: 2_000 }], continueAtStepId: `continue-${shape}` }] },
  };
}

function output(reference: string, classification: "public" | "protected", name: string, scope: InteractionTargetIntent["scope"]): ProtectedTransaction["extraction"]["outputs"][number] {
  const acquisition = {
    target: target(name, "textbox", ["readable_value"], scope, classification === "protected" ? "protected" : "read_only"),
    classification: classification === "protected" ? "unknown_secret" as const : "public" as const,
    permittedMethods: ["input_value" as const],
    objective: { kind: "capture_value" as const, expectedValueType: classification === "protected" ? "unknown_secret" as const : "public" as const },
    validation: { minimumLength: 1, maximumLength: 200 },
  };
  return classification === "protected"
    ? { classification, reference, acquisition, storage: { credentialName: name, scope: "project" } }
    : { classification, reference, acquisition, storage: { name, scope: "project" } };
}

function target(name: string, role: "button" | "textbox" | "combobox", capabilities: InteractionTargetIntent["requiredCapabilities"], scope: InteractionTargetIntent["scope"], risk: InteractionTargetIntent["risk"] = "ordinary"): InteractionTargetIntent {
  return {
    concept: name.toLowerCase().replace(/\W+/g, "_"), requiredCapabilities: capabilities,
    preferredEvidence: { roles: [role], names: [name], labels: [name], descriptions: [], placeholders: [], inputTypes: [] },
    scope, relations: [], prohibited: ["hidden", "disabled"], risk, confidence: { requiredFamilies: [] }, matching: "exact",
  };
}

function planFor(operation: ProtectedTransaction) {
  const continuation = operation.continuation.strategies[0]!;
  if (continuation.mode !== "resume_parked_context") {
    throw new Error("Campaign lab requires a parked-context continuation");
  }
  return {
    name: "Campaign lab", objective: "Qualify the protected capability architecture", preconditions: [], allowedOrigins: [origin],
    budgets: { maxActions: 2, maxDurationMs: 10_000, maxNavigations: 2 }, checkpoints: [],
    steps: [
      { id: "protected", title: "Protected transaction", action: operation, assertions: [], onFailure: "stop" as const, evidence: [], captureIntent: "transient" as const, transientJustification: "Disposable full-transaction qualification." },
      { id: continuation.continueAtStepId, title: "Continue", action: { type: "navigate" as const, url: continuation.reentryUrl, timeoutMs: 2_000 }, assertions: [], onFailure: "stop" as const, evidence: [], captureIntent: "transient" as const, transientJustification: "Disposable continuation qualification." },
    ],
  };
}

function memoryStore() {
  let state: MutationLedgerState = "planned";
  let version = 1;
  let mutationOutcome: NonNullable<ProtectedOperationClaim["mutationOutcome"]> = "not_attempted";
  const claim = (): ProtectedOperationClaim => ({ id: "protected-operation", state, version, fencingToken: 1, mutationOutcome });
  const store: ProtectedTransactionStore = {
    claim: async () => claim(),
    transition: async (input) => {
      if (state !== input.expected) throw new Error("PROTECTED_OPERATION_TRANSITION_FENCED");
      state = input.next; version += 1; return claim();
    },
    settleMutationOutcome: async ({ outcome }) => {
      if ((mutationOutcome === "applied" || mutationOutcome === "not_applied") && mutationOutcome !== outcome)
        throw new Error("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_FENCED");
      mutationOutcome = outcome; version += 1; return claim();
    },
    record: async () => undefined,
  };
  return { store, state: () => state };
}

async function verifyAssertions(page: Page, assertions: Assertion[]) {
  for (const assertion of assertions) {
    if (assertion.type === "url") expect(new URL(page.url()).pathname).toBe(assertion.expected);
    else if (assertion.type === "visible") expect(await (await resolveTargetLocator(page, assertion.target)).isVisible()).toBe(true);
    else if (assertion.type === "enabled") expect(await (await resolveTargetLocator(page, assertion.target)).isEnabled()).toBe(true);
    else if (assertion.type === "value") expect(await (await resolveTargetLocator(page, assertion.target)).inputValue()).toBe(assertion.expected);
    else if (assertion.type === "text") expect(await (await resolveTargetLocator(page, assertion.target)).textContent()).toBe(assertion.expected);
  }
}

async function eligibleCount(locator: import("playwright").Locator) {
  let count = 0;
  for (let index = 0; index < await locator.count(); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible() && await candidate.isEnabled()) count += 1;
  }
  return count;
}

function documentFor(shape: Shape) {
  const form = `<label>Credential name<input aria-label="Credential name"></label><label>Environment<select aria-label="Environment"><option value="test">Test</option><option value="live">Live</option></select></label><button aria-label="Generate">Generate</button><label>Account<input readonly aria-label="Account"></label><label>Client ID<input readonly aria-label="Client ID"></label><label>Client secret<input readonly aria-label="Client secret"></label>`;
  const wrapped = shape === "dialog"
    ? `<dialog open aria-label="Credential ceremony">${form}</dialog>`
    : shape === "drawer"
      ? `<aside role="region" aria-label="Credential drawer">${form}</aside>`
      : form;
  const delay = shape === "delayed" ? 250 : 0;
  return `<!doctype html>${wrapped}<script>document.querySelector('[aria-label=Generate]').onclick=async()=>{await fetch('/dispatch/${shape}',{method:'POST'});setTimeout(()=>{document.querySelector('[aria-label=Account]').value='account-${shape}';document.querySelector('[aria-label="Client ID"]').value='client-${shape}';document.querySelector('[aria-label="Client secret"]').value=${JSON.stringify(syntheticSecret)}},${delay})}</script>`;
}
