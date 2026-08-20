import { z } from "zod";

import { executionPolicySchema } from "./policy.js";

const environmentExecutionPolicyInputSchema = executionPolicySchema.omit({
  externalResourcePresentationAuthorities: true,
});

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
        return ["http:", "https:"].includes(url.protocol) && value === url.origin;
      }, "baseOrigin must be a canonical HTTP(S) origin without a trailing slash"),
    policy: environmentExecutionPolicyInputSchema,
    secretRefs: z.array(uuidSchema).max(100).default([]),
  })
  .strict();

export const updateEnvironmentSchema = createEnvironmentSchema
  .omit({ name: true })
  .extend({
    missionCredentialSelectionRefs: z.array(uuidSchema).max(100).optional(),
  })
  .superRefine((input, context) => {
    const environmentReferences = new Set(input.secretRefs);
    for (const [index, reference] of (input.missionCredentialSelectionRefs ?? []).entries()) {
      if (!environmentReferences.has(reference))
        context.addIssue({
          code: "custom",
          path: ["missionCredentialSelectionRefs", index],
          message: "Mission-selected credential references must also be environment-authorized.",
        });
    }
  });
export const validateCredentialReferencesSchema = z
  .object({
    projectId: uuidSchema,
    secretRefs: z.array(uuidSchema).max(100),
  })
  .strict();

export const listCredentialsSchema = z
  .object({
    referenceId: uuidSchema.optional(),
    missionId: uuidSchema.optional(),
  })
  .strict();

export const createCredentialSchema = z
  .object({
    missionId: uuidSchema.optional(),
    objectiveId: uuidSchema.optional(),
    agentSessionId: uuidSchema.optional(),
    name: nameSchema,
    value: z.string().min(1).max(20_000),
  })
  .strict()
  .refine((input) => {
    const count = [input.missionId, input.objectiveId, input.agentSessionId].filter(
      (value) => value !== undefined,
    ).length;
    return count === 0 || count === 3;
  }, "Mission provenance must be omitted or supplied as one complete context");

export const updateCredentialSchema = z
  .object({
    missionId: uuidSchema.optional(),
    objectiveId: uuidSchema.optional(),
    agentSessionId: uuidSchema.optional(),
    name: nameSchema,
    value: z.string().min(1).max(20_000),
  })
  .strict()
  .refine((input) => {
    const count = [input.missionId, input.objectiveId, input.agentSessionId].filter(
      (value) => value !== undefined,
    ).length;
    return count === 0 || count === 3;
  }, "Deprecated Mission provenance must be omitted or supplied as one complete context");

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
export type ListCredentialsInput = z.infer<typeof listCredentialsSchema>;
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type FlowRevisionContent = z.infer<typeof flowRevisionContentSchema>;
