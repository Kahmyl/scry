import { z } from "zod";

import { flowRevisionContentSchema } from "./api.js";
import { currentPlanSchema } from "./current.js";
import { objectiveContextSchema } from "./mission.js";

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
    flowId: uuid.optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).default(""),
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
    compilationId: uuid,
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

export type CreateFlowDraftInput = z.infer<typeof createFlowDraftSchema>;
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
