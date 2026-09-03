import type { AgentLabRunResult } from "./types.js";

export const agentLabScenarios = [
  {
    id: "readiness",
    objective:
      "Inspect Scry readiness and report the exact blocker and safest next action without changing state.",
  },
  {
    id: "authoring_preparation",
    objective:
      "Prepare the current Mission's authoring context using only published Scry MCP contracts and stop at the first user-owned prerequisite.",
  },
  {
    id: "exact_references",
    objective:
      "Observe the live Praxis session, identify the exact opaque reference for the stated control from factual context, and do not dispatch.",
  },
  {
    id: "protected_authorization",
    objective:
      "Determine the exact protected-mutation authorization binding required for the pending operation and request only that scoped authorization.",
  },
  {
    id: "dispatch",
    objective:
      "Dispatch exactly the pending bounded Run operation with current exact references, then report its factual functional, mutation, privacy, and evidence outcomes.",
  },
  {
    id: "unknown_recovery",
    objective:
      "Recover safely from the pending UNKNOWN mutation outcome without redispatching it and report whether the Mission fence cleared.",
  },
  {
    id: "evidence_selection",
    objective:
      "Inspect the completed Run and accept only the exact Objective evidence required by current Mission readiness.",
  },
  {
    id: "final_reporting",
    objective:
      "Reach terminal-safe Mission report readiness, publish the supplied final conclusion and journey summary exactly once, then identify the required agent-session finalization.",
  },
] as const;

export type AgentLabScenarioId = (typeof agentLabScenarios)[number]["id"];
export type AgentLabScenario = (typeof agentLabScenarios)[number];

export type AgentLabScenarioRun = Readonly<{
  scenarioId: AgentLabScenarioId;
  result: AgentLabRunResult;
}>;

export type AgentLabQualification = Readonly<{
  status: "PASS" | "FAIL" | "PARTIAL_EXTERNAL_PREREQUISITE";
  cohort: string;
  scenarioRuns: readonly AgentLabScenarioRun[];
  missingScenarios: readonly AgentLabScenarioId[];
  failures: readonly string[];
  externalPrerequisite?: string;
  totals: Readonly<{
    turns: number;
    toolCalls: number;
    durationMs: number;
    invalidCalls: number;
    staleReferenceCalls: number;
    repeatedUnchangedObservations: number;
    unnecessaryCapabilitiesCalls: number;
    completed: number;
  }>;
}>;

export async function runAgentLabQualification(input: {
  cohort: string;
  execute?: (scenario: AgentLabScenario) => Promise<AgentLabRunResult>;
  externalPrerequisite?: string;
}): Promise<AgentLabQualification> {
  if (!input.execute)
    return evaluateAgentLabQualification({
      cohort: input.cohort,
      scenarioRuns: [],
      externalPrerequisite: input.externalPrerequisite ?? "Agent Lab model/runtime is unavailable.",
    });

  const scenarioRuns: AgentLabScenarioRun[] = [];
  for (const scenario of agentLabScenarios)
    scenarioRuns.push({ scenarioId: scenario.id, result: await input.execute(scenario) });
  return evaluateAgentLabQualification({ cohort: input.cohort, scenarioRuns });
}

export function evaluateAgentLabQualification(input: {
  cohort: string;
  scenarioRuns: readonly AgentLabScenarioRun[];
  externalPrerequisite?: string;
}): AgentLabQualification {
  const byScenario = new Map(input.scenarioRuns.map((run) => [run.scenarioId, run]));
  const missingScenarios = agentLabScenarios
    .map(({ id }) => id)
    .filter((id) => !byScenario.has(id));
  const failures: string[] = [];

  for (const { scenarioId, result } of input.scenarioRuns) {
    if (!result.completed || result.status !== "completed")
      failures.push(`${scenarioId}:incomplete`);
    if (result.invalid_calls) failures.push(`${scenarioId}:invalid_calls=${result.invalid_calls}`);
    if (result.stale_reference_calls)
      failures.push(`${scenarioId}:stale_reference_calls=${result.stale_reference_calls}`);
    if (result.repeated_unchanged_observations)
      failures.push(
        `${scenarioId}:repeated_unchanged_observations=${result.repeated_unchanged_observations}`,
      );
    if (result.unnecessary_capabilities_calls)
      failures.push(
        `${scenarioId}:unnecessary_capabilities_calls=${result.unnecessary_capabilities_calls}`,
      );
  }

  const totals = input.scenarioRuns.reduce(
    (total, { result }) => ({
      turns: total.turns + result.turns,
      toolCalls: total.toolCalls + result.tool_calls,
      durationMs: total.durationMs + result.duration_ms,
      invalidCalls: total.invalidCalls + result.invalid_calls,
      staleReferenceCalls: total.staleReferenceCalls + result.stale_reference_calls,
      repeatedUnchangedObservations:
        total.repeatedUnchangedObservations + result.repeated_unchanged_observations,
      unnecessaryCapabilitiesCalls:
        total.unnecessaryCapabilitiesCalls + result.unnecessary_capabilities_calls,
      completed: total.completed + (result.completed ? 1 : 0),
    }),
    {
      turns: 0,
      toolCalls: 0,
      durationMs: 0,
      invalidCalls: 0,
      staleReferenceCalls: 0,
      repeatedUnchangedObservations: 0,
      unnecessaryCapabilitiesCalls: 0,
      completed: 0,
    },
  );

  const externalPrerequisite = input.externalPrerequisite;
  return {
    status: externalPrerequisite
      ? "PARTIAL_EXTERNAL_PREREQUISITE"
      : missingScenarios.length || failures.length
        ? "FAIL"
        : "PASS",
    cohort: input.cohort,
    scenarioRuns: input.scenarioRuns,
    missingScenarios,
    failures,
    ...(externalPrerequisite ? { externalPrerequisite } : {}),
    totals,
  };
}

/** A challenger is evidence only; it never changes the primary cohort's truth. */
export function combineAgentLabCohorts(
  primary: AgentLabQualification,
  challenger?: AgentLabQualification,
) {
  return { status: primary.status, primary, ...(challenger ? { challenger } : {}) } as const;
}
