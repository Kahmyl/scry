import { z } from "zod";

import { flowRevisionContentSchema } from "./api.js";
import { currentPlanSchema } from "./current.js";
import { objectiveContextSchema } from "./mission.js";
import { semanticRoleSchema } from "./grounding.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const flowDraftStateSchema = z.enum([
  "editing",
  "probing",
  "compiling",
  "publishable",
  "published",
  "abandoned",
]);

/** Mutable M2 authoring intent; published-flow metadata remains a separate compatibility concern. */
export const flowDraftPurposeSchema = z.enum([
  "setup",
  "primary",
  "acceptance",
  "diagnostic",
  "reconciliation",
  "cleanup",
]);

export const probeLevelSchema = z.enum(["inspection", "reversible", "calibration_transaction"]);

export const probeStateSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const probeAuthoringStatusSchema = z.enum([
  "starting",
  "active",
  "suspended",
  "completing",
  "completed",
  "cancelled",
  "crashed",
]);

export const authoringBrowserLeaseStateSchema = z.enum([
  "provisioning",
  "active",
  "suspended",
  "releasing",
  "released",
  "expired",
  "crashed",
]);

export const compilationStatusSchema = z.enum([
  "pending",
  "execution_ready",
  "calibration_required",
  "invalid",
  "runtime_unhealthy",
  "stale",
  "superseded",
]);

export const executionOutcomeClassSchema = z.enum([
  "application_pass",
  "application_failure",
  "calibration_required",
  "infrastructure_failure",
  "environment_failure",
  "policy_refusal",
  "cancelled",
  "legacy_authoring_attempt",
]);

const codeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const safeRecordSchema = z.record(z.string(), z.unknown());
const semanticText = z.string().trim().min(1).max(500);

export const missionAuthoringSemanticTargetSchema = z
  .object({
    concept: semanticText,
    reference: z.string().regex(/^context-control-[a-f0-9]{32}$/).optional(),
    role: semanticRoleSchema.optional(),
    name: semanticText.optional(),
    label: semanticText.optional(),
    placeholder: semanticText.optional(),
    text: semanticText.optional(),
    testId: semanticText.optional(),
    scope: z
      .object({
        kind: z.enum(["page", "dialog", "form", "section", "row", "region", "live_region"]),
        name: semanticText.optional(),
      })
      .strict()
      .superRefine((scope, context) => {
        if (scope.kind === "section" && !scope.name)
          context.addIssue({
            code: "custom",
            path: ["name"],
            message: "section scope requires a visible anchor name",
          });
      })
      .optional(),
    exact: z.boolean().default(true),
  })
  .strict()
  .superRefine((target, context) => {
    if (
      !target.reference &&
      !target.role &&
      !target.name &&
      !target.label &&
      !target.placeholder &&
      !target.text &&
      !target.testId
    )
      context.addIssue({
        code: "custom",
        message: "semantic target requires an observable locator fact besides concept",
      });
  });

const safePressKeySchema = z.enum([
  "Enter",
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
const publicJsonBodySchema = z
  .record(
    z.string().trim().min(1).max(100),
    z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]),
  )
  .superRefine((body, context) => {
    if (Object.keys(body).length > 100)
      context.addIssue({ code: "custom", message: "same-origin request body has too many fields" });
    for (const key of Object.keys(body)) {
      if (/(secret|protected|credential|token|password|authorization)/i.test(key))
        context.addIssue({
          code: "custom",
          path: [key],
          message: "same-origin request bodies may contain public values only",
        });
    }
  });

export const missionAuthoringSemanticActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().url() }).strict(),
  z
    .object({
      kind: z.literal("activate"),
      target: missionAuthoringSemanticTargetSchema,
      semanticEffect: z
        .enum(["read_context_transition", "resource_mutation", "unknown"])
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      target: missionAuthoringSemanticTargetSchema,
      publicValue: z.string().max(20_000).optional(),
      protectedReferenceId: uuid.optional(),
      syntheticProtectedSource: z
        .object({
          semantic: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
          generatorContract: z.enum([
            "reserved_test_email",
            "synthetic_person_name",
            "sandbox_shipping_address_json",
            "opaque_operation_token",
          ]),
          generatorVersion: z.literal(1),
          purpose: z.literal("test_order_qualification"),
          resourceKind: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
          operation: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
        })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((action, context) => {
      if (
        [action.publicValue, action.protectedReferenceId, action.syntheticProtectedSource].filter(
          (value) => value !== undefined,
        ).length !== 1
      )
        context.addIssue({
          code: "custom",
          message:
            "fill requires exactly one public, credential, or synthetic protected value source",
        });
    }),
  z
    .object({
      kind: z.literal("select"),
      target: missionAuthoringSemanticTargetSchema,
      value: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_checked"),
      target: missionAuthoringSemanticTargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("press"),
      target: missionAuthoringSemanticTargetSchema.optional(),
      key: safePressKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("wait_for"),
      target: missionAuthoringSemanticTargetSchema,
      state: z.enum(["visible", "hidden", "attached", "detached"]),
    })
    .strict(),
  z.object({ kind: z.literal("inspect"), target: missionAuthoringSemanticTargetSchema }).strict(),
  z
    .object({
      kind: z.literal("acquire_protected_outputs"),
      preparationIntentIds: z
        .array(z.string().trim().min(1).max(200))
        .min(1)
        .max(50)
        .refine(
          (values) => new Set(values).size === values.length,
          "preparation intent IDs must be unique",
        ),
      mutation: z
        .object({
          kind: z.enum(["one_time", "read_only"]),
          target: missionAuthoringSemanticTargetSchema,
        })
        .strict(),
      syntheticProtectedInputs: z
        .array(
          z
            .object({
              semantic: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
              generatorContract: z.enum(["nested_client_order_json", "opaque_operation_token"]),
              generatorVersion: z.literal(1),
              purpose: z.literal("test_order_qualification"),
              resourceKind: z.literal("order"),
              operation: z.literal("create"),
              target: missionAuthoringSemanticTargetSchema,
            })
            .strict(),
        )
        .max(4)
        .refine(
          (values) => new Set(values.map((value) => value.semantic)).size === values.length,
          "synthetic protected input semantics must be unique",
        )
        .optional(),
      request: z
        .object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          pathTemplate: z.string().startsWith("/").max(500),
          transports: z
            .array(z.enum(["document", "fetch", "xhr"]))
            .min(1)
            .max(3),
        })
        .strict()
        .optional(),
      response: z
        .object({
          confirmedNotAppliedStatuses: z
            .array(z.number().int().min(400).max(499))
            .min(1)
            .max(32)
            .refine(
              (statuses) => new Set(statuses).size === statuses.length,
              "confirmed-not-applied statuses must be unique",
            ),
        })
        .strict()
        .optional(),
      outputs: z
        .array(
          z
            .object({
              reference: z
                .string()
                .trim()
                .min(1)
                .max(100)
                .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
              classification: z.enum(["public", "protected"]),
              target: missionAuthoringSemanticTargetSchema,
              storageName: z.string().trim().min(1).max(200),
            })
            .strict(),
        )
        .min(1)
        .max(8)
        .refine(
          (outputs) => new Set(outputs.map((output) => output.reference)).size === outputs.length,
          "output references must be unique",
        ),
      externalResourceBindings: z
        .array(
          z.discriminatedUnion("status", [
            z
              .object({
                status: z.literal("active"),
                identityReference: z.string().trim().min(1).max(100),
                provider: z
                  .string()
                  .trim()
                  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
                resourceKind: z
                  .string()
                  .trim()
                  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
                resourceScope: z.string().trim().min(1).max(500),
                identityContractVersion: z.number().int().min(1).max(1_000),
                identitySource: z.literal("response"),
                requiredForDestructiveLifecycle: z.boolean().default(true),
              })
              .strict(),
            z
              .object({
                status: z.literal("unavailable"),
                provider: z
                  .string()
                  .trim()
                  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
                resourceKind: z
                  .string()
                  .trim()
                  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
                resourceScope: z.string().trim().min(1).max(500),
                identityContractVersion: z.number().int().min(1).max(1_000),
                requiredForDestructiveLifecycle: z.boolean().default(true),
              })
              .strict(),
          ]),
        )
        .max(8)
        .optional(),
      resourceEffect: z
        .object({
          operation: z.literal("create"),
          provider: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
          resourceKind: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
          resourceScope: z.string().trim().min(1).max(500),
          identityContractVersion: z.number().int().min(1).max(1_000),
          correlation: z
            .object({
              field: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
              value: z.string().trim().min(1).max(500),
              uniqueness: z.literal("resource_scope"),
            })
            .strict(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("same_origin_request"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      authentication: z.literal("current_browser_session"),
      path: z
        .string()
        .startsWith("/")
        .max(1_000)
        .refine(
          (value) => !value.startsWith("//") && !value.includes("://") && !value.includes("\\"),
          {
            message: "same-origin request path may not include a scheme or host",
          },
        ),
      body: publicJsonBodySchema.optional(),
      expectedStatus: z
        .object({
          min: z.number().int().min(100).max(599),
          max: z.number().int().min(100).max(599),
        })
        .strict()
        .superRefine((status, context) => {
          if (status.min > status.max)
            context.addIssue({
              code: "custom",
              message: "expected status minimum exceeds maximum",
            });
        }),
    })
    .strict(),
]);

export const missionAuthoringSemanticEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("navigation"),
      url: z.string().url().optional(),
      /** Host-compatible alias; normalized to url before kernel execution. */
      urlPattern: z.string().url().optional(),
      match: z.enum(["exact", "path", "contains"]).default("path"),
    })
    .strict()
    .superRefine((effect, context) => {
      if (effect.url && effect.urlPattern)
        context.addIssue({
          code: "custom",
          message: "navigation expected effect accepts url or urlPattern, not both",
        });
    }),
  z
    .object({
      kind: z.literal("target_visibility"),
      target: missionAuthoringSemanticTargetSchema,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_value"),
      target: missionAuthoringSemanticTargetSchema,
      expected: z.string().max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("target_state"),
      target: missionAuthoringSemanticTargetSchema,
      checked: z.boolean().optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .superRefine((effect, context) => {
      if (effect.checked === undefined && effect.enabled === undefined)
        context.addIssue({
          code: "custom",
          message: "target state requires a checked or enabled value",
        });
    }),
  z.object({ kind: z.literal("new_page"), origin: z.string().url().optional() }).strict(),
]);

export const missionAuthoringIntentSchema = z
  .object({
    intentId: z.string().trim().min(1).max(200),
    objectiveId: uuid,
    flowDraftId: uuid,
    action: missionAuthoringSemanticActionSchema,
    expectedEffect: missionAuthoringSemanticEffectSchema,
    constraints: z
      .object({
        timeoutMs: z.number().int().min(100).max(60_000),
        allowNewPage: z.boolean(),
        allowNonExact: z.boolean(),
      })
      .strict(),
    authorization: z
      .object({
        kind: z.enum([
          "ordinary",
          "authentication",
          "reversible",
          "live_read",
          "live_mutation",
          "protected_mutation",
        ]),
        authorizationId: uuid.optional(),
      })
      .strict(),
    protectedInputReferences: z.array(uuid).max(20).default([]),
    credentialLifecycle: z
      .object({
        effect: z.literal("revoke"),
        credentialReferenceIds: z.array(uuid).min(1).max(20),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.action.kind === "activate" &&
      intent.action.semanticEffect === "read_context_transition" &&
      intent.authorization.kind !== "live_read"
    )
      context.addIssue({
        code: "custom",
        path: ["authorization", "kind"],
        message: "read-context activation requires explicit live_read authority",
      });
    const protectedReferences =
      intent.action.kind === "fill" && intent.action.protectedReferenceId
        ? [intent.action.protectedReferenceId]
        : [];
    if (
      new Set(intent.protectedInputReferences).size !== intent.protectedInputReferences.length ||
      intent.protectedInputReferences.length !== protectedReferences.length ||
      protectedReferences.some((reference) => !intent.protectedInputReferences.includes(reference))
    )
      context.addIssue({
        code: "custom",
        path: ["protectedInputReferences"],
        message: "protected references must exactly match protected fill references",
      });
    if (
      (["live_mutation", "protected_mutation"].includes(intent.authorization.kind) &&
        !intent.authorization.authorizationId) ||
      (intent.action.kind === "same_origin_request" &&
        intent.action.method !== "GET" &&
        (!intent.authorization.authorizationId || intent.authorization.kind !== "live_mutation"))
    )
      context.addIssue({
        code: "custom",
        path: ["authorization", "authorizationId"],
        message: "live mutation requires explicit authorization",
      });
    if (
      intent.action.kind === "acquire_protected_outputs" &&
      (intent.authorization.kind !== "protected_mutation" || !intent.authorization.authorizationId)
    )
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "protected output acquisition requires explicit protected-mutation authorization",
      });
    if (intent.action.kind === "acquire_protected_outputs" && intent.expectedEffect.kind !== "none")
      context.addIssue({
        code: "custom",
        path: ["expectedEffect"],
        message: "protected acquisition owns its effect lifecycle",
      });
    if (intent.action.kind === "acquire_protected_outputs") {
      const outputs = new Map(intent.action.outputs.map((output) => [output.reference, output]));
      const keys = new Set<string>();
      for (const [index, binding] of (intent.action.externalResourceBindings ?? []).entries()) {
        const key = `${binding.provider}\u0000${binding.resourceKind}\u0000${binding.resourceScope}`;
        if (keys.has(key))
          context.addIssue({
            code: "custom",
            path: ["action", "externalResourceBindings", index],
            message: "external resource binding declarations must be unique",
          });
        keys.add(key);
        if (
          binding.status === "active" &&
          outputs.get(binding.identityReference)?.classification !== "public"
        )
          context.addIssue({
            code: "custom",
            path: ["action", "externalResourceBindings", index, "identityReference"],
            message: "external resource identity must reference a public output",
          });
      }
      const resourceEffect = intent.action.resourceEffect;
      if (
        resourceEffect &&
        !(intent.action.externalResourceBindings ?? []).some(
          (binding) =>
            binding.provider === resourceEffect.provider &&
            binding.resourceKind === resourceEffect.resourceKind &&
            binding.resourceScope === resourceEffect.resourceScope,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["action", "resourceEffect"],
          message: "resource effect requires a matching external resource binding declaration",
        });
    }
    if (
      intent.action.kind === "fill" &&
      intent.action.protectedReferenceId &&
      !["authentication", "live_mutation"].includes(intent.authorization.kind)
    )
      context.addIssue({
        code: "custom",
        path: ["authorization", "kind"],
        message: "protected fills require authentication or live-mutation authorization",
      });
    if (intent.credentialLifecycle) {
      if (intent.action.kind !== "activate" && intent.action.kind !== "same_origin_request")
        context.addIssue({
          code: "custom",
          path: ["credentialLifecycle", "effect"],
          message: "credential revocation must be attached to an explicit activation or request",
        });
      if (
        !intent.authorization.authorizationId ||
        !["live_mutation", "protected_mutation"].includes(intent.authorization.kind)
      )
        context.addIssue({
          code: "custom",
          path: ["credentialLifecycle"],
          message: "credential lifecycle projection requires explicit mutation authorization",
        });
      if (
        new Set(intent.credentialLifecycle.credentialReferenceIds).size !==
        intent.credentialLifecycle.credentialReferenceIds.length
      )
        context.addIssue({
          code: "custom",
          path: ["credentialLifecycle", "credentialReferenceIds"],
          message: "credential lifecycle references must be unique",
        });
    }
    if (
      !intent.constraints.allowNonExact &&
      hasNonExactTarget(intent.action, intent.expectedEffect)
    )
      context.addIssue({
        code: "custom",
        path: ["constraints", "allowNonExact"],
        message: "non-exact matching requires explicit admission",
      });
    if (intent.expectedEffect.kind === "new_page" && !intent.constraints.allowNewPage)
      context.addIssue({
        code: "custom",
        path: ["constraints", "allowNewPage"],
        message: "new-page effects require explicit admission",
      });
  });

function hasNonExactTarget(
  action: z.infer<typeof missionAuthoringSemanticActionSchema>,
  effect: z.infer<typeof missionAuthoringSemanticEffectSchema>,
) {
  const targets = [
    "target" in action ? action.target : undefined,
    action.kind === "acquire_protected_outputs" ? action.mutation.target : undefined,
    ...(action.kind === "acquire_protected_outputs"
      ? action.outputs.map((output) => output.target)
      : []),
    "target" in effect ? effect.target : undefined,
  ];
  return targets.some((target) => target?.exact === false);
}

export const learnedInteractionRecordSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    interactionId: z.string().trim().min(1).max(200),
    stepId: z.string().trim().min(1).max(200).optional(),
    intent: safeRecordSchema,
    operation: safeRecordSchema,
    functionalResult: z.enum(["passed", "failed", "blocked", "inconclusive"]),
    mutationOutcome: z.enum(["not_started", "not_applied", "applied", "unknown"]),
    successfulEvidenceFamilies: z
      .array(
        z.enum([
          "native_control",
          "accessibility",
          "textual",
          "structural",
          "visual",
          "historical",
          "runtime",
          "effect",
        ]),
      )
      .max(8),
    scope: safeRecordSchema,
    relationships: z.array(safeRecordSchema).max(20).default([]),
    capabilityProfile: safeRecordSchema,
    expectedEffect: safeRecordSchema,
    adapterType: z
      .enum([
        "input_value",
        "text_content",
        "selected_text",
        "keyboard_copy",
        "copy_control",
        "clipboard_event",
        "download_content",
        "protected_network_value",
        "ocr_region",
      ])
      .optional(),
    sanitizedFingerprint: safeRecordSchema,
    qualityFindings: z.array(safeRecordSchema).max(100).default([]),
    usedSelectorHint: z.boolean().default(false),
    unresolvedMutation: z.boolean().default(false),
    veilPolicyViolated: z.boolean().default(false),
    veilEvidenceClosed: z.boolean(),
    ephemeralHandleExpiresAt: z.string().datetime().optional(),
    expectedEffectVerified: z.boolean().default(true),
    deterministic: z.boolean().default(true),
  })
  .strict();

export const compilationContractVersionSchema = z.enum(["v1-existing", "v2-learned-interactions"]);

export const compilationPublicationGateSchema = z
  .object({
    status: z.enum([
      "not_required",
      "certification_required",
      "certification_pending",
      "certified",
      "rejected",
    ]),
    certificationRunId: uuid.optional(),
    rejectionReasons: z.array(codeSchema).default([]),
    requiredOutcome: z.literal("application_pass").default("application_pass"),
  })
  .strict();

export const releaseGateMetricSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.enum([
      "authoring",
      "praxis",
      "compiler",
      "quality",
      "protected_acquisition",
      "certification",
      "publication",
    ]),
    value: z.number(),
    unit: z.enum(["count", "ratio", "ms"]).default("count"),
  })
  .strict();

export const browserRuntimeHealthSchema = z
  .object({
    observer: z.enum(["healthy", "degraded", "failed"]),
    accessibilityMapper: z.enum(["healthy", "degraded", "failed"]),
    geometryResolver: z.enum(["healthy", "degraded", "unavailable"]),
    ocr: z.enum(["healthy", "degraded", "unavailable"]),
    privacyInjection: z.enum(["healthy", "failed"]),
    runtimeHash: digest,
    capabilityManifestHash: digest,
    diagnostics: z
      .array(
        z
          .object({
            code: z.string(),
            subsystem: z.string(),
            message: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const createFlowDraftSchema = objectiveContextSchema
  .extend({
    projectId: uuid,
    environmentId: uuid,
    predecessorRunId: uuid.optional(),
    flowId: uuid.optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).default(""),
    purpose: flowDraftPurposeSchema.default("primary"),
    content: flowRevisionContentSchema,
    plan: currentPlanSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const updateFlowDraftSchema = objectiveContextSchema
  .extend({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2_000).optional(),
    content: flowRevisionContentSchema.optional(),
    plan: currentPlanSchema.optional(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const startProbeSessionSchema = objectiveContextSchema
  .extend({
    environmentId: uuid,
    draftVersion: z.number().int().positive(),
    mode: z.enum(["queued", "interactive"]).default("queued"),
    level: probeLevelSchema,
    disposableDataConfirmed: z.boolean().default(false),
    authorizationId: uuid.optional(),
    authenticationContractRevisionId: uuid.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.level === "calibration_transaction" &&
      (!value.disposableDataConfirmed || !value.authorizationId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authorizationId"],
        message:
          "Calibration transactions require explicit authorization and disposable-data confirmation.",
      });
    }
  });

export const compileFlowDraftSchema = objectiveContextSchema
  .extend({
    environmentId: uuid,
    draftVersion: z.number().int().positive(),
    probeSessionId: uuid.optional(),
    authoringSessionId: uuid.optional(),
    authenticationContractRevisionId: uuid.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const compileAndCertifyFlowSchema = compileFlowDraftSchema
  .extend({
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

export const publishFlowDraftSchema = objectiveContextSchema
  .extend({
    expectedVersion: z.number().int().positive(),
    visibility: z.enum(["reusable", "mission_local", "internal"]),
    purpose: z.enum([
      "primary",
      "setup",
      "acceptance",
      "diagnostic",
      "calibration",
      "reconciliation",
      "cleanup",
      "verification",
    ]),
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const authenticatedStateContractSchema = z
  .object({
    requiredSignals: z
      .array(
        z.enum([
          "login_response_success",
          "url_not_login",
          "login_form_absent",
          "authenticated_navigation_present",
          "portal_shell_present",
          "session_state_present",
        ]),
      )
      .min(1),
    optionalSignals: z
      .array(
        z.enum([
          "login_response_success",
          "url_not_login",
          "login_form_absent",
          "authenticated_navigation_present",
          "portal_shell_present",
          "session_state_present",
        ]),
      )
      .default([]),
    minimumRequiredSignals: z.number().int().positive(),
    stabilityWindowMs: z.number().int().min(100).max(30_000),
    timeoutMs: z.number().int().min(1_000).max(120_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumRequiredSignals > value.requiredSignals.length) {
      context.addIssue({
        code: "custom",
        path: ["minimumRequiredSignals"],
        message: "Required signal count exceeds configured required signals.",
      });
    }
  });

export const createAuthenticationContractSchema = objectiveContextSchema
  .extend({
    projectId: uuid,
    environmentId: uuid,
    applicationOrigin: z.string().url(),
    name: z.string().trim().min(1).max(200),
    entryUrl: z.string().url(),
    usernameTarget: z.record(z.string(), z.unknown()),
    passwordTarget: z.record(z.string(), z.unknown()),
    submissionMethods: z
      .array(
        z
          .object({
            kind: z.enum(["click", "press_enter", "request"]),
            target: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1),
    selectedMethodIndex: z.number().int().nonnegative(),
    success: authenticatedStateContractSchema,
    failureSignals: z.array(z.string().trim().min(1)).default([]),
    sessionReuse: z.enum(["never", "project_policy_opt_in"]).default("never"),
    expiresAt: z.string().datetime().optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export type CreateFlowDraftInput = z.input<typeof createFlowDraftSchema>;
export type MissionAuthoringSemanticTarget = z.infer<typeof missionAuthoringSemanticTargetSchema>;
export type MissionAuthoringIntent = z.infer<typeof missionAuthoringIntentSchema>;
export type UpdateFlowDraftInput = z.infer<typeof updateFlowDraftSchema>;
export type StartProbeSessionInput = z.infer<typeof startProbeSessionSchema>;
export type CompileFlowDraftInput = z.infer<typeof compileFlowDraftSchema>;
export type CompileAndCertifyFlowInput = z.infer<typeof compileAndCertifyFlowSchema>;
export type PublishFlowDraftInput = z.infer<typeof publishFlowDraftSchema>;
export type CreateAuthenticationContractInput = z.infer<typeof createAuthenticationContractSchema>;
export type ProbeAuthoringStatus = z.infer<typeof probeAuthoringStatusSchema>;
export type AuthoringBrowserLeaseState = z.infer<typeof authoringBrowserLeaseStateSchema>;
export type LearnedInteractionRecord = z.infer<typeof learnedInteractionRecordSchema>;
export type CompilationContractVersion = z.infer<typeof compilationContractVersionSchema>;
export type MissionAuthoringSemanticAction = z.infer<typeof missionAuthoringSemanticActionSchema>;
export type MissionAuthoringSemanticEffect = z.infer<typeof missionAuthoringSemanticEffectSchema>;
