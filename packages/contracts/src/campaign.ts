import { z } from "zod";

export const adaptiveMilestoneSchema = z.enum(["M0", "M1", "M2", "M3", "M4", "M5"]);
export const campaignTargetSchema = z.enum([
  "production_shaped",
  "vitract_preview",
  "orangehrm",
  "expand_testing",
  "the_internet",
  "xyz_bank",
]);

export const campaignCheckSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
    status: z.enum(["passed", "failed", "awaiting_codex_verification"]),
    reasonCode: z.string().trim().min(1).max(160).optional(),
    safeDetail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const campaignDistributionSchema = z
  .object({
    count: z.number().int().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  })
  .strict();

export const campaignMeasurementSchema = z
  .object({
    metric: z.string().trim().min(1).max(120),
    operationId: z.string().trim().min(1).max(200),
    source: z.enum([
      "mcp_http",
      "api_http",
      "queue_event",
      "worker_event",
      "browser_event",
      "artifact_event",
      "praxis_result",
      "campaign_client",
      "control_plane_query",
    ]),
    correlationId: z.string().uuid(),
    eventId: z.string().trim().min(1).max(240),
    value: z.number().nonnegative(),
  })
  .strict();

export const campaignMetricsSchema = z
  .object({
    totalWallClockMs: z.number().nonnegative(),
    agentDecisionBoundaries: z.number().int().nonnegative(),
    mcpRequests: z.number().int().nonnegative(),
    apiRequests: z.number().int().nonnegative(),
    modelClientIdleMs: z.number().nonnegative(),
    bytesReturnedToAgent: z.number().int().nonnegative(),
    unchangedStateReads: z.number().int().nonnegative(),
    retriesByReason: z.record(z.string(), z.number().int().nonnegative()),
    phases: z.record(z.string(), campaignDistributionSchema),
    slowestOperations: z
      .array(
        z
          .object({
            operationId: z.string().trim().min(1).max(200),
            phase: z.string().trim().min(1).max(120),
            durationMs: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(20),
    measurements: z.array(campaignMeasurementSchema).max(100_000),
  })
  .strict();

export const milestoneCampaignResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignId: z.string().uuid(),
    correlationId: z.string().uuid(),
    milestone: adaptiveMilestoneSchema,
    target: campaignTargetSchema,
    releaseId: z.string().trim().min(1).max(200),
    schemaFingerprint: z.string().trim().min(1).max(200),
    runtimeVersion: z.string().trim().min(1).max(200),
    gitCommit: z.string().trim().min(1).max(200),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    requiredChecks: z.array(campaignCheckSchema),
    observationalChecks: z.array(campaignCheckSchema),
    futureScope: z.array(campaignCheckSchema),
    metrics: campaignMetricsSchema,
    artifactRefs: z.array(z.string().trim().min(1).max(1_000)),
    verdict: z.enum(["pass", "fail"]),
  })
  .strict();

export type AdaptiveMilestone = z.infer<typeof adaptiveMilestoneSchema>;
export type CampaignCheck = z.infer<typeof campaignCheckSchema>;
export type CampaignMetrics = z.infer<typeof campaignMetricsSchema>;
export type MilestoneCampaignResult = z.infer<typeof milestoneCampaignResultSchema>;
