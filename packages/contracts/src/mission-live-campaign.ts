import { z } from "zod";

const uuid = z.string().uuid();
const phaseDistribution = z
  .object({
    count: z.number().int().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
    slowestOperationIds: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict();

export const missionLiveCampaignCheckSchema = z
  .object({
    id: z.string().min(1).max(160),
    description: z.string().min(1).max(1_000),
    status: z.enum(["passed", "failed", "blocked"]),
    reasonCode: z.string().min(1).max(160).optional(),
    safeDetail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const missionLiveCampaignResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    releaseId: z.string().min(1).max(200),
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeVersion: z.string().min(1).max(200),
    runtimeConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    milestone: z.enum(["M1", "M2", "M3", "M4", "M5", "M6", "M7"]),
    target: z.string().min(1).max(200),
    repetition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    missionId: uuid,
    objectiveIds: z.array(uuid).min(1),
    flowIds: z.array(uuid).min(1),
    runIds: z.array(uuid),
    correlationId: uuid,
    boundaryUnderTest: z.string().min(1).max(1_000),
    requiredChecks: z.array(missionLiveCampaignCheckSchema).min(1),
    observationalFindings: z.array(missionLiveCampaignCheckSchema),
    cleanup: z
      .object({
        required: z.boolean(),
        state: z.enum(["not_required", "completed", "failed"]),
        refs: z.array(z.string().min(1).max(500)),
      })
      .strict(),
    calls: z
      .object({
        mcp: z.number().int().nonnegative(),
        api: z.number().int().nonnegative(),
        repeatedStateReads: z.number().int().nonnegative(),
      })
      .strict(),
    resolution: z
      .object({
        nativeResolved: z.number().int().nonnegative(),
        praxisFallbacks: z.number().int().nonnegative(),
      })
      .strict(),
    reductions: z
      .object({
        decisionBoundary: z.number().min(0).max(1),
        mcpCalls: z.number().min(0).max(1),
        agentBytes: z.number().min(0).max(1),
      })
      .strict(),
    timings: z.record(z.string(), phaseDistribution),
    privacyScan: z
      .object({
        checkedByteCount: z.number().int().nonnegative(),
        leakedCanaryCount: z.literal(0),
      })
      .strict(),
    evidenceRefs: z.array(z.string().min(1).max(1_000)),
    verdict: z.enum(["pass", "fail", "blocked"]),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.verdict === "pass" &&
      result.requiredChecks.some((check) => check.status !== "passed")
    )
      context.addIssue({
        code: "custom",
        path: ["requiredChecks"],
        message: "Every required check must pass",
      });
    if (
      result.verdict === "pass" &&
      result.cleanup.required &&
      result.cleanup.state !== "completed"
    )
      context.addIssue({
        code: "custom",
        path: ["cleanup"],
        message: "Required cleanup must complete",
      });
    for (const phase of [
      "browser_startup",
      "document_observation",
      "native_resolution",
      "interaction_execution",
      "expected_effect_verification",
      "evidence_finalization",
      "artifact_retrieval",
    ])
      if (result.verdict === "pass" && !result.timings[phase]?.count)
        context.addIssue({
          code: "custom",
          path: ["timings", phase],
          message: "Required timing phase missing",
        });
  });

export type MissionLiveCampaignCheck = z.infer<typeof missionLiveCampaignCheckSchema>;
export type MissionLiveCampaignResult = z.infer<typeof missionLiveCampaignResultSchema>;
