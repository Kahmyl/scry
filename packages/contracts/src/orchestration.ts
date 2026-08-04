import { z } from "zod";
import { uuidSchema } from "./api.js";
import { missionContextSchema } from "./mission.js";

export const orchestrationStateSchema = z.enum([
  "unscheduled",
  "ready",
  "queued",
  "running",
  "awaiting_evidence",
  "passed",
  "failed",
  "blocked",
  "awaiting_authorization",
  "cancelled",
]);
export const executionPlanStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "superseded",
  "cancelled",
]);
export const executionModeSchema = z.enum(["automatic", "manual"]);
export const executionBindingSchema = z
  .object({
    objectiveId: uuidSchema,
    mode: executionModeSchema,
    flowRevisionId: uuidSchema.optional(),
    compiledContractId: uuidSchema.optional(),
    environmentId: uuidSchema.optional(),
    authorizationIds: z.array(uuidSchema).max(100).default([]),
    browser: z.string().min(1).default("chromium"),
    viewport: z
      .object({
        width: z.number().int().min(320).max(7680),
        height: z.number().int().min(240).max(4320),
      })
      .default({ width: 1440, height: 900 }),
    seed: z.number().int().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === "automatic" && (!v.flowRevisionId || !v.compiledContractId || !v.environmentId))
      c.addIssue({
        code: "custom",
        message:
          "Automated objectives require an immutable Flow revision, execution-ready compiled contract, and environment",
      });
  });
export const authorizationKindSchema = z.enum([
  "live_read",
  "live_mutation",
  "protected_mutation",
  "authentication_calibration",
]);
export const grantMissionAuthorizationSchema = missionContextSchema
  .extend({
    objectiveId: uuidSchema,
    environmentId: uuidSchema,
    kind: authorizationKindSchema,
    reason: z.string().trim().min(1).max(2000),
    expiresAt: z.string().datetime().optional(),
    confirmedUserAuthorized: z.literal(true),
  })
  .strict();
export type GrantMissionAuthorizationInput = z.infer<typeof grantMissionAuthorizationSchema>;
export const createExecutionPlanSchema = missionContextSchema
  .extend({
    bindings: z.array(executionBindingSchema).min(1).max(500),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();
export const activateExecutionPlanSchema = missionContextSchema
  .extend({ planRevision: z.number().int().positive() })
  .strict();
export const orchestrationControlSchema = missionContextSchema
  .extend({ reason: z.string().trim().min(1).max(2000) })
  .strict();
export const startReadyObjectivesSchema = missionContextSchema
  .extend({ objectiveIds: z.array(uuidSchema).max(500).optional() })
  .strict();
export const editReportDraftSchema = missionContextSchema
  .extend({
    draftId: uuidSchema,
    overallConclusion: z.string().trim().min(1).max(20000),
    journeySummary: z.array(z.string().trim().min(1).max(2000)).min(1).max(500),
    remainingActions: z.array(z.string().trim().min(1).max(2000)).max(100),
  })
  .strict();
export type CreateExecutionPlanInput = z.infer<typeof createExecutionPlanSchema>;
export type ActivateExecutionPlanInput = z.infer<typeof activateExecutionPlanSchema>;
export type OrchestrationControlInput = z.infer<typeof orchestrationControlSchema>;
export type StartReadyObjectivesInput = z.infer<typeof startReadyObjectivesSchema>;
export type EditReportDraftInput = z.infer<typeof editReportDraftSchema>;
