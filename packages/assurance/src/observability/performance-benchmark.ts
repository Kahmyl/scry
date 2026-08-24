import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  performanceBenchmarkSchema,
  performanceAgentIterationSchema,
  performanceIterationSchema,
  performanceStageSchema,
  type CampaignMetrics,
  type PerformanceBenchmark,
  type PerformanceAgentIteration,
  type PerformanceCounters,
  type PerformanceDuration,
  type PerformanceIteration,
  type PerformanceStage,
} from "@scry/contracts";

import type { AgentLabRunResult } from "../agent-lab/types.js";

const STAGE_PHASES: Record<PerformanceStage, readonly string[]> = {
  discovery: ["api"],
  readiness: ["readiness"],
  observation: ["document_observation", "native_resolution"],
  authoring: ["mcp_session_start_round_trip", "mcp_round_trip"],
  authorization: ["authorization"],
  dispatch: ["interaction_execution"],
  acquisition: ["browser_startup"],
  persistence: ["persistence"],
  reconciliation: ["expected_effect_verification"],
  evidence: ["evidence_finalization", "artifact_retrieval"],
  completion: ["completion"],
  publication: ["publication"],
};

export function performanceIterationFromCampaign(input: {
  sourceCommit: string;
  releaseId: string;
  schemaFingerprint: string;
  runtimeVersion: string;
  scenario: { id: string; version: number };
  iteration: number;
  correlationId: string;
  startedAt: string;
  completedAt: string;
  productWallClockMs: number;
  campaignMetrics: CampaignMetrics;
  campaignReportRef: string;
  verdict: "pass" | "fail";
  failureReasonCode?: string;
}): PerformanceIteration {
  const sessionStarts = input.campaignMetrics.measurements.filter(
    (measurement) => measurement.metric === "phase:mcp_session_start_round_trip",
  ).length;
  return performanceIterationSchema.parse({
    schemaVersion: 1,
    kind: "scry.performance.iteration",
    sourceCommit: input.sourceCommit,
    releaseId: input.releaseId,
    schemaFingerprint: input.schemaFingerprint,
    runtimeVersion: input.runtimeVersion,
    scenario: input.scenario,
    cohort: "scripted_product",
    iteration: input.iteration,
    correlationId: input.correlationId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    productWallClockMs: input.productWallClockMs,
    externalAgentWallClock: measured(input.productWallClockMs),
    modelIdleOrReasoningWait: {
      status: "not_applicable",
      reasonCode: "SCRIPTED_CLIENT_NO_MODEL",
    },
    stages: Object.fromEntries(
      performanceStageSchema.options.map((stage) => [
        stage,
        stageDuration(stage, input.campaignMetrics),
      ]),
    ),
    counters: {
      mcpCalls: input.campaignMetrics.mcpRequests + sessionStarts,
      apiCalls: input.campaignMetrics.apiRequests,
      agentTurns: 0,
      decisionBoundaries: input.campaignMetrics.agentDecisionBoundaries,
      invalidCalls: input.campaignMetrics.invalidCalls,
      staleReferenceCalls: input.campaignMetrics.staleReferenceCalls,
      unchangedReads: input.campaignMetrics.unchangedStateReads,
      browserLaunches: input.campaignMetrics.browserLaunches,
      browserRestarts: input.campaignMetrics.browserRestarts,
      browserReacquisitions: input.campaignMetrics.browserReacquisitions,
      reconciliationWaits: input.campaignMetrics.reconciliationWaits,
      evidenceFinalizations: input.campaignMetrics.evidenceFinalizations,
      bytesReturned: input.campaignMetrics.bytesReturnedToAgent,
    },
    campaignMetrics: input.campaignMetrics,
    campaignReportRef: input.campaignReportRef,
    verdict: input.verdict,
    ...(input.failureReasonCode ? { failureReasonCode: input.failureReasonCode } : {}),
  });
}

export function summarizePerformanceBenchmark(input: {
  iterations: readonly PerformanceIteration[];
  requestedIterations: number;
  agentIterations?: readonly PerformanceAgentIteration[];
  agentCohort?: { status: "complete" | "incomplete" | "unavailable"; reasonCode?: string };
}): PerformanceBenchmark {
  const parsed = input.iterations.map((iteration) => performanceIterationSchema.parse(iteration));
  if (!parsed.length) throw new Error("PERFORMANCE_ITERATIONS_REQUIRED");
  assertComparable(parsed);
  const clean = parsed.filter((iteration) => iteration.verdict === "pass");
  const first = parsed[0]!;
  const productWallClockMs = distribution(clean.map((iteration) => iteration.productWallClockMs));
  const externalAgentWallClockMs = distribution(
    clean.flatMap((iteration) =>
      iteration.externalAgentWallClock.status === "measured"
        ? [iteration.externalAgentWallClock.durationMs]
        : [],
    ),
  );
  const stagesMs = Object.fromEntries(
    performanceStageSchema.options.map((stage) => [
      stage,
      distribution(
        clean.flatMap((iteration) => {
          const timing = iteration.stages[stage];
          return timing.status === "measured" ? [timing.durationMs] : [];
        }),
      ),
    ]),
  );
  const counterNames = Object.keys(first.counters) as (keyof PerformanceCounters)[];
  const counters = Object.fromEntries(
    counterNames.map((counter) => [
      counter,
      distribution(clean.map((iteration) => iteration.counters[counter])),
    ]),
  );
  const rankedBottlenecks = performanceStageSchema.options
    .map((stage) => ({ stage, timing: stagesMs[stage]! }))
    .filter(({ timing }) => timing.count > 0)
    .sort((left, right) => right.timing.p50 - left.timing.p50)
    .map(({ stage, timing }) => ({
      stage,
      p50Ms: timing.p50,
      p95Ms: timing.p95,
      p50ProductShare: productWallClockMs.p50 > 0 ? timing.p50 / productWallClockMs.p50 : 0,
    }));
  const agentIterations = (input.agentIterations ?? []).map((iteration) =>
    performanceAgentIterationSchema.parse(iteration),
  );
  assertComparableAgentIterations(agentIterations, first);
  const cleanAgentIterations = agentIterations.filter(isCleanAgentIteration);
  const agentCohort = agentIterations.length
    ? {
        status: cleanAgentIterations.length >= 3 ? ("complete" as const) : ("incomplete" as const),
        ...(cleanAgentIterations.length >= 3
          ? {}
          : { reasonCode: "CLEAN_AGENT_ITERATION_TARGET_NOT_MET" }),
      }
    : (input.agentCohort ?? {
        status: "unavailable" as const,
        reasonCode: "AGENT_RESULTS_NOT_SUPPLIED",
      });
  const agentCounters = Object.fromEntries(
    [
      "turns",
      "toolCalls",
      "invalidCalls",
      "staleReferenceCalls",
      "repeatedUnchangedObservations",
      "unnecessaryCapabilitiesCalls",
    ].map((counter) => [
      counter,
      distribution(
        cleanAgentIterations.map(
          (iteration) => iteration[counter as keyof PerformanceAgentIteration] as number,
        ),
      ),
    ]),
  );
  return performanceBenchmarkSchema.parse({
    schemaVersion: 1,
    kind: "scry.performance.benchmark",
    generatedAt: new Date().toISOString(),
    sourceCommit: first.sourceCommit,
    releaseId: first.releaseId,
    schemaFingerprint: first.schemaFingerprint,
    runtimeVersion: first.runtimeVersion,
    scenario: first.scenario,
    cohort: {
      status: clean.length >= input.requestedIterations ? "complete" : "incomplete",
      requestedIterations: input.requestedIterations,
      cleanIterations: clean.length,
      ...(clean.length >= input.requestedIterations
        ? {}
        : { reasonCode: "CLEAN_ITERATION_TARGET_NOT_MET" }),
    },
    agentCohort: {
      ...agentCohort,
      requestedIterations: 3,
      cleanIterations: cleanAgentIterations.length,
    },
    agentWallClockMs: distribution(cleanAgentIterations.map((iteration) => iteration.durationMs)),
    agentCounters,
    agentIterations,
    productWallClockMs,
    externalAgentWallClockMs,
    stagesMs,
    counters,
    rankedBottlenecks,
    stageTimingSemantics: "overlapping_factual_spans_not_additive",
    iterations: parsed,
  });
}

export function performanceAgentIterationFromResult(input: {
  iteration: number;
  sourceCommit: string;
  scenario: { id: string; version: number };
  resultRef: string;
  oracleRef: string;
  scenarioCompleted: boolean;
  result: AgentLabRunResult;
}): PerformanceAgentIteration {
  return performanceAgentIterationSchema.parse({
    iteration: input.iteration,
    sourceCommit: input.sourceCommit,
    scenario: input.scenario,
    provider: input.result.provider,
    model: input.result.model,
    durationMs: input.result.duration_ms,
    turns: input.result.turns,
    toolCalls: input.result.tool_calls,
    invalidCalls: input.result.invalid_calls,
    staleReferenceCalls: input.result.stale_reference_calls,
    repeatedUnchangedObservations: input.result.repeated_unchanged_observations,
    unnecessaryCapabilitiesCalls: input.result.unnecessary_capabilities_calls,
    completed: input.result.completed,
    scenarioCompleted: input.scenarioCompleted,
    status: input.result.status,
    ...(input.result.terminal_outcome ? { terminalOutcome: input.result.terminal_outcome } : {}),
    resultRef: input.resultRef,
    oracleRef: input.oracleRef,
    ...(input.result.failure ? { failure: input.result.failure } : {}),
  });
}

export async function retainPerformanceBenchmark(input: {
  directory: string;
  name: string;
  benchmark: PerformanceBenchmark;
}): Promise<string> {
  const benchmark = performanceBenchmarkSchema.parse(input.benchmark);
  await mkdir(input.directory, { recursive: true });
  const file = path.join(input.directory, `${safeName(input.name)}.json`);
  await writeFile(file, `${JSON.stringify(benchmark, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readPerformanceBenchmark(file: string): Promise<PerformanceBenchmark> {
  return performanceBenchmarkSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

function stageDuration(stage: PerformanceStage, metrics: CampaignMetrics): PerformanceDuration {
  const phases = new Set(STAGE_PHASES[stage]);
  const values = metrics.measurements
    .filter(
      (measurement) =>
        measurement.metric.startsWith("phase:") &&
        phases.has(measurement.metric.slice("phase:".length)),
    )
    .map((measurement) => measurement.value);
  if (values.length) return measured(values.reduce((sum, value) => sum + value, 0));
  if (stage === "authorization") {
    return { status: "not_applicable", reasonCode: "NO_ONE_WAY_MUTATION_IN_SCENARIO" };
  }
  return { status: "unavailable", reasonCode: "STAGE_SPAN_NOT_EMITTED" };
}

function measured(durationMs: number): PerformanceDuration {
  return { status: "measured", durationMs: Math.max(0, durationMs) };
}

function distribution(input: readonly number[]) {
  const values = [...input].sort((left, right) => left - right);
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.at(-1) ?? 0,
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1)] ?? 0;
}

function assertComparable(iterations: readonly PerformanceIteration[]) {
  const first = iterations[0]!;
  for (const iteration of iterations.slice(1)) {
    if (
      iteration.sourceCommit !== first.sourceCommit ||
      iteration.releaseId !== first.releaseId ||
      iteration.schemaFingerprint !== first.schemaFingerprint ||
      iteration.runtimeVersion !== first.runtimeVersion ||
      iteration.scenario.id !== first.scenario.id ||
      iteration.scenario.version !== first.scenario.version ||
      iteration.cohort !== first.cohort
    ) {
      throw new Error("PERFORMANCE_ITERATIONS_NOT_COMPARABLE");
    }
  }
}

function assertComparableAgentIterations(
  iterations: readonly PerformanceAgentIteration[],
  product: PerformanceIteration,
) {
  for (const iteration of iterations) {
    if (
      iteration.sourceCommit !== product.sourceCommit ||
      iteration.scenario.id !== product.scenario.id ||
      iteration.scenario.version !== product.scenario.version ||
      iteration.provider !== "deepseek"
    ) {
      throw new Error("PERFORMANCE_AGENT_ITERATIONS_NOT_COMPARABLE");
    }
  }
}

function isCleanAgentIteration(iteration: PerformanceAgentIteration) {
  return (
    (iteration.status === "completed" || iteration.status === "stopped") &&
    iteration.scenarioCompleted &&
    iteration.invalidCalls === 0 &&
    iteration.staleReferenceCalls === 0 &&
    iteration.repeatedUnchangedObservations === 0 &&
    iteration.unnecessaryCapabilitiesCalls === 0
  );
}

function safeName(input: string) {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!value) throw new Error("PERFORMANCE_REPORT_NAME_REQUIRED");
  return value;
}
