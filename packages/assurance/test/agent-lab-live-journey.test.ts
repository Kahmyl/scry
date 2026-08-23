import { describe, expect, it } from "vitest";

import { evaluateAgentLabLiveJourney, type AgentLabRunResult } from "../src/agent-lab/index.js";

const result: AgentLabRunResult = {
  status: "completed",
  objective: "Complete the journey.",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  mcp_url: "http://127.0.0.1:4100/mcp",
  advertised_tools: ["start_mission"],
  budget_profile: "capable_live_journey",
  budget_limits: { maxTurns: 80, maxToolCalls: 100, maxWallTimeSeconds: 3_600 },
  runtime_identity: { releaseId: "release", schemaFingerprint: "schema" },
  external_run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  turns: 12,
  tool_calls: 20,
  invalid_calls: 0,
  stale_reference_calls: 0,
  repeated_unchanged_observations: 0,
  unnecessary_capabilities_calls: 0,
  completed: true,
  duration_ms: 1_000,
  latency: { totalJourneyMs: 1_000, modelInferenceMs: 800, mcpExecutionMs: 200 },
  transcript_path: "transcript.jsonl",
};

describe("Agent Lab native full live-journey qualification", () => {
  it("qualifies retained durable lifecycle facts separately from the fixed matrix", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "deepseek-v4-flash",
      observation: {
        result,
        semanticOwnership: "external_agent",
        lifecycle: {
          missionStatus: "completed",
          objectiveStatus: "passed",
          runStatus: "passed",
          praxisStatus: "completed",
          agentSessionStatus: "completed",
        },
        causalJoinability: {
          publicMcpToApi: true,
          runtimeToDurableStore: true,
          projectDashboardVisible: true,
        },
        privacy: { protectedValueExposed: false, evidenceSanitized: true },
        finalization: { evidenceAvailable: true, reportFinalized: true },
        telemetryResilience: { productTruthChangedBySinkFailure: false },
        evidence: [{ source: "external", kind: "artifact", ref: "artifact://journey/result" }],
      },
    });

    expect(qualification).toMatchObject({ kind: "full_live_journey", status: "PASS" });
  });

  it("never infers missing durable lifecycle or runtime identity", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "missing-evidence",
      observation: {
        result: { ...result, runtime_identity: null },
        evidence: [],
      },
    });
    expect(qualification.status).toBe("PARTIAL");
    expect(qualification.unavailable).toContain("runtimeIdentity:RUNTIME_IDENTITY_UNAVAILABLE");
    expect(qualification.unavailable).toContain(
      "lifecycleSettlement:DURABLE_LIFECYCLE_UNAVAILABLE",
    );
    expect(qualification.unavailable).toContain("evidence:RETAINED_JOURNEY_EVIDENCE_UNAVAILABLE");
  });
});
