import { z } from "zod";

import { uuidSchema } from "./api.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const createQualificationCampaignSchema = z
  .object({
    environmentId: uuidSchema,
    missionId: uuidSchema,
    objectiveId: uuidSchema,
    agentSessionId: uuidSchema,
    purpose: z.literal("system_correctness"),
    targetOrigin: z
      .string()
      .url()
      .transform((value) => new URL(value).origin),
    applicationIdentity: z.string().trim().min(1).max(200),
    qualificationMode: z.literal("local_test"),
    releaseIdentity: digestSchema,
    schemaIdentity: digestSchema,
    maxRuns: z.literal(1).default(1),
    maxBusinessMutationDispatches: z.literal(1).default(1),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const qualificationCampaignSchema = createQualificationCampaignSchema
  .extend({
    id: uuidSchema,
    projectId: uuidSchema,
    ownerUserId: uuidSchema,
    runsConsumed: z.number().int().min(0).max(1),
    businessMutationDispatchesConsumed: z.number().int().min(0).max(1),
    disposition: z.enum([
      "authorized",
      "succeeded",
      "failed",
      "inconclusive",
      "expired",
      "revoked",
    ]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    terminalAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type CreateQualificationCampaignInput = z.infer<typeof createQualificationCampaignSchema>;
export type QualificationCampaign = z.infer<typeof qualificationCampaignSchema>;
