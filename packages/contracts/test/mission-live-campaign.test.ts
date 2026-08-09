import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { missionLiveCampaignResultSchema } from "../src/mission-live-campaign.js";

function report() {
  const id = randomUUID();
  const phase = { count: 1, p50Ms: 1, p95Ms: 1, maxMs: 1, slowestOperationIds: ["operation"] };
  return {
    schemaVersion: 2, releaseId: "m1-local", gitCommit: "a".repeat(40),
    schemaFingerprint: "b".repeat(64), runtimeVersion: "m1-local",
    runtimeConfigurationDigest: "c".repeat(64), milestone: "M1", target: "orangehrm",
    repetition: 1, missionId: id, objectiveIds: [id], flowIds: [id], runIds: [], correlationId: id,
    boundaryUnderTest: "native login", requiredChecks: [{ id: "journey", description: "journey", status: "passed" }],
    observationalFindings: [], cleanup: { required: true, state: "completed", refs: [] },
    calls: { mcp: 2, api: 1, repeatedStateReads: 0 },
    resolution: { nativeResolved: 5, praxisFallbacks: 0 },
    reductions: { decisionBoundary: 0.8, mcpCalls: 0.8, agentBytes: 0.7 },
    timings: Object.fromEntries(["browser_startup", "document_observation", "native_resolution",
      "interaction_execution", "expected_effect_verification", "evidence_finalization", "artifact_retrieval"]
      .map((name) => [name, phase])),
    privacyScan: { checkedByteCount: 100, leakedCanaryCount: 0 }, evidenceRefs: ["report"], verdict: "pass",
  };
}

describe("canonical mission live campaign report", () => {
  it("accepts a complete passing report", () => {
    expect(missionLiveCampaignResultSchema.parse(report())).toMatchObject({ schemaVersion: 2, verdict: "pass" });
  });
  it("rejects missing runtime identity and any failed required check on a pass", () => {
    const input = report();
    delete (input as Partial<typeof input>).runtimeConfigurationDigest;
    input.requiredChecks[0]!.status = "failed";
    expect(missionLiveCampaignResultSchema.safeParse(input).success).toBe(false);
  });
});
