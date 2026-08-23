import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  performanceIterationFromCampaign,
  retainPerformanceBenchmark,
  summarizePerformanceBenchmark,
} from "@scry/assurance";
import {
  performanceAgentIterationSchema,
  type PerformanceAgentIteration,
  type PerformanceIteration,
} from "@scry/contracts";

import {
  checkProductionTopology,
  closeCampaignContext,
  createCampaignContext,
} from "./adaptive-campaign-support.js";
import {
  performanceJourneyOracle,
  POST_BETA_SCENARIO,
  provisionPerformanceJourney,
  runScriptedPerformanceJourney,
} from "./post-beta-performance-support.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const requestedIterations = positiveInteger(process.env.SCRY_PERFORMANCE_ITERATIONS, 10);
const outputDirectory = path.resolve(
  repositoryRoot,
  process.env.SCRY_PERFORMANCE_OUTPUT_DIRECTORY ?? "artifacts/post-beta-execution/item08-baseline",
);
const sourceCommit = requiredEnvironment("SCRY_PERFORMANCE_SOURCE_COMMIT");
const releaseId = requiredEnvironment("SCRY_RELEASE_ID");
const schemaFingerprint = requiredEnvironment("SCRY_SCHEMA_FINGERPRINT");
const runtimeVersion = requiredEnvironment("SCRY_RUNTIME_VERSION");
const agentIterations = await readAgentIterations(
  process.env.SCRY_PERFORMANCE_AGENT_ITERATIONS_PATH,
);
const iterations: PerformanceIteration[] = [];
let cleanIterations = 0;

await mkdir(path.join(outputDirectory, "raw"), { recursive: true });
for (
  let attempt = 1;
  attempt <= requestedIterations + 1 && cleanIterations < requestedIterations;
  attempt += 1
) {
  const context = await createCampaignContext();
  const startedAt = new Date().toISOString();
  const productStartedAt = performance.now();
  let verdict: "pass" | "fail" = "fail";
  let failureReasonCode: string | undefined;
  let failureFacts: Record<string, unknown> | undefined;
  let raw: Record<string, unknown> = {};
  try {
    await context.metrics.phase(
      `benchmark-readiness-${attempt}`,
      "readiness",
      { source: "campaign_client", eventId: `benchmark-readiness-${attempt}` },
      () => checkProductionTopology(context),
    );
    const journey = await context.metrics.phase(
      `benchmark-provision-${attempt}`,
      "persistence",
      { source: "control_plane_query", eventId: `benchmark-provision-${attempt}` },
      () => provisionPerformanceJourney(context),
    );
    const result = await runScriptedPerformanceJourney({
      ...journey,
      correlationId: context.correlationId,
      onCall(name, durationMs, bytes) {
        const ordinal = context.metrics.snapshot().mcpRequests + 1;
        const eventId = `benchmark-${attempt}-${name}-${ordinal}`;
        context.metrics.countMcpRequest({ source: "mcp_http", eventId });
        context.metrics.countBytesReturned(bytes, { source: "mcp_http", eventId });
        context.metrics.record(eventId, phaseFor(name), durationMs, {
          source: "mcp_http",
          eventId,
        });
        if (name === "start_praxis_session")
          context.metrics.countBrowserLaunch({ source: "browser_event", eventId });
        if (name === "dispatch_run_operation")
          context.metrics.countDecisionBoundary({ source: "campaign_client", eventId });
        if (name === "finalize_run")
          context.metrics.countEvidenceFinalization({ source: "artifact_event", eventId });
      },
      onFailure(name, facts) {
        failureFacts = { tool: name, ...facts };
      },
    });
    const oracle = await context.metrics.phase(
      `benchmark-completion-${attempt}`,
      "completion",
      { source: "control_plane_query", eventId: `benchmark-completion-${attempt}` },
      () => performanceJourneyOracle(journey),
    );
    if (!oracle.scenarioCompleted) throw new Error("PERFORMANCE_SCENARIO_ORACLE_FAILED");
    verdict = "pass";
    raw = {
      correlationId: context.correlationId,
      runId: result.runId,
      praxisSessionId: result.praxisSessionId,
      finalUrl: result.observation.url,
      oracle,
      calls: result.calls,
    };
  } catch (error) {
    failureReasonCode = safeCode(error);
    raw = { correlationId: context.correlationId, failureReasonCode, failureFacts };
  }
  const productWallClockMs = performance.now() - productStartedAt;
  const rawFile = path.join(outputDirectory, "raw", `product-attempt-${attempt}.json`);
  await context.metrics.phase(
    `benchmark-publication-${attempt}`,
    "publication",
    { source: "artifact_event", eventId: `benchmark-publication-${attempt}` },
    () => writeFile(rawFile, `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" }),
  );
  iterations.push(
    performanceIterationFromCampaign({
      sourceCommit,
      releaseId,
      schemaFingerprint,
      runtimeVersion,
      scenario: POST_BETA_SCENARIO,
      iteration: attempt,
      correlationId: context.correlationId,
      startedAt,
      completedAt: new Date().toISOString(),
      productWallClockMs,
      campaignMetrics: context.metrics.snapshot(productWallClockMs),
      campaignReportRef: path.relative(outputDirectory, rawFile),
      verdict,
      ...(failureReasonCode ? { failureReasonCode } : {}),
    }),
  );
  if (verdict === "pass") cleanIterations += 1;
  process.stdout.write(
    `${JSON.stringify({ attempt, verdict, correlationId: context.correlationId })}\n`,
  );
  await closeCampaignContext(context);
}

const benchmark = summarizePerformanceBenchmark({
  iterations,
  requestedIterations,
  agentIterations,
  ...(!agentIterations.length
    ? { agentCohort: { status: "incomplete" as const, reasonCode: "DEEPSEEK_COHORT_PENDING" } }
    : {}),
});
const file = await retainPerformanceBenchmark({
  directory: outputDirectory,
  name: process.env.SCRY_PERFORMANCE_BENCHMARK_NAME ?? `baseline-${sourceCommit.slice(0, 12)}`,
  benchmark,
});
process.stdout.write(
  `${JSON.stringify({
    status: benchmark.cohort.status,
    cleanIterations: benchmark.cohort.cleanIterations,
    agentStatus: benchmark.agentCohort.status,
    productWallClockMs: benchmark.productWallClockMs,
    rankedBottlenecks: benchmark.rankedBottlenecks,
    report: file,
  })}\n`,
);
if (benchmark.cohort.status !== "complete" || benchmark.agentCohort.status !== "complete")
  process.exitCode = 1;

function phaseFor(name: string) {
  if (name === "start_praxis_session") return "browser_startup";
  if (name === "observe_praxis_session") return "document_observation";
  if (name === "start_run") return "authoring";
  if (name === "dispatch_run_operation") return "interaction_execution";
  if (name === "finalize_run") return "evidence_finalization";
  if (name === "close_praxis_session") return "completion";
  return "mcp_round_trip";
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000)
    throw new Error("SCRY_PERFORMANCE_ITERATIONS_INVALID");
  return parsed;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.match(/\b[A-Z][A-Z0-9_]{5,}\b/)?.[0] ?? "PERFORMANCE_BENCHMARK_FAILED";
}

async function readAgentIterations(file: string | undefined): Promise<PerformanceAgentIteration[]> {
  if (!file) return [];
  const resolved = path.resolve(repositoryRoot, file);
  return performanceAgentIterationSchema
    .array()
    .parse(JSON.parse(await readFile(resolved, "utf8")));
}
