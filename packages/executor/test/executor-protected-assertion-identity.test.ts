import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  currentPlanSchema,
  executionPolicySchema,
  type InteractionTargetIntent,
  type PraxisResult,
  type ProtectedTransaction,
} from "@scry/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { executePlan } from "../src/executor.js";
import type { MutationLedgerState } from "../src/protected-transaction-coordinator.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("executor protected assertion persistence identity", () => {
  it("assigns distinct ordinals and transaction ids across protected assertion phases", async () => {
    const protectedValue = `protected-${randomUUID()}`;
    const publicValue = `public-${randomUUID()}`;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/safe") {
        response.end("<main role=region aria-label='Safe continuation'>Safe continuation</main>");
        return;
      }
      response.end(`<label>Name<input></label><button>Generate</button><output aria-label="Public identifier"></output><output aria-label="Protected generated value" data-scry-redacted="true"></output><section role="region" aria-label="Created" hidden>Created</section><script>document.querySelector('button').onclick=()=>{document.querySelector('[aria-label="Public identifier"]').textContent=${JSON.stringify(publicValue)};document.querySelector('[aria-label="Protected generated value"]').textContent=${JSON.stringify(protectedValue)};document.querySelector('[aria-label="Created"]').hidden=false}</script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const transaction = protectedTransaction(origin);
    const results: PraxisResult[] = [];
    let ledger: MutationLedgerState = "planned";

    const report = await executePlan({
      plan: currentPlanSchema.parse({
        name: "Protected assertion identities",
        objective: "Persist each protected assertion exactly once",
        allowedOrigins: [origin],
        budgets: { maxActions: 3, maxDurationMs: 30_000, maxNavigations: 3 },
        checkpoints: [],
        steps: [
          { id: "open-safe", title: "Open safe context", action: { type: "navigate", url: `${origin}/safe` }, assertions: [], evidence: [], onFailure: "stop", captureIntent: "final" },
          { id: "protected", title: "Generate protected value", action: transaction, assertions: [], evidence: [], onFailure: "stop", captureIntent: "final" },
          { id: "complete", title: "Continue safely", action: { type: "navigate", url: `${origin}/safe` }, assertions: [], evidence: [], onFailure: "stop", captureIntent: "final" },
        ],
      }),
      policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
      outputDirectory: await mkdtemp(path.join(tmpdir(), "scry-protected-assertion-id-")),
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      veilAdmissionKey: "protected-assertion-test-admission-key-32-bytes",
      protectedTransactionStore: {
        claim: async () => ({ state: ledger, fencingToken: 1 }),
        transition: async ({ expected, next }) => { if (ledger !== expected) return false; ledger = next; return true; },
        record: async () => undefined,
      },
      atomicSecretCapture: async ({ value }) => { expect(value).toBe(protectedValue); return { credentialId: randomUUID() }; },
      publicValueCapture: async ({ value }) => { expect(value).toBe(publicValue); return { valueId: randomUUID() }; },
      onPraxisResult: (result) => { results.push(result); },
    });

    expect(report.state, JSON.stringify({ error: report.error, steps: report.steps.map(({ id, status, action }) => ({ id, status, action })) })).toBe("passed");
    const assertionResults = results.filter((result) => result.operationId.startsWith("assertion-"));
    expect(assertionResults).toHaveLength(4);
    expect(assertionResults.map((result) => result.operationId)).toEqual([
      "assertion-0-inspect",
      "assertion-1-inspect",
      "assertion-2-inspect",
      "assertion-3-inspect",
    ]);
    expect(new Set(assertionResults.map((result) => result.transactionId)).size).toBe(assertionResults.length);
    expect(assertionResults.every((result) => result.stepId === "protected" && result.status === "succeeded")).toBe(true);
  }, 30_000);
});

function protectedTransaction(origin: string): ProtectedTransaction {
  const name = intent("Name", "textbox");
  const generate = intent("Generate", "button");
  const created = intent("Created", "region");
  const safe = intent("Safe continuation", "region");
  const output = (concept: string, classification: "public" | "unknown_secret") => ({ target: intent(concept, "value"), classification, permittedMethods: ["semantic_field_value" as const], validation: { minimumLength: 1, maximumLength: 200 } });
  return {
    type: "protectedTransaction",
    operationId: "protected-assertion-lifecycle",
    entry: { url: `${origin}/new`, assertions: [{ type: "visible", target: name }] },
    inputs: { name: { classification: "public", value: "campaign" } },
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [{ type: "fillPublicInput", input: "name", target: name, effect: "replayable_setup" }, { type: "assertion", assertion: { type: "enabled", target: generate }, effect: "read_only" }],
      assertions: [{ type: "fieldValueMatchesInput", target: name, input: "name" }, { type: "visible", target: generate }],
    },
    mutation: { action: { type: "click", target: generate, expectedEffect: { type: "new_region", target: created } }, kind: "one_time", reconciliation: { strategy: "none", acceptUnknownOutcome: true } },
    extraction: {
      outputs: [
        { classification: "public", reference: "publicIdentifier", acquisition: output("Public identifier", "public"), storage: { name: "Public identifier", scope: "run" } },
        { classification: "protected", reference: "generatedSecret", acquisition: output("Protected generated value", "unknown_secret"), storage: { credentialName: "Generated secret", scope: "run" } },
      ],
      timeoutMs: 5_000,
      scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: { ceremonyIntent: generate, expectedContainerModel: { version: 2, digest: "a".repeat(64), concept: "Generated value form", scopeKind: "page", capabilityDigest: "b".repeat(64), structuralPath: [] }, valueIntent: intent("Protected generated value", "value"), approvedMethods: ["semantic_field_value"], minimumConfidence: .5, minimumConfidenceMargin: 0, recoveryPolicy: "abandon", recoveryWindowMs: 1_000 },
    continuation: { strategies: [{ mode: "resume_parked_context", reentryUrl: `${origin}/safe`, assertions: [{ type: "visible", target: safe }], continueAtStepId: "complete" }] },
  };
}

function intent(concept: string, role: "textbox" | "button" | "region" | "value"): InteractionTargetIntent {
  return { concept, requiredCapabilities: role === "textbox" ? ["focusable", "accepts_text", "editable", "readable_value"] : role === "button" ? ["pointer_activatable"] : ["readable_value"], preferredEvidence: { roles: [role], names: [concept], labels: role === "textbox" ? [concept] : [], descriptions: [], placeholders: [], inputTypes: [] }, scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"], risk: role === "value" ? "read_only" : "ordinary", confidence: { requiredFamilies: [], minimum: .45, minimumMargin: 0, minimumFamilyCount: 1 } };
}
