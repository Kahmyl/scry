import { z } from "zod";

import {
  operationDispatchSemanticsSchema,
  operationEffectSemanticsSchema,
  protectedSyntheticGeneratorSchema,
} from "./operation-contract.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,99}$/);
const providerKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const opaqueReference = z.string().trim().min(1).max(200);
const contextControlReference = z.string().regex(/^context-control-[a-f0-9]{32}$/);

export const valuePresentationClassSchema = z.enum([
  "plain_text",
  "protected_text",
  "json_public",
  "json_protected",
]);

// A durable discovery projection, deliberately without value material, backing
// credential IDs, browser refs or runtime leases. Provenance is not permission.
export const missionValueAssetsResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          valueAssetId: uuid,
          applicationKey: providerKey,
          classification: z.enum(["public", "protected"]),
          canonicalOutputKey: canonicalKey,
          identityRole: z.enum(["resource_identity", "continuation_identity"]).nullable(),
          producerProtectedOperationId: uuid,
          producerMissionId: uuid,
          contractRevisionId: uuid,
          state: z.enum(["active", "revoked", "expired", "compromised"]),
        })
        .strict(),
    ),
  })
  .strict();

export const operationValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal_public"), value: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("stored_public"), valueId: uuid }).strict(),
  z.object({ kind: z.literal("protected_reference"), referenceId: uuid }).strict(),
  z
    .object({
      kind: z.literal("generated_safe"),
      valueAssetId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("generated_protected"),
      valueAssetId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("synthetic_protected"),
      declaration: protectedSyntheticGeneratorSchema.extend({
        semantic: canonicalKey.describe(
          "The exact canonicalFieldKey of this input, not a description or alias.",
        ),
      }),
    })
    .strict(),
]);

export const preparedOperationValueBindingSchema = z
  .object({
    canonicalFieldKey: canonicalKey,
    targetReference: opaqueReference,
    presentationClass: valuePresentationClassSchema,
    source: operationValueSourceSchema,
  })
  .strict();

export const executionPolicySnapshotSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    environmentId: uuid,
    applicationKey: providerKey,
    policyVersion: z.number().int().positive(),
    allowedOrigins: z.array(z.string().url()).min(1).max(100),
    trustedScriptOrigins: z.array(z.string().url()).max(100),
    policy: z.record(z.string(), z.unknown()),
    digest,
    createdAt: z.string().datetime(),
  })
  .strict();

export const preparedExecutionCapabilitySchema = z
  .object({
    id: uuid,
    protectedOperationId: uuid,
    mutationIdentity: uuid,
    operationContractRevisionId: uuid,
    operationContractRevisionDigest: digest,
    runtimeInteractionCapabilityId: uuid,
    executionPolicySnapshotId: uuid,
    executionPolicySnapshotDigest: digest,
    projectId: uuid,
    environmentId: uuid,
    missionId: uuid,
    objectiveId: uuid,
    agentSessionId: uuid,
    applicationKey: providerKey,
    dispatchSemantics: operationDispatchSemanticsSchema,
    effectSemantics: z.array(operationEffectSemanticsSchema).min(1).max(4),
    targetCommitment: digest,
    inputCommitment: digest,
    outputCommitment: digest,
    resourceEffect: z.record(z.string(), z.unknown()).nullable(),
    programManifest: z.record(z.string(), z.unknown()).nullable(),
    programDigest: digest.nullable(),
    state: z.enum(["reserved", "finalized", "invalidated", "historical"]),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    finalizedAt: z.string().datetime().nullable(),
  })
  .strict();

export const valueUseGrantSchema = z
  .object({
    id: uuid,
    valueAssetId: uuid,
    producerProtectedOperationId: uuid,
    missionId: uuid,
    consumerProtectedOperationId: uuid,
    consumerPreparedExecutionCapabilityId: uuid,
    projectId: uuid,
    environmentId: uuid,
    applicationKey: providerKey,
    canonicalFieldKey: canonicalKey,
    presentationClass: valuePresentationClassSchema,
    expiresAt: z.string().datetime(),
    maxUses: z.literal(1),
    useCount: z.number().int().nonnegative(),
    state: z.enum(["active", "consumed", "revoked", "expired", "invalidated"]),
  })
  .strict();

export const canonicalPersistedOutputReferenceSchema = z
  .object({
    canonicalOutputKey: canonicalKey,
    contractRevisionId: uuid,
    classification: z.enum(["public", "protected"]),
    valueAssetId: uuid,
    transportExtractor: z.record(z.string(), z.unknown()).nullable(),
    identityRole: z.enum(["resource_identity", "continuation_identity"]).nullable(),
    producerProtectedOperationId: uuid,
  })
  .strict();

export const reservePreparedProtectedOperationSchema = z
  .object({
    projectId: uuid,
    environmentId: uuid,
    missionId: uuid,
    objectiveId: uuid,
    agentSessionId: uuid,
    publicOperationId: opaqueReference,
    operationContractRevisionId: uuid,
    operationContractRevisionDigest: digest,
    runtimeInteractionCapabilityId: uuid,
    targetCommitment: digest.optional(),
    inputCommitment: digest.optional(),
    outputCommitment: digest.optional(),
    continuationReference: uuid.optional(),
    values: z.array(preparedOperationValueBindingSchema).max(100),
    expectedOutputs: z
      .array(
        z.object({ key: canonicalKey, classification: z.enum(["public", "protected"]) }).strict(),
      )
      .min(1)
      .max(32),
    expiresAt: z
      .string()
      .datetime()
      .describe(
        "Optional stricter UTC deadline. Otherwise the kernel bounds the reservation by current interaction expiry and two minutes; runtime expiry is always enforced independently.",
      )
      .optional(),
  })
  .strict();

export const resumePreparedProtectedOperationSchema = z
  .object({
    protectedOperationId: uuid,
    preparedExecutionCapabilityId: uuid,
    publicOperationId: opaqueReference,
  })
  .strict();

export const dispatchPreparedProtectedOperationSchema = resumePreparedProtectedOperationSchema;
export const dispatchRunPreparedOperationSchema = dispatchPreparedProtectedOperationSchema.extend({
  praxisSessionId: uuid,
});
export type DispatchRunPreparedOperationInput = z.infer<typeof dispatchRunPreparedOperationSchema>;

export const preparedProtectedOperationReservationResultSchema = z
  .object({
    protectedOperationId: uuid,
    preparedExecutionCapabilityId: uuid,
    publicOperationId: opaqueReference,
    mutationIdentity: uuid,
    state: z.literal("reserved"),
    contractDigest: digest,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const preparedProtectedOperationResumeResultSchema = z
  .object({
    protectedOperationId: uuid,
    preparedExecutionCapabilityId: uuid,
    publicOperationId: opaqueReference,
    state: z.enum(["planned", "preparing", "ready_to_dispatch"]),
    operationContractRevisionId: uuid,
    runtimeInteractionCapabilityId: uuid,
    resumeAllowed: z.literal(true),
    immutableReservation: z.literal(true),
  })
  .strict();

export const preparedProtectedOperationDispatchResultSchema = z
  .object({
    protectedOperationId: uuid,
    publicOperationId: opaqueReference,
    state: z.string().trim().min(1).max(100),
    replayed: z.boolean(),
    sourceMutationRepeatable: z.literal(false),
  })
  .strict();

export const preparedOperationAuthorizationBindingSchema = z
  .object({
    protectedOperationId: uuid,
    preparedExecutionCapabilityId: uuid,
    publicOperationId: opaqueReference,
    contractDigest: digest,
  })
  .strict();

export const missionOperationContinuationClassSchema = z.enum(["read_only_retrieve", "reconcile"]);

export const missionOperationCheckpointSchema = z
  .object({
    id: uuid,
    sourceProtectedOperationId: uuid,
    mutationReceiptDigest: digest,
    mutationOutcome: z.enum(["applied", "unknown"]),
    dispatchAcknowledged: z.boolean(),
    persistedReferences: z.record(z.string(), z.unknown()),
    permittedContinuations: z.array(missionOperationContinuationClassSchema).max(2),
    sourceMutationRepeatable: z.literal(false),
    state: z.enum(["available", "claimed", "completed", "blocked"]),
    createdIdentityDigest: digest.nullable().optional(),
    retrievedIdentityDigest: digest.nullable().optional(),
    identityMatches: z.boolean().nullable().optional(),
  })
  .strict();
export const missionOperationCheckpointsResultSchema = z
  .object({ checkpoints: z.array(missionOperationCheckpointSchema).max(100) })
  .strict();

export type OperationValueSource = z.infer<typeof operationValueSourceSchema>;
export const praxisRuntimeOwnershipSchema = z
  .object({
    sessionState: z.string().trim().min(1).max(40),
    runtime: z.object({ state: z.enum(["owned", "unowned", "expired"]) }).strict(),
  })
  .strict();
export type PreparedOperationValueBinding = z.infer<typeof preparedOperationValueBindingSchema>;
export type PreparedExecutionCapability = z.infer<typeof preparedExecutionCapabilitySchema>;
export type ValueUseGrant = z.infer<typeof valueUseGrantSchema>;
export type ReservePreparedProtectedOperationInput = z.infer<
  typeof reservePreparedProtectedOperationSchema
>;
export type ResumePreparedProtectedOperationInput = z.infer<
  typeof resumePreparedProtectedOperationSchema
>;
export type DispatchPreparedProtectedOperationInput = z.infer<
  typeof dispatchPreparedProtectedOperationSchema
>;

export const missionContinuationSchema = z
  .object({
    continuationReference: uuid,
    sourceOperationId: uuid,
    resourceType: z.string().min(1).max(200),
    canonicalIdentityReference: uuid,
    readOnly: z.literal(true),
    description: z.string().min(1).max(500),
    eligibleOperations: z.array(
      z
        .object({
          operationContractRevisionId: uuid,
          operationKey: canonicalKey,
          description: z.string().min(1).max(200),
          readOnly: z.literal(true),
        })
        .strict(),
    ),
  })
  .strict();
export const missionContinuationsResultSchema = z
  .object({
    continuations: z.array(missionContinuationSchema).max(100),
  })
  .strict();
