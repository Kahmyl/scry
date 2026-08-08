import { z } from "zod";

const semanticText = z.string().trim().min(1).max(500);
const capabilitySchema = z.enum([
  "focusable",
  "pointer_activatable",
  "keyboard_activatable",
  "accepts_text",
  "editable",
  "toggleable",
  "selects_option",
  "submittable",
  "readable_value",
  "coordinate_action",
]);
export const evidenceFamilySchema = z.enum([
  "native_control",
  "accessibility",
  "textual",
  "structural",
  "visual",
  "historical",
  "runtime",
  "effect",
]);
const semanticRoleSchema = z.enum([
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "field",
  "form",
  "heading",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "region",
  "row",
  "tab",
  "table",
  "textbox",
  "text",
  "value",
]);
const semanticScopeKindSchema = z.enum([
  "page",
  "dialog",
  "form",
  "field_group",
  "table",
  "row",
  "region",
  "recently_changed",
]);
export type SemanticScopeInput = {
  kind: z.infer<typeof semanticScopeKindSchema>;
  name?: string | undefined;
  within?: SemanticScopeInput | undefined;
};
export const semanticScopeSchema: z.ZodType<SemanticScopeInput> = z.lazy(() =>
  z
    .object({
      kind: semanticScopeKindSchema,
      name: semanticText.optional(),
      within: semanticScopeSchema.optional(),
    })
    .strict(),
);

export const semanticRelationSchema = z
  .object({
    kind: z.enum([
      "labelled_by",
      "described_by",
      "contains",
      "belongs_to_field_group",
      "table_cell_of",
      "following",
      "nearby",
      "recently_created",
      "below",
      "right_of",
      "same_horizontal_band",
      "same_boundary",
    ]),
    concept: semanticText.optional(),
    name: semanticText.optional(),
  })
  .strict();
export const targetRiskSchema = z.enum([
  "read_only",
  "ordinary",
  "destructive",
  "authentication",
  "credential",
  "protected",
  "live",
]);
export const visualEvidenceSchema = z
  .object({
    sources: z
      .array(z.enum(["ocr", "icon", "geometry", "canvas"]))
      .min(1)
      .max(4),
    expectedText: semanticText.optional(),
    icon: z
      .enum([
        "add",
        "back",
        "check",
        "close",
        "copy",
        "delete",
        "download",
        "edit",
        "forward",
        "menu",
        "more",
        "search",
        "settings",
        "upload",
        "user",
      ])
      .optional(),
    protectedUse: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sources.includes("ocr") && !value.expectedText)
      context.addIssue({ code: "custom", message: "OCR evidence requires expectedText" });
    if (value.sources.includes("icon") && !value.icon)
      context.addIssue({ code: "custom", message: "icon evidence requires icon" });
    if (value.sources.includes("canvas") && !value.expectedText && !value.icon)
      context.addIssue({
        code: "custom",
        message: "canvas evidence requires expectedText or icon",
      });
  });

export const interactionTargetIntentSchema = z
  .object({
    concept: semanticText,
    requiredCapabilities: z.array(capabilitySchema).min(1).max(10),
    preferredEvidence: z
      .object({
        roles: z.array(semanticRoleSchema).max(10).default([]),
        names: z.array(semanticText).max(10).default([]),
        labels: z.array(semanticText).max(10).default([]),
        descriptions: z.array(semanticText).max(10).default([]),
        placeholders: z.array(semanticText).max(10).default([]),
        inputTypes: z.array(semanticText).max(10).default([]),
        expectedText: semanticText.optional(),
        visual: visualEvidenceSchema.optional(),
      })
      .strict(),
    scope: semanticScopeSchema.default({ kind: "page" }),
    relations: z.array(semanticRelationSchema).max(20).default([]),
    prohibited: z
      .array(z.enum(["hidden", "disabled", "readonly", "display_only_text"]))
      .max(4)
      .default(["hidden", "disabled"]),
    risk: targetRiskSchema.default("ordinary"),
    confidence: z
      .object({
        minimum: z.number().min(0).max(1).optional(),
        minimumMargin: z.number().min(0).max(1).optional(),
        requiredFamilies: z.array(evidenceFamilySchema).max(8).default([]),
        minimumFamilyCount: z.number().int().min(1).max(8).optional(),
      })
      .strict()
      .default({ requiredFamilies: [] }),
  })
  .strict()
  .superRefine((intent, context) => {
    const identity = intent.preferredEvidence;
    if (
      ![identity.names, identity.labels, identity.placeholders, identity.inputTypes].some(
        (items) => items.length,
      ) &&
      !identity.expectedText &&
      !identity.visual?.expectedText &&
      !identity.visual?.icon
    ) {
      context.addIssue({
        code: "custom",
        message: "interaction target requires observable identity evidence",
        path: ["preferredEvidence"],
      });
    }
    if (
      intent.requiredCapabilities.includes("accepts_text") &&
      !intent.requiredCapabilities.includes("focusable")
    )
      context.addIssue({
        code: "custom",
        message: "text entry requires focusable capability",
        path: ["requiredCapabilities"],
      });
    if (
      intent.requiredCapabilities.includes("coordinate_action") &&
      !intent.preferredEvidence.visual?.sources.includes("canvas")
    )
      context.addIssue({
        code: "custom",
        message: "coordinate action requires canvas visual evidence",
        path: ["preferredEvidence", "visual"],
      });
  });

export const controlCapabilitiesSchema = z
  .object({
    canFocus: z.boolean(),
    canReceivePointer: z.boolean(),
    canActivateWithKeyboard: z.boolean(),
    canAcceptText: z.boolean(),
    canToggle: z.boolean(),
    canSelectOption: z.boolean(),
    canSubmit: z.boolean(),
    canReadValue: z.boolean(),
    visible: z.boolean(),
    enabled: z.boolean(),
    editable: z.boolean(),
    readonly: z.boolean(),
    nativeKind: z.string().optional(),
    computedRole: z.string().optional(),
    accessibleName: z.string().optional(),
    placeholder: z.string().optional(),
    inputType: z.string().optional(),
    currentState: z.string().optional(),
  })
  .strict();
export const candidateEvidenceSchema = z
  .object({
    family: evidenceFamilySchema,
    signal: z.string().min(1).max(100),
    score: z.number().min(0).max(1),
    correlationGroup: z.string().min(1).max(100),
  })
  .strict();
export const visualAnchorSchema = z
  .object({
    text: z.string().max(500),
    bounds: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict(),
    confidence: z.number().min(0).max(1),
    source: z.enum(["ocr", "icon", "canvas"]),
  })
  .strict();
export const groundingCapabilityManifestSchema = z
  .object({
    browserObservationRuntime: z.literal("available"),
    semanticObserver: z.enum(["available", "unavailable"]),
    accessibilityMapping: z.enum(["available", "unavailable"]),
    ocr: z.enum(["available", "unavailable"]),
    geometry: z.enum(["available", "unavailable"]),
    shadowDom: z.enum(["available", "partial", "unavailable"]),
    visualCanvas: z.enum(["available", "unavailable"]),
    adapters: z.array(z.string()).default([]),
    runtimeHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const observationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      controlCount: z.number().int().nonnegative(),
      anchorCount: z.number().int().nonnegative(),
      channels: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      phase: z.enum(["serialization", "injection", "execution", "mapping", "timeout"]),
      reasonCode: z.string(),
      fallbackPermitted: z.boolean(),
    })
    .strict(),
]);
export const interactionAdapterSchema = z.enum([
  "native_fill",
  "native_click",
  "native_check",
  "native_select",
  "focus_keyboard",
  "content_editable",
  "application_adapter",
  "canvas_coordinate",
]);

export const expectedEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("navigation"),
      url: z.string().min(1).max(2_048).optional(),
      match: z.enum(["exact", "path", "contains"]).default("path"),
    })
    .strict(),
  z
    .object({
      type: z.literal("visibility_change"),
      target: interactionTargetIntentSchema,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("value_change"),
      target: interactionTargetIntentSchema,
      expected: z.string().max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("state_change"),
      target: interactionTargetIntentSchema,
      checked: z.boolean().optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("new_region"), target: interactionTargetIntentSchema }).strict(),
  z
    .object({
      type: z.literal("network_outcome"),
      urlPattern: semanticText,
      method: z.string().trim().min(1).max(20).optional(),
      statusMin: z.number().int().min(100).max(599).default(200),
      statusMax: z.number().int().min(100).max(599).default(399),
    })
    .strict(),
]);

export const acquisitionMethodSchema = z.enum([
  "dom_text",
  "input_value",
  "semantic_field_value",
  "text_content",
  "selected_text",
  "keyboard_copy",
  "copy_control",
  "clipboard_event",
  "scoped_text_selection",
  "focused_keyboard_selection",
  "download_content",
  "protected_network_value",
  "approved_network_field",
  "application_adapter",
  "ocr_region",
  "protected_visual_reading",
  "secure_user_assistance",
]);
export const protectedValueObjectiveSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("capture_value"),
      expectedValueType: z.enum(["public", "known_secret", "unknown_secret"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verify_user_copy_experience"),
      expectedValueType: z.enum(["public", "known_secret", "unknown_secret"]),
    })
    .strict(),
]);
export const acquisitionValidationSchema = z
  .object({
    minimumLength: z.number().int().min(1).max(100_000).default(1),
    maximumLength: z.number().int().min(1).max(100_000).default(20_000),
    pattern: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.minimumLength <= v.maximumLength, "minimumLength must not exceed maximumLength");
export const acquisitionIntentSchema = z
  .object({
    target: interactionTargetIntentSchema,
    classification: z.enum(["public", "known_secret", "unknown_secret"]),
    permittedMethods: z.array(acquisitionMethodSchema).min(1).max(10),
    objective: protectedValueObjectiveSchema.optional(),
    validation: acquisitionValidationSchema.default({ minimumLength: 1, maximumLength: 20_000 }),
    adapter: z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
        configuration: z.record(z.string(), z.unknown()).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export const semanticFingerprintSchema = z
  .object({
    version: z.literal(2),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    concept: semanticText,
    scopeKind: semanticScopeKindSchema,
    capabilityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    structuralPath: z.array(z.string().max(100)).max(20).default([]),
  })
  .strict();
export const acquisitionReadinessContractSchema = z
  .object({
    ceremonyIntent: interactionTargetIntentSchema,
    expectedContainerModel: semanticFingerprintSchema,
    valueIntent: interactionTargetIntentSchema,
    approvedMethods: z.array(acquisitionMethodSchema).min(1).max(10),
    minimumConfidence: z.number().min(0.5).max(1),
    minimumConfidenceMargin: z.number().min(0).max(1),
    recoveryPolicy: z.enum(["secure_assistance", "revoke", "hold_capsule", "abandon"]),
    recoveryWindowMs: z.number().int().min(1_000).max(900_000),
    revocationAdapterId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.recoveryPolicy === "revoke" && !v.revocationAdapterId)
      c.addIssue({ code: "custom", message: "revocation recovery requires an adapter" });
  });
export const groundingFailureCodeSchema = z.enum([
  "OBSERVATION_RUNTIME_UNAVAILABLE",
  "OBSERVATION_FAILED",
  "CONTROL_INVENTORY_EMPTY",
  "NO_CAPABILITY_COMPATIBLE_CONTROL",
  "INSUFFICIENT_EVIDENCE",
  "TARGET_AMBIGUOUS",
  "TARGET_NOT_ACTIONABLE",
  "TARGET_SCOPE_INVALID",
  "TARGET_CHANGED_BEFORE_ACTION",
  "INTERACTION_DISPATCH_FAILED",
  "LOCAL_STATE_NOT_OBSERVED",
  "EXPECTED_EFFECT_NOT_OBSERVED",
  "GROUNDING_DRIFT_REQUIRES_CALIBRATION",
  "FLOW_CAPABILITY_UNAVAILABLE",
  "ACQUISITION_NOT_READY",
  "ACQUISITION_UNRESOLVED",
  "RECOVERY_WINDOW_EXPIRED",
]);
export const driftClassificationSchema = z.enum([
  "unchanged",
  "compatible",
  "suspicious",
  "incompatible",
]);
export const protectedRecoveryCommandSchema = z
  .object({
    missionId: z.string().uuid(),
    objectiveId: z.string().uuid(),
    agentSessionId: z.string().uuid(),
    action: z.enum(["retry", "request_secure_assistance", "revoke", "abandon"]),
    correctedScope: semanticScopeSchema.optional(),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type InteractionTargetIntent = z.infer<typeof interactionTargetIntentSchema>;
export type ControlCapabilities = z.infer<typeof controlCapabilitiesSchema>;
export type CandidateEvidence = z.infer<typeof candidateEvidenceSchema>;
export type EvidenceFamily = z.infer<typeof evidenceFamilySchema>;
export type VisualAnchor = z.infer<typeof visualAnchorSchema>;
export type GroundingCapabilityManifest = z.infer<typeof groundingCapabilityManifestSchema>;
export type ObservationResult = z.infer<typeof observationResultSchema>;
export type InteractionAdapter = z.infer<typeof interactionAdapterSchema>;
export type SemanticScope = z.infer<typeof semanticScopeSchema>;
export type SemanticRelation = z.infer<typeof semanticRelationSchema>;
export type ExpectedEffect = z.infer<typeof expectedEffectSchema>;
export type AcquisitionIntent = z.infer<typeof acquisitionIntentSchema>;
export type AcquisitionMethod = z.infer<typeof acquisitionMethodSchema>;
export type AcquisitionReadinessContract = z.infer<typeof acquisitionReadinessContractSchema>;
export type SemanticFingerprint = z.infer<typeof semanticFingerprintSchema>;
export type GroundingFailureCode = z.infer<typeof groundingFailureCodeSchema>;
export type DriftClassification = z.infer<typeof driftClassificationSchema>;
export type ProtectedRecoveryCommand = z.infer<typeof protectedRecoveryCommandSchema>;
