import { z } from "zod";

export const browserProtectionSinkSchema = z.enum([
  "agent_observation",
  "mcp_response",
  "database_safe_field",
  "event",
  "report",
  "recording",
  "screenshot",
  "replay",
]);

export const browserDisclosureModeSchema = z.enum(["confidential", "trusted_application_output"]);

export const browserExecutionSessionStateSchema = z.enum([
  "starting",
  "active",
  "unknown",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
]);

export const browserEffectAuthorizationSchema = z.enum(["authentication", "business"]);
export const browserEffectDispatchStateSchema = z.enum([
  "not_started",
  "started",
  "acknowledged",
  "unknown",
]);
export const browserCaptureStateSchema = z.enum([
  "not_started",
  "durable",
  "unavailable",
  "expired",
  "corrupt",
]);
export const browserPublicationStateSchema = z.enum([
  "not_started",
  "published",
  "discarded",
  "failed",
]);
export const browserMutationOutcomeSchema = z.enum([
  "pending",
  "applied",
  "not_applied",
  "unknown",
]);

export const browserTargetReferenceSchema = z.object({
  frameId: z.string().min(1),
  elementReference: z.string().min(1),
});

export const browserCommitIntentSchema = z.object({
  runId: z.string().uuid(),
  browserSessionId: z.string().uuid(),
  ownerGeneration: z.number().int().nonnegative(),
  documentEpoch: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(256),
  authorization: browserEffectAuthorizationSchema,
  intentSummary: z.string().min(1).max(1_000),
  expectedOrigin: z
    .string()
    .url()
    .refine((value) => new URL(value).origin === value, {
      message: "expectedOrigin must contain only the URL origin",
    }),
  target: browserTargetReferenceSchema,
});

export const browserEffectTruthSchema = z
  .object({
    dispatch: browserEffectDispatchStateSchema,
    capture: browserCaptureStateSchema,
    publication: browserPublicationStateSchema,
    outcome: browserMutationOutcomeSchema,
  })
  .superRefine((truth, context) => {
    if (["published", "discarded"].includes(truth.publication) && truth.capture !== "durable") {
      context.addIssue({
        code: "custom",
        path: ["publication"],
        message: "settled output requires durable capture",
      });
    }
    if (truth.capture === "durable" && truth.dispatch !== "acknowledged") {
      context.addIssue({
        code: "custom",
        path: ["capture"],
        message: "durable response capture requires an acknowledged dispatch",
      });
    }
    if (truth.outcome === "applied" && truth.dispatch !== "acknowledged") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "an applied mutation requires acknowledged dispatch evidence",
      });
    }
    if (truth.outcome === "unknown" && truth.dispatch === "not_started") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "an undispatched mutation is not unknown",
      });
    }
  });

export const browserCaptureNodeSchema = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  kind: z.enum(["object", "array", "string", "number", "boolean", "null"]),
  classification: z.enum(["public", "protected", "uncertain"]),
  length: z.number().int().nonnegative().optional(),
  publicValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const browserCaptureReceiptSchema = z.object({
  captureId: z.string().uuid(),
  runId: z.string().uuid(),
  effectId: z.string().uuid(),
  phase: z.enum(["captured", "published", "discarded", "expired", "corrupt"]),
  status: z.number().int().min(100).max(599),
  contentType: z.string().min(1),
  contentClass: z.enum(["http_json", "http_text", "http_empty", "http_binary", "dom_region"]),
  bodyBytes: z.number().int().nonnegative(),
  redirectChain: z
    .array(
      z.object({
        status: z.number().int().min(300).max(399),
        sameOrigin: z.boolean(),
        targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(20)
    .default([]),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  structuralIndex: z.array(browserCaptureNodeSchema),
});

const browserOutputSelectionBaseSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1),
});
export const browserOutputSelectionSchema = z.discriminatedUnion("classification", [
  browserOutputSelectionBaseSchema.extend({ classification: z.literal("protected") }),
  browserOutputSelectionBaseSchema.extend({
    classification: z.literal("public"),
    semantic: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
  }),
]);

export const browserProtectionDecisionSchema = z
  .object({
    captureId: z.string().uuid(),
    effectId: z.string().uuid(),
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    label: z.enum(["protected", "public"]),
    allowedSinks: z.array(browserProtectionSinkSchema),
    valueDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decisionRevision: z.number().int().positive(),
    decisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().min(1).max(500),
    publicAdmissionMode: z.literal("trusted_application_output").optional(),
    publicSemantic: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)
      .optional(),
    publicEvidenceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    publicProposalDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((decision, context) => {
    const provenance = [
      decision.publicAdmissionMode,
      decision.publicSemantic,
      decision.publicEvidenceDigest,
      decision.publicProposalDigest,
    ];
    if (decision.label === "public" && provenance.some((value) => value === undefined))
      context.addIssue({ code: "custom", message: "public decision requires trusted provenance" });
    if (decision.label === "protected" && provenance.some((value) => value !== undefined))
      context.addIssue({
        code: "custom",
        message: "protected decision cannot carry public provenance",
      });
  });

export const browserPublishedOutputsSchema = z.object({
  captureId: z.string().uuid(),
  publicOutputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  protectedOutputs: z.record(
    z.string(),
    z.object({
      reference: z.string().uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  decisions: z.array(browserProtectionDecisionSchema).min(1).max(100),
});

export type BrowserExecutionSessionState = z.infer<typeof browserExecutionSessionStateSchema>;
export type BrowserDisclosureMode = z.infer<typeof browserDisclosureModeSchema>;
export type BrowserProtectionSink = z.infer<typeof browserProtectionSinkSchema>;
export type BrowserCommitIntent = z.infer<typeof browserCommitIntentSchema>;
export type BrowserEffectTruth = z.infer<typeof browserEffectTruthSchema>;
export type BrowserCaptureNode = z.infer<typeof browserCaptureNodeSchema>;
export type BrowserCaptureReceipt = z.infer<typeof browserCaptureReceiptSchema>;
export type BrowserOutputSelection = z.infer<typeof browserOutputSelectionSchema>;
export type BrowserProtectionDecision = z.infer<typeof browserProtectionDecisionSchema>;
export type BrowserPublishedOutputs = z.infer<typeof browserPublishedOutputsSchema>;
