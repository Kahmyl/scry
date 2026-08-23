import { z } from "zod";

import { campaignMetricsSchema } from "./campaign.js";

export const performanceStageSchema = z.enum([
  "discovery",
  "readiness",
  "observation",
  "authoring",
  "authorization",
  "dispatch",
  "acquisition",
  "persistence",
  "reconciliation",
  "evidence",
  "completion",
  "publication",
]);

export const performanceDurationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("measured"),
      durationMs: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("not_applicable"),
      reasonCode: z.string().trim().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reasonCode: z.string().trim().min(1).max(160),
    })
    .strict(),
]);

export const performanceStageTimingsSchema = z
  .object(
    Object.fromEntries(
      performanceStageSchema.options.map((stage) => [stage, performanceDurationSchema]),
    ) as Record<z.infer<typeof performanceStageSchema>, typeof performanceDurationSchema>,
  )
  .strict();

export const performanceCountersSchema = z
  .object({
    mcpCalls: z.number().int().nonnegative(),
    apiCalls: z.number().int().nonnegative(),
    agentTurns: z.number().int().nonnegative(),
    decisionBoundaries: z.number().int().nonnegative(),
    invalidCalls: z.number().int().nonnegative(),
    staleReferenceCalls: z.number().int().nonnegative(),
    unchangedReads: z.number().int().nonnegative(),
    browserLaunches: z.number().int().nonnegative(),
    browserRestarts: z.number().int().nonnegative(),
    browserReacquisitions: z.number().int().nonnegative(),
    reconciliationWaits: z.number().int().nonnegative(),
    evidenceFinalizations: z.number().int().nonnegative(),
    bytesReturned: z.number().int().nonnegative(),
  })
  .strict();

export const performanceScenarioSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    version: z.number().int().positive(),
  })
  .strict();

export const performanceIterationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("scry.performance.iteration"),
    sourceCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/),
    releaseId: z.string().trim().min(1).max(200),
    schemaFingerprint: z.string().trim().min(1).max(200),
    runtimeVersion: z.string().trim().min(1).max(200),
    scenario: performanceScenarioSchema,
    cohort: z.enum(["scripted_product", "agent"]),
    iteration: z.number().int().positive(),
    correlationId: z.string().uuid(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    productWallClockMs: z.number().nonnegative(),
    externalAgentWallClock: performanceDurationSchema,
    modelIdleOrReasoningWait: performanceDurationSchema,
    stages: performanceStageTimingsSchema,
    counters: performanceCountersSchema,
    campaignMetrics: campaignMetricsSchema,
    campaignReportRef: z.string().trim().min(1).max(1_000),
    verdict: z.enum(["pass", "fail"]),
    failureReasonCode: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const performanceDistributionSchema = z
  .object({
    count: z.number().int().nonnegative(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative(),
  })
  .strict();

export const performanceBottleneckSchema = z
  .object({
    stage: performanceStageSchema,
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    p50ProductShare: z.number().nonnegative(),
  })
  .strict();

export const performanceCohortSummarySchema = z
  .object({
    status: z.enum(["complete", "incomplete", "unavailable"]),
    requestedIterations: z.number().int().positive(),
    cleanIterations: z.number().int().nonnegative(),
    reasonCode: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const performanceAgentIterationSchema = z
  .object({
    iteration: z.number().int().positive(),
    sourceCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/),
    scenario: performanceScenarioSchema,
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    durationMs: z.number().nonnegative(),
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    invalidCalls: z.number().int().nonnegative(),
    staleReferenceCalls: z.number().int().nonnegative(),
    repeatedUnchangedObservations: z.number().int().nonnegative(),
    unnecessaryCapabilitiesCalls: z.number().int().nonnegative(),
    completed: z.boolean(),
    scenarioCompleted: z.boolean(),
    status: z.enum(["completed", "failed", "limit_exceeded"]),
    resultRef: z.string().trim().min(1).max(1_000),
    oracleRef: z.string().trim().min(1).max(1_000),
    failure: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();

export const performanceBenchmarkSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("scry.performance.benchmark"),
    generatedAt: z.string().datetime(),
    sourceCommit: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{40}$/),
    releaseId: z.string().trim().min(1).max(200),
    schemaFingerprint: z.string().trim().min(1).max(200),
    runtimeVersion: z.string().trim().min(1).max(200),
    scenario: performanceScenarioSchema,
    cohort: performanceCohortSummarySchema,
    agentCohort: performanceCohortSummarySchema,
    agentWallClockMs: performanceDistributionSchema,
    agentCounters: z.record(z.string(), performanceDistributionSchema),
    agentIterations: z.array(performanceAgentIterationSchema).max(100),
    productWallClockMs: performanceDistributionSchema,
    externalAgentWallClockMs: performanceDistributionSchema,
    stagesMs: z.record(performanceStageSchema, performanceDistributionSchema),
    counters: z.record(z.string(), performanceDistributionSchema),
    rankedBottlenecks: z.array(performanceBottleneckSchema).max(12),
    stageTimingSemantics: z.literal("overlapping_factual_spans_not_additive"),
    iterations: z.array(performanceIterationSchema).min(1).max(1_000),
  })
  .strict();

export type PerformanceStage = z.infer<typeof performanceStageSchema>;
export type PerformanceDuration = z.infer<typeof performanceDurationSchema>;
export type PerformanceCounters = z.infer<typeof performanceCountersSchema>;
export type PerformanceIteration = z.infer<typeof performanceIterationSchema>;
export type PerformanceAgentIteration = z.infer<typeof performanceAgentIterationSchema>;
export type PerformanceBenchmark = z.infer<typeof performanceBenchmarkSchema>;
