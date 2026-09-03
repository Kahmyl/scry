import { z } from "zod";

import { flowRevisionContentSchema, uuidSchema } from "./api.js";
import { currentPlanSchema } from "./current.js";
import {
  agentProviderSchema,
  externalAgentExperimentIdSchema,
  externalAgentModelSchema,
  externalAgentRunIdSchema,
  missionDistinctWorkAuthoritySchema,
  objectiveCriterionSchema,
} from "./mission.js";
import { flowDraftPurposeSchema } from "./authoring.js";
import { missionAuthoringTurnBudgetsSchema } from "./adaptive-session.js";

const createPreparationSchema = z
  .object({
    kind: z.literal("create"),
    projectId: uuidSchema,
    environmentId: uuidSchema,
    mission: z
      .object({
        title: z.string().trim().min(1).max(200),
        originalInstruction: z.string().trim().min(1).max(20_000),
        maxBusinessMutationDispatches: z.number().int().min(0).max(1000).optional(),
        provider: agentProviderSchema,
        model: externalAgentModelSchema.optional(),
        externalRunId: externalAgentRunIdSchema.optional(),
        experimentId: externalAgentExperimentIdSchema.optional(),
        instructionSnapshot: z.string().trim().min(1).max(20_000),
        connectionId: z.string().trim().min(1).max(500).optional(),
        distinctReason: z.string().trim().min(1).max(2_000).optional(),
        distinctAuthority: missionDistinctWorkAuthoritySchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.distinctReason && !value.distinctAuthority)
          context.addIssue({
            code: "custom",
            path: ["distinctAuthority"],
            message: "Distinct Mission preparation requires explicit current-user authority.",
          });
        if (!value.distinctReason && value.distinctAuthority)
          context.addIssue({
            code: "custom",
            path: ["distinctAuthority"],
            message: "Distinct authority requires a distinctReason.",
          });
      }),
    objective: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(""),
        dependencies: z.array(uuidSchema).max(0).default([]),
        completionCriteria: z.array(objectiveCriterionSchema).min(1).max(100),
        order: z.number().int().nonnegative(),
      })
      .strict(),
    draft: z
      .object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(""),
        purpose: flowDraftPurposeSchema.default("primary"),
        content: flowRevisionContentSchema,
        plan: currentPlanSchema,
      })
      .strict(),
    authoring: z
      .object({
        objective: z.string().trim().min(1).max(4_000),
        allowedOrigins: z.array(z.string().url()).min(1).max(20),
        turnBudgets: missionAuthoringTurnBudgetsSchema.default({
          maxOperations: 20,
          maxDurationMs: 60_000,
        }),
        initialProtectedReferenceIds: z.array(uuidSchema).max(20).default([]),
      })
      .strict(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  })
  .strict();

const reusePreparationSchema = z
  .object({
    kind: z.literal("reuse"),
    projectId: uuidSchema,
    authoringSessionId: uuidSchema,
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  })
  .strict();

export const prepareFlowAuthoringSchema = z.discriminatedUnion("kind", [
  createPreparationSchema,
  reusePreparationSchema,
]);

export const preparedFlowAuthoringSchema = z
  .object({
    replayed: z.boolean(),
    reused: z.boolean(),
    missionId: uuidSchema,
    agentSessionId: uuidSchema,
    objectiveId: uuidSchema,
    environmentId: uuidSchema,
    flowDraftId: uuidSchema,
    authoringSessionId: uuidSchema,
    authoringReady: z.literal(true),
    continuation: z.object({ nextSafeCapability: z.literal("advance_flow_authoring") }).strict(),
  })
  .strict();

export type PrepareFlowAuthoringInput = z.infer<typeof prepareFlowAuthoringSchema>;
export type PreparedFlowAuthoring = z.infer<typeof preparedFlowAuthoringSchema>;
