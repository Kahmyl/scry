import { describe, expect, it } from "vitest";
import type { InteractionTargetIntent, ProtectedTransaction } from "@scry/contracts";
import { protectedTransactionDigest, transactionInputDigest, transactionInputSchemaDigest } from "../src/calibration.js";
const intent=(concept:string,role:"button"|"textbox"|"value"="textbox"):InteractionTargetIntent=>({concept,requiredCapabilities:role==="textbox"?["focusable","accepts_text","editable","readable_value"]:role==="button"?["pointer_activatable"]:["readable_value"],preferredEvidence:{roles:[role],names:[concept],labels:role==="textbox"?[concept]:[],descriptions:[],placeholders:role==="textbox"?[concept]:[],inputTypes:[]},scope:{kind:"page"},relations:[],prohibited:["hidden","disabled"],risk:"credential",confidence:{requiredFamilies:[],minimumFamilyCount:3}});

function transaction(name = "Disposable app"): ProtectedTransaction {
  return {
    type: "protectedTransaction", operationId: "issue-secret",
    entry: { url: "https://example.test/new", assertions: [{ type: "visible", target: intent("Name") }] },
    inputs: { applicationName: { classification: "public", value: name } },
    preparation: { effectPolicy: { ignoredRequests: [] }, actions: [{ type: "fillPublicInput", input: "applicationName", target: intent("Name"), effect: "replayable_setup" }], assertions: [
      { type: "fieldValueMatchesInput", target: intent("Name"), input: "applicationName" },
      { type: "enabled", target: intent("Issue","button") },
    ] },
    mutation: { action: { type: "click", target: intent("Issue","button"), expectedEffect:{type:"new_region",target:intent("Secret","value")} }, kind: "one_time", reconciliation: { strategy: "none", acceptUnknownOutcome: true } },
    extraction: { outputs: [{ classification: "protected", reference: "issued_secret", acquisition:{target:intent("Secret","value"),classification:"unknown_secret",permittedMethods:["semantic_field_value"],validation:{minimumLength:1,maximumLength:20_000}}, storage: { scope: "project", credentialName: "Display name" } }], timeoutMs: 5_000, scheduling: "fair_shared_timeout" },
    acquisitionReadiness:{ceremonyIntent:intent("Issue","button"),expectedContainerModel:{version:2,digest:"a".repeat(64),concept:"Issue",scopeKind:"page",capabilityDigest:"b".repeat(64),structuralPath:[]},valueIntent:intent("Secret","value"),approvedMethods:["semantic_field_value"],minimumConfidence:.6,minimumConfidenceMargin:0,recoveryPolicy:"abandon",recoveryWindowMs:1_000},
    continuation: { strategies: [{ mode: "terminal" }] },
  };
}

describe("protected transaction digests", () => {
  it("separates program, input schema, and concrete input identity", () => {
    const baseline = transaction("Calibration app"); const production = transaction("Production app");
    expect(protectedTransactionDigest(production, ["https://example.test/path"])).toBe(protectedTransactionDigest(baseline, ["https://example.test"]));
    expect(transactionInputSchemaDigest(production)).toBe(transactionInputSchemaDigest(baseline));
    expect(transactionInputDigest(production, "key")).not.toBe(transactionInputDigest(baseline, "key"));
  });

  it("changes for execution-sensitive boundaries but ignores binding and display names", () => {
    const baseline = transaction(); const digest = protectedTransactionDigest(baseline, ["https://example.test"]);
    const rebound = { ...baseline, calibrationAttestationId: "11111111-1111-4111-8111-111111111111", extraction: { ...baseline.extraction, outputs: baseline.extraction.outputs.map((output) => output.classification === "protected" ? { ...output, storage: { ...output.storage, credentialName: "Renamed" } } : output) } };
    expect(protectedTransactionDigest(rebound, ["https://example.test"])).toBe(digest);
    expect(protectedTransactionDigest({ ...baseline, mutation: { ...baseline.mutation, kind: "repeatable" } }, ["https://example.test"])).not.toBe(digest);
    expect(protectedTransactionDigest({ ...baseline, preparation: { ...baseline.preparation, actions: [] as never } }, ["https://example.test"])).not.toBe(digest);
  });
});
