import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { Assertion, InteractionTargetIntent, ProtectedTransaction } from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { BrowserSessionProvenance } from "../src/browser-session.js";
import { resolveTargetLocator } from "../src/grounding.js";
import { PrivacyGate, type PrivacyCollector } from "../src/privacy-gate.js";
import { PlaywrightProtectedCapsuleFactory, ProtectedTransactionKernel, type MutationLedgerState } from "../src/protected-transaction-coordinator.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const intent=(concept:string,role:"button"|"textbox"|"text"|"value"="text"):InteractionTargetIntent=>({concept,requiredCapabilities:role==="textbox"?["focusable","accepts_text","editable","readable_value"]:role==="button"?["pointer_activatable"]:["readable_value"],preferredEvidence:{roles:[role],names:[concept],labels:role==="textbox"?[concept]:[],descriptions:[],placeholders:role==="textbox"?[concept]:[],inputTypes:[]},scope:{kind:"page"},relations:[],prohibited:["hidden","disabled"],risk:"ordinary",confidence:{requiredFamilies:[],minimum:.45,minimumMargin:0,minimumFamilyCount:1}});
const acquisition=(concept:string,classification:"public"|"unknown_secret")=>({target:intent(concept,"value"),classification,permittedMethods:["semantic_field_value" as const],validation:{minimumLength:1,maximumLength:100}});
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

const transaction = (origin: string): ProtectedTransaction => ({
  type: "protectedTransaction", operationId: "issue-secret",
  entry: { url: `${origin}/new`, assertions: [{ type: "visible", target: intent("Name","textbox") }] },
  inputs: { applicationName: { classification: "public", value: "Capsule app" }, description: { classification: "public", value: "Prepared only in capsule" } },
  preparation: { effectPolicy: { ignoredRequests: [] }, actions: [
    { type: "fillPublicInput", input: "applicationName", target: intent("Name","textbox"), effect: "replayable_setup" },
    { type: "fillPublicInput", input: "description", target: intent("Description","textbox"), effect: "replayable_setup" },
  ], assertions: [
    { type: "fieldValueMatchesInput", target: intent("Name","textbox"), input: "applicationName" },
    { type: "fieldValueMatchesInput", target: intent("Description","textbox"), input: "description" },
    { type: "enabled", target: intent("Save","button") },
  ] },
  mutation: { action: { type: "click", target: intent("Save","button"), expectedEffect:{type:"new_region",target:intent("Client secret","value")} }, kind: "one_time", reconciliation: { strategy: "public_ui_state", assertions: [{ type: "text", target: intent("Created","text"), expected: "Created", exact: true }] } },
  extraction: { outputs: [
    { classification: "public", reference: "clientId", acquisition:acquisition("Client ID","public"), storage: { name: "Client ID", scope: "project" } },
    { classification: "protected", reference: "clientSecret", acquisition:acquisition("Client secret","unknown_secret"), storage: { credentialName: "Secret", scope: "project" } },
  ], timeoutMs: 2_000, scheduling: "fair_shared_timeout" },
  acquisitionReadiness:{ceremonyIntent:intent("Save","button"),expectedContainerModel:{version:2,digest:"a".repeat(64),concept:"Credential form",scopeKind:"page",capabilityDigest:"b".repeat(64),structuralPath:[]},valueIntent:intent("Client secret","value"),approvedMethods:["semantic_field_value"],minimumConfidence:.45,minimumConfidenceMargin:0,recoveryPolicy:"abandon",recoveryWindowMs:1_000},
  continuation: { strategies: [{ mode: "resume_parked_context", reentryUrl: `${origin}/safe`, assertions: [{ type: "url", expected: "/safe", match: "path" }], continueAtStepId: "continue" }] },
});

function memoryStore(initial: MutationLedgerState = "planned") { let state = initial; return { state: () => state, store: { claim: async () => ({ state, fencingToken: 1 }), transition: async ({ expected, next }: { expected: MutationLedgerState; next: MutationLedgerState }) => { if (state !== expected) return false; state = next; return true; }, record: async () => undefined } }; }
async function verify(page: Page, assertions: Assertion[]) { for (const assertion of assertions) { if (assertion.type === "url") expect(new URL(page.url()).pathname).toBe(assertion.expected); else if (assertion.type === "visible") expect(await (await resolveTargetLocator(page, assertion.target)).isVisible()).toBe(true); else if (assertion.type === "value") expect(await (await resolveTargetLocator(page, assertion.target)).inputValue()).toBe(assertion.expected); else if (assertion.type === "text") expect(await (await resolveTargetLocator(page, assertion.target)).textContent()).toBe(assertion.expected); } }

describe("protected transaction capsule", () => {
  it("reconstructs non-transferable form state inside the capsule before one dispatch", async () => {
    let created = false; let dispatches = 0;
    const server = createServer((request, response) => { if (request.url === "/created" && request.method === "POST") { created = true; dispatches += 1; response.writeHead(204).end(); return; } response.setHeader("content-type", "text/html"); if (request.url === "/safe" || (request.url === "/new" && created)) return response.end(`<main data-testid="created">${created ? "Created" : "Ready"}</main>`); response.end(`<label>Name<input></label><label>Description<textarea></textarea></label><button data-testid="issue">Save</button><output aria-label="Client ID" data-testid="client-id"></output><output aria-label="Client secret" data-testid="secret"></output><script>document.querySelector('[data-testid=issue]').onclick=()=>fetch('/created',{method:'POST'}).then(()=>{document.querySelector('[data-testid=client-id]').textContent='public-id';document.querySelector('[data-testid=secret]').textContent='capsule-canary'})</script>`); });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("server unavailable"); const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
    try {
      const context = await browser.newContext(); const page = await context.newPage(); await page.goto(`${origin}/new`); await page.getByLabel("Name").fill("safe-context-only");
      const provenance = new BrowserSessionProvenance(randomUUID(), "safe"); const collectorStates: string[] = []; const collector: PrivacyCollector = { name: "evidence", arm: async () => { collectorStates.push("stopped"); }, resume: async () => { collectorStates.push("resumed"); }, seal: async () => undefined, finalize: async () => undefined };
      const memory = memoryStore(); const secrets: string[] = []; const publics: string[] = []; let calibrationBoundaryVerified = false;
      const result = await new ProtectedTransactionKernel({ safeSession: { browser, context, page, provenance }, gate: new PrivacyGate([collector]), redactor: new SecretRedactor(), store: memory.store, capsuleFactory: new PlaywrightProtectedCapsuleFactory(), allowedOrigins: [origin], prepareCapsule: async () => undefined, resolveKnownSecret: async () => "", persistSecret: async ({ value }) => { secrets.push(value); return { credentialId: "11111111-1111-4111-8111-111111111111" }; }, persistPublicValue: async ({ value }) => { publics.push(value); return { valueId: "22222222-2222-4222-8222-222222222222" }; }, verifyAssertions: verify, verifyCalibration: async (session) => { expect(await session.page.getByLabel("Name").inputValue()).toBe("Capsule app"); expect(await session.page.getByLabel("Description").inputValue()).toBe("Prepared only in capsule"); calibrationBoundaryVerified = true; }, reconcile: async (session) => { await session.page.goto(`${origin}/safe`); return (await session.page.getByTestId("created").textContent()) === "Created" ? "succeeded" : "not_applied"; } }).execute(transaction(origin));
      expect(result.result).toMatchObject({ status: "completed", bootstrap: { status: "succeeded" }, preparation: { status: "succeeded" }, mutation: { dispatch: "acknowledged", outcome: "confirmed_succeeded" }, protectedPersistence: "confirmed", publicPersistence: "confirmed", capsule: "destroyed", continuation: "parked_resumed", evidence: "resumed" });
      expect(secrets).toEqual(["capsule-canary"]); expect(publics).toEqual(["public-id"]); expect(dispatches).toBe(1); expect(calibrationBoundaryVerified).toBe(true); expect(await page.evaluate(() => localStorage.getItem("secret"))).toBeNull(); expect(collectorStates).toEqual(["stopped", "resumed"]);
    } finally { await browser.close(); }
  },15_000);

  it("classifies blank or drifting preparation before mutation and permits safe retry", async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" });
    try { const context = await browser.newContext(); const page = await context.newPage(); await page.setContent("<main>safe</main>"); const memory = memoryStore(); const operation = transaction("https://example.test"); operation.entry.url = "data:text/html,<main>missing form</main>"; operation.entry.assertions = [{ type: "visible", target: intent("Name","textbox"), timeoutMs: 100 }]; const result = await new ProtectedTransactionKernel({ safeSession: { browser, context, page, provenance: new BrowserSessionProvenance(randomUUID(), "safe") }, gate: new PrivacyGate([{ name: "evidence", arm: async () => undefined, resume: async () => undefined, seal: async () => undefined, finalize: async () => undefined }]), redactor: new SecretRedactor(), store: memory.store, capsuleFactory: new PlaywrightProtectedCapsuleFactory(), allowedOrigins: ["https://example.test"], prepareCapsule: async () => undefined, resolveKnownSecret: async () => "", persistSecret: async () => { throw new Error("must not persist"); }, persistPublicValue: async () => { throw new Error("must not persist"); }, verifyAssertions: verify }).execute(operation); expect(result.result.mutation).toEqual({ dispatch: "not_started", outcome: "not_attempted" }); expect(result.result.retryClass).toBe("safe_to_retry"); expect(memory.state()).toBe("planned"); } finally { await browser.close(); }
  });

  it("never replays after dispatch authorization began", async () => {
    const browser = await chromium.launch({ headless: true, channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome" }); try { const context = await browser.newContext(); const page = await context.newPage(); const result = await new ProtectedTransactionKernel({ safeSession: { browser, context, page, provenance: new BrowserSessionProvenance(randomUUID(), "safe") }, gate: new PrivacyGate([{ name: "evidence", arm: async () => undefined, resume: async () => undefined, seal: async () => undefined, finalize: async () => undefined }]), redactor: new SecretRedactor(), store: memoryStore("dispatching").store, capsuleFactory: new PlaywrightProtectedCapsuleFactory(), allowedOrigins: ["https://example.test"], prepareCapsule: async () => undefined, resolveKnownSecret: async () => "", persistSecret: async () => { throw new Error("must not persist"); }, persistPublicValue: async () => { throw new Error("must not persist"); }, verifyAssertions: async () => undefined }).execute(transaction("https://example.test")); expect(result.result.status).toBe("outcome_unknown"); } finally { await browser.close(); }
  });
});
