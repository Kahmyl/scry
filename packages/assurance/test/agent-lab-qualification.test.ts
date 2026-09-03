import { describe, expect, it } from "vitest";

import {
  agentLabScenarios,
  combineAgentLabCohorts,
  runAgentLabQualification,
  type AgentLabRunResult,
} from "../src/agent-lab/index.js";

function passingResult(objective: string): AgentLabRunResult {
  return {
    status: "completed",
    objective,
    provider: "fake",
    model: "deterministic-fake",
    mcp_url: "http://fake/mcp",
    advertised_tools: ["get_operating_context"],
    turns: 2,
    tool_calls: 1,
    invalid_calls: 0,
    stale_reference_calls: 0,
    repeated_unchanged_observations: 0,
    unnecessary_capabilities_calls: 0,
    completed: true,
    duration_ms: 10,
    transcript_path: "transcript.jsonl",
  };
}

describe("Agent Lab behavioral qualification", () => {
  it("covers every lifecycle scenario through a deterministic fake adapter", async () => {
    const qualification = await runAgentLabQualification({
      cohort: "deterministic-fake",
      execute: async (scenario) => passingResult(scenario.objective),
    });

    expect(qualification.status).toBe("PASS");
    expect(qualification.scenarioRuns.map(({ scenarioId }) => scenarioId)).toEqual(
      agentLabScenarios.map(({ id }) => id),
    );
    expect(qualification.totals).toMatchObject({
      completed: 8,
      invalidCalls: 0,
      staleReferenceCalls: 0,
      repeatedUnchangedObservations: 0,
      unnecessaryCapabilitiesCalls: 0,
    });
  });

  it("truthfully reports unavailable live cohorts and never lets a challenger overwrite primary", async () => {
    const unavailable = await runAgentLabQualification({
      cohort: "local-primary",
      externalPrerequisite: "local model runtime unavailable",
    });
    const challenger = await runAgentLabQualification({
      cohort: "challenger",
      execute: async (scenario) => passingResult(scenario.objective),
    });

    expect(unavailable.status).toBe("PARTIAL_EXTERNAL_PREREQUISITE");
    expect(combineAgentLabCohorts(unavailable, challenger).status).toBe(
      "PARTIAL_EXTERNAL_PREREQUISITE",
    );
  });
});
