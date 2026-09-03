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
        completionEvidence: {
          kind: "mission",
          missionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          missionStatus: "completed",
          relevantRunsTerminal: true,
          unresolvedTerminalBlocker: false,
          requiredEvidenceFinalized: true,
          reportRequired: true,
          finalReportAvailable: true,
        },
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
    expect(qualification.status).toBe("FAIL");
    expect(qualification.unavailable).toContain("runtimeIdentity:RUNTIME_IDENTITY_UNAVAILABLE");
    expect(qualification.unavailable).toContain(
      "lifecycleSettlement:DURABLE_LIFECYCLE_UNAVAILABLE",
    );
    expect(qualification.unavailable).toContain("evidence:RETAINED_JOURNEY_EVIDENCE_UNAVAILABLE");
  });

  it("fails completion when the model stops with an unresolved user-authority blocker", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "blocked-before-mission",
      observation: {
        result: {
          ...result,
          status: "blocked",
          completed: false,
          terminal_outcome: "blocked_user_authority",
          terminal_blocker: {
            code: "MISSION_SELECTION_REQUIRED",
            userAuthorityRequired: true,
          },
        },
        lifecycle: {
          stage: "pre_mission",
          missionCreated: false,
          agentSessionStatus: "blocked",
          blockerCode: "MISSION_SELECTION_REQUIRED",
          terminationReason: "EXTERNAL_AGENT_BLOCKED_USER_AUTHORITY",
        },
        evidence: [{ source: "external", kind: "artifact", ref: "artifact://blocked/result" }],
      },
    });

    expect(qualification.dimensions.completion).toMatchObject({
      status: "fail",
      reasonCodes: expect.arrayContaining(["LIVE_JOURNEY_INCOMPLETE"]),
    });
    expect(qualification.dimensions.lifecycleSettlement.status).toBe("pass");
  });

  it("does not trust a legacy completed boolean without corroborating product evidence", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "legacy-agent-lab",
      observation: {
        result,
        evidence: [{ source: "external", kind: "artifact", ref: "artifact://legacy/result" }],
      },
    });

    expect(qualification.dimensions.completion).toEqual({
      status: "fail",
      reasonCodes: ["COMPLETION_EVIDENCE_UNAVAILABLE"],
    });
  });

  it("accepts an explicit deterministic smoke oracle without fabricating a Mission", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "deterministic-smoke",
      observation: {
        result: { ...result, status: "stopped", completed: false },
        completionEvidence: {
          kind: "scenario_oracle",
          oracleId: "smoke-fixture-completed",
          scenarioCompleted: true,
        },
        evidence: [{ source: "fixture", kind: "artifact", ref: "artifact://smoke/oracle" }],
      },
    });

    expect(qualification.dimensions.completion.status).toBe("pass");
  });

  it("does not let a smoke oracle erase a blocked harness outcome", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "blocked-smoke",
      observation: {
        result: { ...result, status: "blocked", completed: false },
        completionEvidence: {
          kind: "scenario_oracle",
          oracleId: "preexisting-smoke-state",
          scenarioCompleted: true,
        },
        evidence: [{ source: "fixture", kind: "artifact", ref: "artifact://smoke/oracle" }],
      },
    });

    expect(qualification.dimensions.completion).toEqual({
      status: "fail",
      reasonCodes: ["LIVE_JOURNEY_INCOMPLETE"],
    });
  });

  it("passes pre-Mission causal joinability using only identities that factually exist", () => {
    const qualification = evaluateAgentLabLiveJourney({
      cohort: "pre-mission-causal",
      observation: {
        result: { ...result, status: "blocked", completed: false },
        causalJoinability: {
          stage: "pre_mission",
          publicMcpToApi: true,
          runtimeToDurableStore: true,
          projectDashboardVisible: true,
          identities: {
            projectId: true,
            correlationId: true,
            agentSessionId: true,
            missionId: false,
            runId: false,
          },
        },
        evidence: [{ source: "external", kind: "artifact", ref: "artifact://pre-mission/event" }],
      },
    });

    expect(qualification.dimensions.causalJoinability.status).toBe("pass");
  });
});
