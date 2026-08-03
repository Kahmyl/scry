import { z } from "zod";

import { flowRevisionContentSchema, nameSchema, uuidSchema } from "./api.js";
import { currentPlanSchema } from "./current.js";
import { flowPurposeSchema, flowVisibilitySchema, objectiveContextSchema } from "./mission.js";

export const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const createFlowSchema = objectiveContextSchema
  .extend({
    environmentId: uuidSchema,
    name: nameSchema,
    description: z.string().trim().max(2_000).default(""),
    content: flowRevisionContentSchema,
    plan: currentPlanSchema,
    idempotencyKey: idempotencyKeySchema,
    visibility: flowVisibilitySchema.default("mission_local"),
    purpose: flowPurposeSchema.default("primary"),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const createFlowRevisionSchema = objectiveContextSchema
  .extend({
    environmentId: uuidSchema,
    expectedRevisionId: uuidSchema,
    name: nameSchema.optional(),
    description: z.string().trim().max(2_000).optional(),
    content: flowRevisionContentSchema,
    plan: currentPlanSchema,
    idempotencyKey: idempotencyKeySchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const validatePlanSchema = z
  .object({
    projectId: uuidSchema,
    environmentId: uuidSchema,
    plan: currentPlanSchema,
  })
  .strict();

export const createFlowRunSchema = objectiveContextSchema
  .extend({
    environmentId: uuidSchema,
    flowRevisionId: uuidSchema,
    compiledContractId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
    browser: z.literal("chromium").default("chromium"),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3_840),
        height: z.number().int().min(320).max(2_160),
      })
      .strict()
      .default({ width: 1280, height: 720 }),
    seed: z.number().int().min(0).max(4_294_967_295).default(1),
    role: z
      .enum([
        "exploratory",
        "diagnostic",
        "calibration",
        "candidate",
        "accepted",
        "superseded",
        "invalidated",
      ])
      .default("candidate"),
  })
  .strict();

export type CreateFlowInput = z.infer<typeof createFlowSchema>;
export type CreateFlowRevisionInput = z.infer<typeof createFlowRevisionSchema>;
export type ValidatePlanInput = z.infer<typeof validatePlanSchema>;
export type CreateFlowRunInput = z.infer<typeof createFlowRunSchema>;
