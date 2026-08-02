import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { protectedTransactionDigest, transactionInputDigest, transactionInputSchemaDigest } from "@scry/executor";
import type { ProtectedTransaction } from "@scry/contracts";

import { runCalibrationAttestation } from "../src/calibration-runner.js";
import type { CalibrationRuntime } from "../src/calibration-runtime.repository.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const intent=(concept:string,role:"button"|"text"|"value"="text"):import("@scry/contracts").InteractionTargetIntent=>({concept,requiredCapabilities:role==="button"?["pointer_activatable"]:["readable_value"],preferredEvidence:{roles:[role],names:[concept],labels:[],descriptions:[],placeholders:[],inputTypes:[]},scope:{kind:"page"},relations:[],prohibited:["hidden","disabled"],risk:"ordinary",confidence:{requiredFamilies:[],minimum:.45,minimumMargin:0,minimumFamilyCount:1}});
const acquisition=(concept:string)=>({target:intent(concept,"value"),classification:"unknown_secret" as const,permittedMethods:["semantic_field_value" as const],validation:{minimumLength:1,maximumLength:100}});
const readiness=(ceremony:string,value:string)=>({ceremonyIntent:intent(ceremony,"button"),expectedContainerModel:{version:2 as const,digest:"a".repeat(64),concept:ceremony,scopeKind:"page" as const,capabilityDigest:"b".repeat(64),structuralPath:[]},valueIntent:intent(value,"value"),approvedMethods:["semantic_field_value" as const],minimumConfidence:.45,minimumConfidenceMargin:0,recoveryPolicy:"abandon" as const,recoveryWindowMs:1_000});
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("worker calibration attestation", () => {
  it("executes a disposable protected mutation once and produces privacy proof", async () => {
    let mutations = 0;
    let postTargetActions = 0;
    const secret = "calibration-canary-value";
    const server = createServer((request, response) => {
      if (request.url === "/mutate") { mutations += 1; response.end(secret); return; }
      if (request.url === "/after") { postTargetActions += 1; response.end("after"); return; }
      response.setHeader("content-type", "text/html");
      response.end(`<button data-testid="reveal" onclick="fetch('/mutate').then(response=>response.text()).then(value=>document.querySelector('[data-testid=secret]').textContent=value)">Reveal</button><div><div>Client secret</div><output aria-label="Client secret" data-testid="secret"></output></div><button data-testid="close" onclick="location.href='/safe'">Close</button>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const action: ProtectedTransaction = {
      type: "protectedTransaction", operationId: "generate-secret",
      entry: { url: origin, assertions: [{ type: "visible", target: intent("Reveal","button") }] }, inputs: {},
      preparation: { effectPolicy: { ignoredRequests: [] }, actions: [{ type: "assertion", assertion: { type: "visible", target: intent("Reveal","button") }, effect: "read_only" }], assertions: [{ type: "visible", target: intent("Reveal","button") }] },
      mutation: { action: { type: "click", target: intent("Reveal","button"),expectedEffect:{type:"new_region",target:intent("Client secret","value")} }, kind: "one_time", reconciliation: { strategy: "none", acceptUnknownOutcome: true } },
      extraction: { outputs: [{ classification: "protected", reference: "generated-secret", acquisition:acquisition("Client secret"), storage: { credentialName: "Generated secret", scope: "run" } }], timeoutMs: 2_000, scheduling: "fair_shared_timeout" },
      acquisitionReadiness:readiness("Reveal","Client secret"),
      continuation: { strategies: [{ mode: "resume_parked_context", reentryUrl: `${origin}/safe`, assertions: [{ type: "url", expected: "/safe", match: "path" }], continueAtStepId: "after" }] },
    };
    const runtime: CalibrationRuntime = {
      sessionId: crypto.randomUUID(), attemptId: crypto.randomUUID(), claimToken: crypto.randomUUID(), contractRevisionId: crypto.randomUUID(),
      operationDigest: protectedTransactionDigest(action, [origin]), inputSchemaDigest: transactionInputSchemaDigest(action), inputDigest: transactionInputDigest(action), operationId: action.operationId, operation: action,
      environmentId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      policy: { allowedOrigins: [origin], allowPrivateNetwork: true, allowDownloads: false, allowPopups: false, maxActions: 10, maxDurationMs: 10_000, maxNavigations: 2 },
      plan: { name: "Calibration", objective: "Attest protected operation", preconditions: [], allowedOrigins: [origin], budgets: { maxActions: 10, maxDurationMs: 10_000, maxNavigations: 2 }, checkpoints: [], steps: [
        { id: "open", title: "Open", action: { type: "navigate", url: origin }, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" },
        { id: "protect", title: "Generate", action, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" },
        { id: "after", title: "Must not run during calibration", action: { type: "navigate", url: `${origin}/after` }, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" },
      ] },
    };
    const mutationStates: string[] = [];
    const result = await runCalibrationAttestation(runtime, process.env.SCRY_BROWSER_CHANNEL ?? "chrome", undefined, async (state) => { mutationStates.push(state); return true; });
    expect(result.passed, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ mutationCount: 1, privacyVerified: true, canaryScanPassed: true, diagnostics: { code: "CALIBRATION_ATTESTED" } });
    expect(mutations).toBe(1);
    expect(postTargetActions).toBe(0);
    expect(mutationStates).toEqual(["started", "completed"]);
  }, 20_000);

  it("preserves the safe failing preflight step instead of collapsing it to boundary not reached", async () => {
    const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<main>ready</main>"); });
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const action: ProtectedTransaction = { type: "protectedTransaction", operationId: "never-reached", entry: { url: origin, assertions: [{ type: "visible", target: intent("ready") }] }, inputs: {}, preparation: { effectPolicy: { ignoredRequests: [] }, actions: [{ type: "assertion", assertion: { type: "visible", target: intent("ready") }, effect: "read_only" }], assertions: [{ type: "visible", target: intent("ready") }] }, mutation: { action: { type: "click", target: intent("Reveal","button"),expectedEffect:{type:"none"} }, kind: "one_time", reconciliation: { strategy: "none", acceptUnknownOutcome: true } }, extraction: { outputs: [{ classification: "protected", reference: "secret", acquisition:acquisition("Secret"), storage: { credentialName: "Secret", scope: "run" } }], timeoutMs: 100, scheduling: "fair_shared_timeout" }, acquisitionReadiness:readiness("Reveal","Secret"), continuation: { strategies: [{ mode: "terminal" }] } };
    const result = await runCalibrationAttestation({ sessionId: crypto.randomUUID(), attemptId: crypto.randomUUID(), claimToken: crypto.randomUUID(), contractRevisionId: crypto.randomUUID(), operationDigest: protectedTransactionDigest(action, [origin]), inputSchemaDigest: transactionInputSchemaDigest(action), inputDigest: transactionInputDigest(action), operationId: action.operationId, operation: action, environmentId: crypto.randomUUID(), projectId: crypto.randomUUID(), policy: { allowedOrigins: [origin], allowPrivateNetwork: true, allowDownloads: false, allowPopups: false, maxActions: 5, maxDurationMs: 3_000, maxNavigations: 1 }, plan: { name: "Failure", objective: "Preserve failure", preconditions: [], allowedOrigins: [origin], budgets: { maxActions: 5, maxDurationMs: 3_000, maxNavigations: 1 }, checkpoints: [], steps: [{ id: "open", title: "Open", action: { type: "navigate", url: origin }, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" }, { id: "missing-step", title: "Missing", action: { type: "click", target: intent("Missing","button"),expectedEffect:{type:"none"}, timeoutMs: 100 }, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" }, { id: "protected", title: "Protected", action, assertions: [], onFailure: "stop", evidence: [], captureIntent: "final" }] } }, process.env.SCRY_BROWSER_CHANNEL ?? "chrome");
    expect(result).toMatchObject({ passed: false, mutationCount: 0, diagnostics: { code: "CALIBRATION_PREFLIGHT_STEP_FAILED", stepId: "missing-step", phase: "preflight" } });
  }, 20_000);
});
