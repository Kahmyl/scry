import { z } from "zod";

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

export const operationValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal_public"), value: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal("stored_public"), valueId: uuid }).strict(),
  z.object({ kind: z.literal("protected_reference"), referenceId: uuid }).strict(),
  z.object({ kind: z.literal("generated_safe"), valueId: uuid }).strict(),
  z.object({ kind: z.literal("synthetic_protected"), referenceId: uuid }).strict(),
]);

export const preparedOperationValueBindingSchema = z
  .object({
    canonicalFieldKey: canonicalKey,
    targetReference: opaqueReference,
    presentationClass: valuePresentationClassSchema,
    source: operationValueSourceSchema,
  })
  .strict();

export const observedOperationFactsSchema = z
  .object({
    operation: z
      .object({
        key: canonicalKey,
        label: z.string().trim().min(1).max(200),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        pathTemplate: z.string().startsWith("/").max(500),
        transports: z
          .array(z.enum(["document", "fetch", "xhr"]))
          .min(1)
          .max(3),
        classification: z.enum(["read_only", "mutation"]),
        activationControlReference: contextControlReference,
      })
      .strict(),
    inputs: z
      .array(
        z
          .object({
            key: canonicalKey,
            label: z.string().trim().min(1).max(200),
            aliases: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
            required: z.boolean(),
            classification: z.enum(["public", "protected", "generated_safe"]),
            acceptedPresentations: z.array(valuePresentationClassSchema).min(1).max(4),
            controlReference: contextControlReference.optional(),
          })
          .strict(),
      )
      .max(100),
    auth: z.object({ presentationClasses: z.array(valuePresentationClassSchema).max(4) }).strict(),
    response: z
      .object({
        statusClasses: z.array(z.number().int().min(1).max(5)).min(1).max(5),
        confirmedNotAppliedStatuses: z.array(z.number().int().min(400).max(499)).max(32),
        safeOutputKeys: z.array(canonicalKey).max(32),
        safeOutputs: z
          .array(
            z
              .object({
                key: canonicalKey,
                label: z.string().trim().min(1).max(200),
                classification: z.enum(["public", "protected"]),
                path: z.string().trim().min(1).max(500).optional(),
              })
              .strict(),
          )
          .max(32)
          .default([]),
        publicIdentityOutputPath: z.string().trim().min(1).max(500).optional(),
        continuation: z.enum(["none", "read_only_retrieve", "reconcile"]),
      })
      .strict(),
    retrieval: z
      .object({ canonicalTargetFieldKey: canonicalKey, pathTemplate: z.string().startsWith("/") })
      .strict()
      .optional(),
    resourceEffect: z
      .object({
        operation: z.literal("create"),
        provider: providerKey,
        resourceKind: providerKey,
        resourceScope: z.string().trim().min(1).max(500),
        identityContractVersion: z.number().int().positive().max(1_000),
        identityOutputKey: canonicalKey,
        correlationFieldKey: canonicalKey,
      })
      .strict()
      .optional(),
  })
  .strict();

export const observedOperationContractSchema = observedOperationFactsSchema
  .extend({
    id: uuid,
    digest,
    praxisSessionId: uuid,
    documentEpoch: z.number().int().nonnegative(),
    origin: z.string().url(),
    sourceKind: z.enum(["public_document", "public_resource", "runtime_observation"]),
    observationId: opaqueReference,
  })
  .strict()
  .superRefine((contract, context) => {
    if (
      contract.operation.classification === "read_only" &&
      !["GET"].includes(contract.operation.method)
    )
      context.addIssue({
        code: "custom",
        path: ["operation", "method"],
        message: "read-only observed operations must use GET",
      });
    if (
      contract.operation.classification === "mutation" &&
      contract.response.confirmedNotAppliedStatuses.length === 0
    )
      context.addIssue({
        code: "custom",
        path: ["response", "confirmedNotAppliedStatuses"],
        message: "mutation contracts require confirmed-not-applied response statuses",
      });
    const keys = contract.inputs.map((input) => input.key);
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", path: ["inputs"], message: "field keys must be unique" });
    const describedOutputKeys = contract.response.safeOutputs.map((output) => output.key);
    if (
      new Set(describedOutputKeys).size !== describedOutputKeys.length ||
      describedOutputKeys.length !== contract.response.safeOutputKeys.length ||
      describedOutputKeys.some((key) => !contract.response.safeOutputKeys.includes(key))
    )
      context.addIssue({
        code: "custom",
        path: ["response", "safeOutputs"],
        message: "every safe output key requires one authoritative classification descriptor",
      });
    if (
      contract.resourceEffect &&
      (!contract.response.safeOutputKeys.includes(contract.resourceEffect.identityOutputKey) ||
        !contract.inputs.some(
          (input) => input.key === contract.resourceEffect!.correlationFieldKey,
        ))
    )
      context.addIssue({
        code: "custom",
        path: ["resourceEffect"],
        message: "resource effects require declared identity output and correlation input keys",
      });
  });

export const reservePreparedProtectedOperationSchema = z
  .object({
    projectId: uuid,
    environmentId: uuid,
    missionId: uuid,
    objectiveId: uuid,
    agentSessionId: uuid,
    praxisSessionId: uuid,
    publicOperationId: opaqueReference,
    observedOperationContractId: uuid,
    observedOperationContractDigest: digest,
    documentEpoch: z.number().int().nonnegative(),
    targetCommitment: digest,
    inputCommitment: digest,
    outputCommitment: digest,
    values: z.array(preparedOperationValueBindingSchema).max(100),
    expectedOutputs: z
      .array(
        z.object({ key: canonicalKey, classification: z.enum(["public", "protected"]) }).strict(),
      )
      .min(1)
      .max(32),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const resumePreparedProtectedOperationSchema = z
  .object({
    protectedOperationId: uuid,
    publicOperationId: opaqueReference,
    praxisSessionId: uuid,
    observedOperationContractDigest: digest,
    targetCommitment: digest,
    inputCommitment: digest,
    outputCommitment: digest,
  })
  .strict();

export const dispatchPreparedProtectedOperationSchema = resumePreparedProtectedOperationSchema;

export const preparedProtectedOperationReservationResultSchema = z
  .object({
    protectedOperationId: uuid,
    publicOperationId: opaqueReference,
    state: z.literal("reserved"),
    contractDigest: digest,
    authorizationRequired: z.literal(true),
    expiresAt: z.string().datetime(),
    authorization: z
      .object({
        missionId: uuid,
        objectiveId: uuid,
        environmentId: uuid,
        agentSessionId: uuid,
        praxisSessionId: uuid,
        protectedOperationId: uuid,
        publicOperationId: opaqueReference,
        operationLabel: z.string().trim().min(1).max(200),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        targetClass: z.enum(["read_only", "mutation"]),
        contractDigest: digest,
        expiresAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

export const preparedProtectedOperationResumeResultSchema = z
  .object({
    protectedOperationId: uuid,
    publicOperationId: opaqueReference,
    praxisSessionId: uuid,
    authorizationId: uuid,
    state: z.enum(["planned", "preparing", "ready_to_dispatch"]),
    operationContractId: uuid,
    documentEpoch: z.number().int().nonnegative(),
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

export const claimMissionOperationContinuationSchema = z
  .object({
    checkpointId: uuid,
    consumerProtectedOperationId: uuid,
    continuation: missionOperationContinuationClassSchema,
    sourceOutputReference: canonicalKey.optional(),
    canonicalFieldKey: canonicalKey.optional(),
    targetReference: opaqueReference.optional(),
    presentationClass: valuePresentationClassSchema.optional(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((input, context) => {
    const generatedFields = [
      input.sourceOutputReference,
      input.canonicalFieldKey,
      input.targetReference,
      input.presentationClass,
    ];
    if (
      input.continuation === "read_only_retrieve" &&
      generatedFields.some((value) => value === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "read-only retrieval requires an exact generated output consumer binding",
      });
    if (input.continuation === "reconcile" && generatedFields.some((value) => value !== undefined))
      context.addIssue({ code: "custom", message: "reconciliation does not present outputs" });
  });

export const missionOperationContinuationClaimResultSchema = z
  .object({
    checkpointId: uuid,
    consumerProtectedOperationId: uuid,
    continuation: missionOperationContinuationClassSchema,
    sourceMutationRepeatable: z.literal(false),
    state: z.literal("claimed"),
  })
  .strict();

export type OperationValueSource = z.infer<typeof operationValueSourceSchema>;
export const observedOperationContractsResultSchema = z
  .object({ contracts: z.array(observedOperationContractSchema).max(24) })
  .strict();
export const praxisRuntimeOwnershipSchema = z
  .object({
    sessionState: z.string().trim().min(1).max(40),
    runtime: z.object({ state: z.enum(["owned", "unowned", "expired"]) }).strict(),
  })
  .strict();
export type PreparedOperationValueBinding = z.infer<typeof preparedOperationValueBindingSchema>;
export type ObservedOperationContract = z.infer<typeof observedOperationContractSchema>;
export type ReservePreparedProtectedOperationInput = z.infer<
  typeof reservePreparedProtectedOperationSchema
>;
export type ResumePreparedProtectedOperationInput = z.infer<
  typeof resumePreparedProtectedOperationSchema
>;
export type DispatchPreparedProtectedOperationInput = z.infer<
  typeof dispatchPreparedProtectedOperationSchema
>;
export type ClaimMissionOperationContinuationInput = z.infer<
  typeof claimMissionOperationContinuationSchema
>;
