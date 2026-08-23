import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { performanceAgentIterationFromResult, runAgentLab } from "@scry/assurance";
import type { PerformanceAgentIteration } from "@scry/contracts";

import { closeCampaignContext, createCampaignContext } from "./adaptive-campaign-support.js";
import {
  performanceJourneyOracle,
  POST_BETA_SCENARIO,
  provisionPerformanceJourney,
  type PerformanceJourney,
} from "./post-beta-performance-support.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const requestedIterations = positiveInteger(process.env.SCRY_PERFORMANCE_AGENT_ITERATIONS, 3);
const sourceCommit = requiredEnvironment("SCRY_PERFORMANCE_SOURCE_COMMIT");
const outputDirectory = path.resolve(
  repositoryRoot,
  process.env.SCRY_PERFORMANCE_OUTPUT_DIRECTORY ?? "artifacts/post-beta-execution/item08-baseline",
);
const mcpUrl = process.env.SCRY_MCP_URL ?? "http://127.0.0.1:4100/mcp";
const iterations: PerformanceAgentIteration[] = [];
let cleanIterations = 0;

for (
  let attempt = 1;
  attempt <= requestedIterations + 1 && cleanIterations < requestedIterations;
  attempt += 1
) {
  const context = await createCampaignContext();
  try {
    const journey = await provisionPerformanceJourney(context);
    const runDirectory = path.join(outputDirectory, "agent", `attempt-${attempt}`);
    const invocation = await runAgentLab({
      objective: objective(journey),
      provider: "deepseek",
      mcpUrl,
      maxTurns: 40,
      maxToolCalls: 32,
      outputDirectory: runDirectory,
    });
    const oracle = await performanceJourneyOracle(journey);
    const oracleFile = path.join(runDirectory, "scenario-oracle.json");
    await writeFile(oracleFile, `${JSON.stringify(oracle, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    const record = performanceAgentIterationFromResult({
      iteration: attempt,
      sourceCommit,
      scenario: POST_BETA_SCENARIO,
      resultRef: path.relative(outputDirectory, path.join(runDirectory, "result.json")),
      oracleRef: path.relative(outputDirectory, oracleFile),
      scenarioCompleted: oracle.scenarioCompleted,
      result: invocation.result,
    });
    iterations.push(record);
    if (clean(record)) cleanIterations += 1;
    process.stdout.write(
      `${JSON.stringify({
        attempt,
        status: record.status,
        scenarioCompleted: record.scenarioCompleted,
        turns: record.turns,
        toolCalls: record.toolCalls,
        invalidCalls: record.invalidCalls,
        staleReferenceCalls: record.staleReferenceCalls,
        repeatedUnchangedObservations: record.repeatedUnchangedObservations,
        unnecessaryCapabilitiesCalls: record.unnecessaryCapabilitiesCalls,
      })}\n`,
    );
  } finally {
    await closeCampaignContext(context);
  }
}

await mkdir(outputDirectory, { recursive: true });
const resultFile = path.join(
  outputDirectory,
  process.env.SCRY_PERFORMANCE_AGENT_RESULT_NAME ??
    `agent-iterations-${sourceCommit.slice(0, 12)}.json`,
);
await writeFile(resultFile, `${JSON.stringify(iterations, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(
  `${JSON.stringify({
    status: cleanIterations >= requestedIterations ? "complete" : "incomplete",
    cleanIterations,
    requestedIterations,
    attempts: iterations.length,
    result: resultFile,
  })}\n`,
);
if (cleanIterations < requestedIterations) process.exitCode = 1;

function objective(journey: PerformanceJourney) {
  return [
    `The user explicitly chooses to continue Mission ${journey.missionId} in Project ${journey.projectId}. Resume that exact Mission and use only the returned active agentSessionId.`,
    `Complete Objective ${journey.objectiveId} using the already published Flow revision ${journey.flowRevisionId}, environment ${journey.environmentId}, and Flow draft ${journey.flowDraftId}.`,
    `Use the current agent-directed lifecycle: start one ordinary Praxis session, observe exact opaque references, start one Run, and dispatch exactly one operation at a time.`,
    `On the deterministic fixture, activate Open controls using its exact observed reference, then dispatch an ordinary navigation to ${journey.fixtureOrigin}/details, observe the new document, and verify the heading Execution complete.`,
    `After factual verification, explicitly finalize the Run as passed and close the Praxis session.`,
    `This is ordinary local fixture work: use no credentials, no protected authorization, no provider mutation, no capabilities call, and get_operating_context at most once.`,
    `Never invent references or IDs. If Scry refuses safely, stop and report the exact blocker rather than bypassing authority or stale-reference rules.`,
  ].join(" ");
}

function clean(record: PerformanceAgentIteration) {
  return (
    record.status === "completed" &&
    record.completed &&
    record.scenarioCompleted &&
    record.invalidCalls === 0 &&
    record.staleReferenceCalls === 0 &&
    record.repeatedUnchangedObservations === 0 &&
    record.unnecessaryCapabilitiesCalls === 0
  );
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
    throw new Error("SCRY_PERFORMANCE_AGENT_ITERATIONS_INVALID");
  return parsed;
}
