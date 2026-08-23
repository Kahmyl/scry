import { z } from "zod";

import { flowRevisionContentSchema, nameSchema, uuidSchema } from "./api.js";
import { currentPlanSchema } from "./current.js";
import { operationOutcomeSchema } from "./execution-kernel.js";
import { missionAuthoringIntentSchema } from "./authoring.js";
import { flowPurposeSchema, flowVisibilitySchema, objectiveContextSchema } from "./mission.js";
import { outcomeClassificationSchema } from "./run.js";
import { mutationReceiptSchema } from "./protected-operation.js";

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
    executionModel: z.literal("agent_directed_v1").default("agent_directed_v1"),
    praxisSessionId: uuidSchema,
    protectedAuthorizations: z
      .array(
        z
          .object({ operationId: z.string().trim().min(1).max(200), authorizationId: uuidSchema })
          .strict(),
      )
      .max(100)
      .default([]),
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

const agentDirectedIntentSchema = z
  .object({
    ...missionAuthoringIntentSchema.shape,
    expectedEffect: missionAuthoringIntentSchema.shape.expectedEffect.default({ kind: "none" }),
  })
  .strict()
  .transform((value) => missionAuthoringIntentSchema.parse(value));

export const dispatchRunOperationBaseSchema = z
  .object({
    praxisSessionId: uuidSchema,
    intent: agentDirectedIntentSchema,
  })
  .strict();

export const dispatchRunOperationSchema = dispatchRunOperationBaseSchema.superRefine(
  (value, context) => {
    const references: Array<string | undefined> = [];
    const action = value.intent.action;
    if ("target" in action && action.target) references.push(action.target.reference);
    if (action.kind === "acquire_protected_outputs") {
      references.push(action.mutation.target.reference);
      references.push(
        ...(action.syntheticProtectedInputs ?? []).map((input) => input.target.reference),
      );
    }
    if (references.some((reference) => !reference))
      context.addIssue({
        code: "custom",
        path: ["intent", "action"],
        message: "Every pre-dispatch Run target requires an exact live Praxis reference",
      });
  },
);

export const attachRunPraxisSessionSchema = z
  .object({ praxisSessionId: uuidSchema, idempotencyKey: idempotencyKeySchema })
  .strict();

export const finalizeAgentDirectedRunSchema = z
  .object({
    praxisSessionId: uuidSchema,
    outcome: z.enum(["passed", "failed", "cancelled"]),
    outcomeClassification: z
      .enum([
        "assertion_failure",
        "readiness_timeout",
        "transient_observation",
        "inconclusive_plan",
        "confirmed_product_failure",
        "non_reproduced_failure",
        "infrastructure_failure",
        "policy_failure",
        "execution_timeout",
      ])
      .optional(),
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const dispatchedRunOperationResultSchema = z
  .object({
    runId: uuidSchema,
    praxisSessionId: uuidSchema,
    operationId: z.string().trim().min(1).max(200),
    artifactRefs: z.array(uuidSchema),
    intentId: z.string().trim().min(1).max(200),
    functionalResult: z.enum(["succeeded", "failed", "inconclusive"]),
    mutationOutcome: z.enum(["not_applied", "applied", "unknown"]),
    privacyApplicable: z.boolean(),
    privacyResult: z.enum(["verified", "unverified", "degraded", "sealed"]),
    evidence: z
      .object({
        state: z.enum(["available", "suppressed", "quarantined", "failed"]),
        count: z.number().int().nonnegative(),
        reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(8),
      })
      .strict(),
    successorObservation: z
      .object({
        documentEpoch: z.number().int().nonnegative(),
        url: z.string().url(),
        semanticPageContext: operationOutcomeSchema.shape.semanticPageContext.unwrap(),
      })
      .strict()
      .superRefine((observation, context) => {
        if (
          observation.documentEpoch !== observation.semanticPageContext.authority.documentEpoch ||
          observation.url !== observation.semanticPageContext.authority.url
        )
          context.addIssue({
            code: "custom",
            message: "successor observation authority must match its semantic page context",
          });
      })
      .optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    mutationReceipt: mutationReceiptSchema.optional(),
    replayed: z.boolean(),
  })
  .strict();

export const finalizedAgentDirectedRunResultSchema = z
  .object({
    runId: uuidSchema,
    state: z.enum(["passed", "failed", "cancelled"]),
    outcomeClassification: outcomeClassificationSchema,
    reason: finalizeAgentDirectedRunSchema.shape.reason,
  })
  .strict();

export const runPraxisAttachmentResultSchema = z
  .object({
    runId: uuidSchema,
    praxisSessionId: uuidSchema,
    epoch: z.number().int().positive().optional(),
    replayed: z.boolean(),
  })
  .strict();

export type DispatchRunOperationInput = z.infer<typeof dispatchRunOperationSchema>;
export type AttachRunPraxisSessionInput = z.infer<typeof attachRunPraxisSessionSchema>;
export type FinalizeAgentDirectedRunInput = z.infer<typeof finalizeAgentDirectedRunSchema>;
export type DispatchedRunOperationResult = z.infer<typeof dispatchedRunOperationResultSchema>;
export type FinalizedAgentDirectedRunResult = z.infer<typeof finalizedAgentDirectedRunResultSchema>;
