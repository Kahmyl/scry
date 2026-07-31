import { z } from "zod";

import { executionPolicyV1Schema } from "./policy.js";
import { testPlanSchema } from "./plan.js";

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
    policy: executionPolicyV1Schema,
    secretRefs: z.array(uuidSchema).max(100).default([]),
  })
  .strict();

export const updateEnvironmentSchema = createEnvironmentSchema.omit({ name: true });
export const validateCredentialReferencesSchema = z.object({
  projectId: uuidSchema,
  secretRefs: z.array(uuidSchema).max(100),
}).strict();

export const createTestSpecificationSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(2_000).default(""),
  })
  .strict();

export const updateTestSpecificationSchema = createTestSpecificationSchema;

export const createCredentialSchema = z
  .object({
    name: nameSchema,
    value: z.string().min(1).max(20_000),
  })
  .strict();

export const updateCredentialSchema = createCredentialSchema;

export const createSpecificationVersionSchema = z
  .object({
    objective: z.string().trim().min(1).max(2_000),
    preconditions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
    expectedOutcomes: z.array(z.string().trim().min(1).max(2_000)).min(1).max(50),
    prohibitedSideEffects: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  })
  .strict();

export const createPlanVersionSchema = z
  .object({
    specificationVersionId: uuidSchema,
    plan: testPlanSchema,
  })
  .strict();

export const createAtomicRevisionSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().max(2_000).optional(),
    content: createSpecificationVersionSchema,
    plan: testPlanSchema,
  })
  .strict();

export const createRunSchema = z
  .object({
    environmentId: uuidSchema,
    planVersionId: uuidSchema,
    browser: z.literal("chromium").default("chromium"),
    viewport: z
      .object({
        width: z.number().int().min(320).max(3_840),
        height: z.number().int().min(320).max(2_160),
      })
      .strict()
      .default({ width: 1280, height: 720 }),
    seed: z.number().int().min(0).max(4_294_967_295).default(1),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentSchema>;
export type ValidateCredentialReferencesInput = z.infer<typeof validateCredentialReferencesSchema>;
export type CreateTestSpecificationInput = z.infer<typeof createTestSpecificationSchema>;
export type UpdateTestSpecificationInput = z.infer<typeof updateTestSpecificationSchema>;
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type CreateSpecificationVersionInput = z.infer<typeof createSpecificationVersionSchema>;
export type CreatePlanVersionInput = z.infer<typeof createPlanVersionSchema>;
export type CreateAtomicRevisionInput = z.infer<typeof createAtomicRevisionSchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
