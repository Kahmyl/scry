import { z } from "zod";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,99}$/);
const providerKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const opaqueReference = z.string().trim().min(1).max(200);
const contextControlReference = z.string().regex(/^context-control-[a-f0-9]{32}$/);

export const protectedSyntheticGeneratorSchema = z
  .object({
    generatorContract: z.enum([
      "reserved_test_email",
      "synthetic_person_name",
      "sandbox_shipping_address_json",
      "opaque_operation_token",
      "nested_client_order_json",
    ]),
    generatorVersion: z.literal(1),
    purpose: z.literal("test_order_qualification"),
  })
  .strict();

export const operationDispatchSemanticsSchema = z.enum(["read_only", "mutation"]);
export const operationEffectSemanticsSchema = z.enum([
  "read",
  "business_effect",
  "authentication",
  "protected_acquisition",
]);

export const operationSemanticsSchema = z
  .object({
    dispatch: operationDispatchSemanticsSchema,
    effects: z.array(operationEffectSemanticsSchema).min(1).max(4),
  })
  .strict()
  .superRefine((semantics, context) => {
    if (new Set(semantics.effects).size !== semantics.effects.length)
      context.addIssue({ code: "custom", path: ["effects"], message: "effects must be unique" });
    if (semantics.dispatch === "read_only" && semantics.effects.includes("business_effect"))
      context.addIssue({
        code: "custom",
        path: ["effects"],
        message: "read-only dispatch cannot declare a business effect",
      });
  });

export const canonicalOutputDescriptorSchema = z
  .object({
    key: canonicalKey,
    label: z.string().trim().min(1).max(200),
    classification: z.enum(["public", "protected"]),
    extractor: z
      .discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("json_path"), path: z.string().trim().min(1).max(500) })
          .strict(),
        z.object({ kind: z.literal("document_semantic"), concept: opaqueReference }).strict(),
      ])
      .optional(),
    identityRole: z.enum(["resource_identity", "continuation_identity"]).optional(),
    resourceRole: providerKey.optional(),
    generatedValueEligible: z.boolean().default(false),
  })
  .strict();

export const operationContractFactsSchema = z
  .object({
    application: z.object({ key: providerKey, provider: providerKey.optional() }).strict(),
    adapter: z.object({ key: providerKey, version: z.number().int().positive() }).strict(),
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
        semantics: operationSemanticsSchema,
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
            syntheticInput: protectedSyntheticGeneratorSchema.optional(),
            checkbox: z
              .object({ requiredState: z.boolean().optional() })
              .strict()
              .optional()
              .describe(
                "Observed checkbox input: use literal_public with value string true or false and plain_text presentation. This is application form state, not a Scry owner approval.",
              ),
            acceptedPresentations: z
              .array(z.enum(["plain_text", "protected_text", "json_public", "json_protected"]))
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .max(100),
    auth: z
      .object({
        presentationClasses: z
          .array(z.enum(["plain_text", "protected_text", "json_public", "json_protected"]))
          .max(4),
      })
      .strict(),
    response: z
      .object({
        statusClasses: z.array(z.number().int().min(1).max(5)).min(1).max(5),
        mutationPolicy: z
          .object({
            confirmedNotAppliedStatuses: z.array(z.number().int().min(400).max(499)).min(1).max(32),
          })
          .strict()
          .optional(),
        outputs: z.array(canonicalOutputDescriptorSchema).max(32),
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
        correlationFieldKey: canonicalKey.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((facts, context) => {
    const semantics = facts.operation.semantics;
    if (semantics.dispatch === "read_only" && facts.operation.method !== "GET")
      context.addIssue({
        code: "custom",
        path: ["operation", "method"],
        message: "read-only operation contracts must use GET",
      });
    if (semantics.dispatch === "read_only" && facts.response.mutationPolicy)
      context.addIssue({
        code: "custom",
        path: ["response", "mutationPolicy"],
        message: "read-only operation contracts cannot carry mutation response policy",
      });
    if (semantics.dispatch === "mutation" && !facts.response.mutationPolicy)
      context.addIssue({
        code: "custom",
        path: ["response", "mutationPolicy"],
        message: "mutation operation contracts require mutation response policy",
      });
    const inputKeys = facts.inputs.map((input) => input.key);
    if (new Set(inputKeys).size !== inputKeys.length)
      context.addIssue({ code: "custom", path: ["inputs"], message: "input keys must be unique" });
    const outputKeys = facts.response.outputs.map((output) => output.key);
    if (new Set(outputKeys).size !== outputKeys.length)
      context.addIssue({
        code: "custom",
        path: ["response", "outputs"],
        message: "output keys must be unique",
      });
    const identityOutputs = facts.response.outputs.filter((output) => output.identityRole);
    if (identityOutputs.length > 1)
      context.addIssue({
        code: "custom",
        path: ["response", "outputs"],
        message: "an operation contract may declare only one canonical identity output",
      });
    if (
      facts.resourceEffect &&
      (!facts.response.outputs.some(
        (output) =>
          output.key === facts.resourceEffect!.identityOutputKey &&
          output.classification === "public" &&
          output.identityRole === "resource_identity",
      ) ||
        (facts.resourceEffect.correlationFieldKey !== undefined &&
          !facts.inputs.some((input) => input.key === facts.resourceEffect!.correlationFieldKey)))
    )
      context.addIssue({
        code: "custom",
        path: ["resourceEffect"],
        message: "resource effects require a public resource identity output and correlation input",
      });
  });

export const operationContractProvenanceSchema = z
  .object({
    sourceKind: z.enum(["public_document", "public_resource", "runtime_observation"]),
    observationId: opaqueReference,
    origin: z.string().url(),
    observedAt: z.string().datetime(),
    sourcePraxisSessionId: uuid.optional(),
    sourceDocumentEpoch: z.number().int().nonnegative().optional(),
  })
  .strict();

export const operationContractRevisionSchema = z
  .object({
    id: uuid,
    revision: z.number().int().positive(),
    digest,
    facts: operationContractFactsSchema,
    provenance: operationContractProvenanceSchema,
    retentionState: z.enum(["active", "superseded", "retained", "expired"]),
    staleness: z.enum(["current", "historical", "unknown"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export const runtimeInteractionCapabilitySchema = z
  .object({
    id: uuid,
    operationContractRevisionId: uuid,
    operationContractRevisionDigest: digest,
    praxisSessionId: uuid,
    runtimeOwnerId: uuid,
    fencingEpoch: z.number().int().positive(),
    documentEpoch: z.number().int().nonnegative(),
    origin: z.string().url(),
    activationControlReference: contextControlReference,
    inputControlReferences: z.record(canonicalKey, contextControlReference),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    state: z.enum(["active", "consumed", "revoked", "expired", "stale"]),
  })
  .strict();

export const proposedOperationContractSchema = z
  .object({
    facts: operationContractFactsSchema,
    provenance: operationContractProvenanceSchema,
    interaction: z
      .object({
        praxisSessionId: uuid,
        documentEpoch: z.number().int().nonnegative(),
        origin: z.string().url(),
        activationControlReference: contextControlReference,
        inputControlReferences: z.record(canonicalKey, contextControlReference),
      })
      .strict(),
  })
  .strict();

export const operationContractRegistryEntrySchema = z
  .object({
    revision: operationContractRevisionSchema,
    interaction: runtimeInteractionCapabilitySchema.optional(),
    executableInteractionAvailable: z.boolean(),
  })
  .strict();

export const operationContractRegistryResultSchema = z
  .object({ contracts: z.array(operationContractRegistryEntrySchema).max(24) })
  .strict();

export const operationContractDiscoveryResultSchema = z
  .object({
    contracts: z
      .array(
        operationContractRegistryEntrySchema.extend({
          interaction: runtimeInteractionCapabilitySchema
            .omit({ runtimeOwnerId: true, fencingEpoch: true })
            .optional(),
        }),
      )
      .max(24),
  })
  .strict();

export type OperationContractFacts = z.infer<typeof operationContractFactsSchema>;
export type OperationContractRevision = z.infer<typeof operationContractRevisionSchema>;
export type RuntimeInteractionCapability = z.infer<typeof runtimeInteractionCapabilitySchema>;
export type ProposedOperationContract = z.infer<typeof proposedOperationContractSchema>;
export type OperationContractRegistryEntry = z.infer<typeof operationContractRegistryEntrySchema>;
