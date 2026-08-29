import { describe, expect, it } from "vitest";
import { Q5_MCP_CONTRACT_DIGEST } from "@scry/contracts";

import {
  Q5_EVIDENCE_SCHEMA,
  opaqueExternalIdentity,
  validateQ5EvidenceManifest,
  type Q5EvidenceManifest,
} from "../src/architecture/m6/q5-evidence.js";

const hex = (value: string) => opaqueExternalIdentity(value);
const ids = {
  authoritativeAttemptId: "attempt-q5",
  campaignId: "campaign-q5",
  projectId: "project-q5",
  environmentId: "environment-q5",
  canonicalApplicationId: "application-q5",
  missionId: "mission-q5",
  objectiveId: "objective-q5",
  agentSessionId: "agent-q5",
  externalRunId: "external-q5",
};
const expected = {
  sourceCommit: "a".repeat(40),
  sourceManifestSha256: "b".repeat(64),
  schemaFingerprint: "c".repeat(64),
  migrationSha256: "d".repeat(64),
  projectId: ids.projectId,
  environmentId: ids.environmentId,
  canonicalApplicationId: ids.canonicalApplicationId,
};

function valid(): Q5EvidenceManifest {
  return {
    schema: Q5_EVIDENCE_SCHEMA,
    qualification: "M6_Q5_VITRACT_PREVIEW_TEST",
    source: {
      commit: expected.sourceCommit,
      dirty: false,
      manifestSha256: expected.sourceManifestSha256,
      runtimeManifestSha256: expected.sourceManifestSha256,
      schemaFingerprint: expected.schemaFingerprint,
      migrationSha256: expected.migrationSha256,
    },
    authority: {
      ...ids,
      authoritativeAttemptState: "succeeded",
      campaignDisposition: "succeeded",
      applicationIdentity: "vitract-preview-test",
      origin: "https://preview-api.vitract.com",
    },
    runtime: {
      runId: "run-q5",
      runState: "passed",
      attemptId: "run-attempt-q5",
      attemptState: "succeeded",
      praxisSessionId: "praxis-q5",
      praxisState: "completed",
      agentSessionState: "completed",
      missionState: "completed",
      objectiveState: "passed",
      reportState: "published",
    },
    protectedOperation: { id: "protected-q5", state: "succeeded", plaintextExposed: false },
    mutation: {
      operationId: "mutation-q5",
      identity: "create-preview-test-order",
      outcome: "applied",
      campaignConsumptions: 1,
      dispatches: 1,
      externalRequests: 1,
      externalEffects: 1,
      duplicates: 0,
      redispatches: 0,
    },
    retrieval: {
      createdOpaqueDigest: hex("order-q5"),
      retrievedOpaqueDigest: hex("order-q5"),
      association: "exact_digest_match",
      retrievalCount: 1,
    },
    evidence: [
      "public_discovery",
      "protected_authentication",
      "business_mutation",
      "external_effect_binding",
      "exact_retrieval",
      "run_operation",
      "run_finalization",
      "objective_acceptance",
      "mission_report",
    ].map((kind) => ({
      kind,
      state: "accepted",
      required: true,
      proof: [`durable:${kind}`],
    })) as Q5EvidenceManifest["evidence"],
    provider: { name: "deepseek", model: "deepseek-chat", requestCount: 3, automaticRetries: 0 },
    mcp: {
      profile: "q5-authoritative-v1",
      protocolVersion: "2025-11-25",
      toolCount: 30,
      contractDigest: Q5_MCP_CONTRACT_DIGEST,
    },
    privacy: { audit: "PASS", protectedLeakCount: 0 },
    residue: { adjudication: "PASS", unsafeLiveOwners: 0, unknownPreserved: true },
  };
}

describe("authoritative M6 Q5 evidence", () => {
  it("accepts one exact real Vitract Q5 success", () => {
    expect(validateQ5EvidenceManifest(valid(), expected)).toEqual({
      pass: true,
      issues: [],
      manifest: valid(),
    });
  });

  it.each([
    ["wrong application", (m: any) => (m.authority.canonicalApplicationId = "other")],
    ["wrong environment", (m: any) => (m.authority.environmentId = "other")],
    ["wrong Mission", (m: any) => (m.authority.missionId = "")],
    ["wrong Objective", (m: any) => (m.authority.objectiveId = "")],
    ["wrong Run", (m: any) => (m.runtime.runState = "failed")],
    ["wrong agent", (m: any) => (m.authority.agentSessionId = "")],
    ["wrong campaign", (m: any) => (m.authority.campaignId = "")],
    ["wrong authoritative attempt", (m: any) => (m.authority.authoritativeAttemptId = "")],
    ["generic Q3 success", (m: any) => (m.qualification = "Q3_LOCAL_RESOURCE")],
    ["creation without retrieval", (m: any) => (m.retrieval.association = "missing")],
    [
      "different retrieved resource",
      (m: any) => (m.retrieval.retrievedOpaqueDigest = hex("other")),
    ],
    ["missing evidence", (m: any) => m.evidence.pop()],
    ["failed evidence", (m: any) => (m.evidence[0].state = "failed")],
    ["quarantined evidence", (m: any) => (m.evidence[0].state = "quarantined")],
    ["unbound evidence", (m: any) => (m.evidence[0].proof = [])],
    ["failed finalization", (m: any) => (m.runtime.reportState = "failed")],
    ["stale prior artifact", (m: any) => (m.source.commit = "f".repeat(40))],
    ["terminal inconsistency", (m: any) => (m.authority.campaignDisposition = "failed")],
    ["privacy failure", (m: any) => (m.privacy.protectedLeakCount = 1)],
  ])("rejects %s", (_name, mutate) => {
    const manifest = structuredClone(valid()) as any;
    mutate(manifest);
    expect(validateQ5EvidenceManifest(manifest, expected).pass).toBe(false);
  });

  it("ignores forged PASS environment variables", () => {
    process.env.SCRY_M6_Q5_RESULT = "PASS";
    expect(validateQ5EvidenceManifest(undefined, expected).pass).toBe(false);
    delete process.env.SCRY_M6_Q5_RESULT;
  });
});
