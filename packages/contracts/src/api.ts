import { z } from "zod";

import { executionPolicySchema } from "./policy.js";

export const uuidSchema = z.string().uuid();
export const nameSchema = z.string().trim().min(1).max(200);

export const createProjectSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(2_000).default(""),
  })
  .strict();

export const createEnvironmentSchema = z
  .object({
    missionId: uuidSchema,
    objectiveId: uuidSchema,
    agentSessionId: uuidSchema,
    name: nameSchema,
    baseOrigin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          value === url.origin
        );
      }, "baseOrigin must be a canonical HTTP(S) origin without a trailing slash"),
    policy: executionPolicySchema,
    secretRefs: z.array(uuidSchema).max(100).default([]),
  })
  .strict();

export const updateEnvironmentSchema = createEnvironmentSchema.omit({ name: true });
export const validateCredentialReferencesSchema = z.object({
  projectId: uuidSchema,
  secretRefs: z.array(uuidSchema).max(100),
}).strict();

export const createCredentialSchema = z
  .object({
    missionId: uuidSchema,
    objectiveId: uuidSchema,
    agentSessionId: uuidSchema,
    name: nameSchema,
    value: z.string().min(1).max(20_000),
  })
  .strict();

export const updateCredentialSchema = createCredentialSchema;

export const flowRevisionContentSchema = z
  .object({
    objective: z.string().trim().min(1).max(2_000),
    preconditions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
    expectedOutcomes: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
    prohibitedSideEffects: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentSchema>;
export type ValidateCredentialReferencesInput = z.infer<typeof validateCredentialReferencesSchema>;
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type FlowRevisionContent = z.infer<typeof flowRevisionContentSchema>;
