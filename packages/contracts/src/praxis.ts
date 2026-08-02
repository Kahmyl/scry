import { z } from "zod";

import { evidenceFamilySchema, expectedEffectSchema, interactionAdapterSchema, interactionTargetIntentSchema, driftClassificationSchema } from "./grounding.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const code = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeText = z.string().trim().min(1).max(2_000);
const expectedEffectTypeSchema = z.enum(["none", "navigation", "visibility_change", "value_change", "state_change", "new_region", "network_outcome"]);

export const praxisPhaseSchema = z.enum([
  "created", "observing", "grounding", "resolved", "revalidating", "dispatching",
  "verifying_local", "verifying_effect", "succeeded", "failed", "cancelled", "inconclusive",
]);
export const praxisFailureProvenanceSchema = z.enum(["application", "intent", "praxis", "policy", "privacy", "environment", "infrastructure", "cancelled"]);
export const praxisMutationOutcomeSchema = z.enum(["not_started", "not_applied", "applied", "unknown"]);
export const praxisRetryDispositionSchema = z.enum(["safe", "unsafe", "requires_reobservation", "requires_revision"]);
export const praxisSafeActionSchema = z.enum([
  "retry_after_render", "reobserve", "narrow_scope", "revise_intent", "request_calibration",
  "use_supported_capability", "install_or_update_adapter", "request_user_assistance",
  "request_authorization", "fix_application_semantics", "check_environment",
  "check_executor_health", "inspect_artifact", "do_not_retry",
]);
export const praxisOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activate") }).strict(),
  z.object({ type: z.literal("enter_text"), input: z.object({ reference: identifier, classification: z.enum(["public", "known_secret", "captured_secret", "captured_public"]) }).strict() }).strict(),
  z.object({ type: z.literal("select_option"), input: z.object({ reference: identifier, classification: z.literal("public") }).strict() }).strict(),
  z.object({ type: z.literal("set_checked"), checked: z.boolean() }).strict(),
  z.object({ type: z.literal("press_key"), key: z.enum(["Enter", "Space", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) }).strict(),
  z.object({ type: z.literal("read_value"), classification: z.enum(["public", "known_secret", "unknown_secret"]), permittedMethods: z.array(identifier).min(1).max(10) }).strict(),
  z.object({ type: z.literal("wait_for_state"), state: z.enum(["visible", "hidden", "attached", "detached", "enabled", "disabled"]) }).strict(),
  z.object({ type: z.literal("inspect") }).strict(),
  z.object({ type: z.literal("scroll"), direction: z.enum(["into_view", "up", "down", "left", "right"]) }).strict(),
]);
export const praxisTimingSchema = z.object({
  queuedMs: z.number().nonnegative().nullable(), observationMs: z.number().nonnegative().nullable(),
  groundingMs: z.number().nonnegative().nullable(), revalidationMs: z.number().nonnegative().nullable(),
  dispatchMs: z.number().nonnegative().nullable(), localVerificationMs: z.number().nonnegative().nullable(),
  effectVerificationMs: z.number().nonnegative().nullable(), totalMs: z.number().nonnegative(),
  escalationLevel: z.number().int().min(0).max(5).nullable(),
  providerTimings: z.array(z.object({ provider: identifier, durationMs: z.number().nonnegative(), outcome: identifier }).strict()).max(100),
}).strict();
export const praxisQualityFindingSchema = z.object({
  code, severity: z.enum(["info", "warning", "error"]), confidence: z.number().min(0).max(1),
  summary: safeText, remediation: safeText, evidence: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),
}).strict();
export const praxisTargetIdentitySchema = z.object({
  fingerprint: digest, concept: z.string().trim().min(1).max(500), scopeKind: identifier,
  capabilityDigest: digest, runtimeIdentity: digest.optional(),
}).strict();
export const praxisResolutionSchema = z.object({
  target: praxisTargetIdentitySchema, confidence: z.number().min(0).max(1), runnerUpMargin: z.number().min(0).max(1),
  evidenceFamilies: z.array(evidenceFamilySchema).max(8), drift: driftClassificationSchema, strategy: interactionAdapterSchema,
}).strict();
export const praxisVerificationSchema = z.object({
  local: z.enum(["passed", "not_required", "failed", "unknown"]), effect: z.enum(["passed", "not_required", "failed", "unknown"]),
  effectType: expectedEffectTypeSchema,
}).strict();
export const praxisAgentReportSchema = z.object({
  schemaVersion: z.literal(1), transactionId: identifier, operationId: identifier, stepId: identifier.optional(),
  outcome: z.enum(["succeeded", "failed", "inconclusive", "cancelled"]), summary: safeText,
  classification: z.object({ provenance: z.union([praxisFailureProvenanceSchema, z.literal("none")]), code: code.optional(), mutationOutcome: praxisMutationOutcomeSchema }).strict(),
  intentDigest: digest, resolution: praxisResolutionSchema.optional(), verification: praxisVerificationSchema,
  timing: praxisTimingSchema, qualityFindings: z.array(praxisQualityFindingSchema).max(100), safeActions: z.array(praxisSafeActionSchema).max(20),
  artifactRefs: z.array(z.string().regex(/^scry:\/\/artifact\/[0-9a-f-]+$/)).max(100),
}).strict();
export const praxisRequestSchema = z.object({
  schemaVersion: z.literal(1), transactionId: identifier, operationId: identifier, stepId: identifier.optional(),
  intent: interactionTargetIntentSchema, operation: praxisOperationSchema, expectedEffect: expectedEffectSchema,
  risk: z.enum(["read_only", "ordinary", "destructive", "authentication", "credential", "protected", "live"]),
  policy: z.object({ allowedOrigins: z.array(z.string().url()).min(1).max(100), actionTimeoutMs: z.number().int().min(100).max(60_000), totalTimeoutMs: z.number().int().min(100).max(120_000) }).strict(),
  privacy: z.object({ state: identifier, allowedChannels: z.array(identifier).max(50), suppressedChannels: z.array(identifier).max(50) }).strict(),
  context: z.object({ runId: identifier.optional(), attemptId: identifier.optional(), pageId: identifier, origin: z.string().url(), documentEpoch: z.number().int().nonnegative() }).strict(),
}).strict();

const praxisSuccessBaseSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("succeeded"), transactionId: identifier,
  operationId: identifier, stepId: identifier.optional(), phase: z.literal("succeeded"),
  mutationOutcome: praxisMutationOutcomeSchema, resolution: praxisResolutionSchema,
  verification: praxisVerificationSchema, timing: praxisTimingSchema,
  qualityFindings: z.array(praxisQualityFindingSchema).max(100), report: praxisAgentReportSchema,
}).strict();
export const praxisSuccessSchema = praxisSuccessBaseSchema.superRefine((value, context) => {
  if (value.report.outcome !== "succeeded") context.addIssue({ code: "custom", message: "success report outcome must be succeeded", path: ["report", "outcome"] });
});
const praxisFailureBaseSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["failed", "cancelled", "inconclusive"]), transactionId: identifier,
  operationId: identifier, stepId: identifier.optional(), phase: praxisPhaseSchema,
  code, provenance: praxisFailureProvenanceSchema, retry: praxisRetryDispositionSchema,
  mutationOutcome: praxisMutationOutcomeSchema, timing: praxisTimingSchema,
  diagnostics: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
  qualityFindings: z.array(praxisQualityFindingSchema).max(100), safeActions: z.array(praxisSafeActionSchema).max(20), report: praxisAgentReportSchema,
}).strict();
export const praxisFailureSchema = praxisFailureBaseSchema.superRefine((value, context) => {
  if (value.mutationOutcome === "unknown" && value.retry === "safe") context.addIssue({ code: "custom", message: "unknown mutation outcome cannot be retry-safe", path: ["retry"] });
  if (value.status === "cancelled" && value.provenance !== "cancelled") context.addIssue({ code: "custom", message: "cancelled result requires cancelled provenance", path: ["provenance"] });
  if (value.report.outcome !== value.status) context.addIssue({ code: "custom", message: "report outcome must match result status", path: ["report", "outcome"] });
});
export const praxisResultSchema = z.union([praxisSuccessSchema, praxisFailureSchema]);
export const praxisLifecycleEventSchema = z.object({
  schemaVersion: z.literal(1), transactionId: identifier, operationId: identifier,
  type: z.enum(["praxis.transaction_started", "praxis.phase_changed", "praxis.observation_completed", "praxis.resolved", "praxis.rejected", "praxis.dispatch_started", "praxis.dispatch_completed", "praxis.verification_completed", "praxis.transaction_succeeded", "praxis.transaction_failed", "praxis.quality_finding"]),
  phase: praxisPhaseSchema, occurredAt: z.string().datetime(), payload: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
}).strict();
export const praxisDurableTransactionSchema = z.object({
  transactionId: identifier, operationId: identifier, stepId: identifier.nullish(), schemaVersion: z.literal(1), runtimeVersion: identifier,
  result: praxisResultSchema, startedAt: z.string().datetime(), completedAt: z.string().datetime().nullish(),
}).strict();
export const praxisDurableQualityFindingSchema = z.object({
  id: identifier, transactionId: identifier, stepId: identifier.nullish(), intentDigest: digest,
  finding: praxisQualityFindingSchema, artifactRefs: z.array(z.string().regex(/^scry:\/\/artifact\/[0-9a-f-]+$/)).max(100), createdAt: z.string().datetime(),
}).strict();
export const praxisRunObservationSchema = z.object({
  contractVersion: z.literal(1), runtimeVersions: z.array(identifier).max(20), status: z.enum(["pending", "complete", "unavailable", "failed"]),
  transactions: z.array(praxisDurableTransactionSchema).max(10_000), findings: z.array(praxisDurableQualityFindingSchema).max(10_000),
}).strict();

export type PraxisPhase = z.infer<typeof praxisPhaseSchema>;
export type PraxisFailureProvenance = z.infer<typeof praxisFailureProvenanceSchema>;
export type PraxisMutationOutcome = z.infer<typeof praxisMutationOutcomeSchema>;
export type PraxisRetryDisposition = z.infer<typeof praxisRetryDispositionSchema>;
export type PraxisSafeAction = z.infer<typeof praxisSafeActionSchema>;
export type PraxisOperation = z.infer<typeof praxisOperationSchema>;
export type PraxisTiming = z.infer<typeof praxisTimingSchema>;
export type PraxisQualityFinding = z.infer<typeof praxisQualityFindingSchema>;
export type PraxisAgentReport = z.infer<typeof praxisAgentReportSchema>;
export type PraxisRequest = z.infer<typeof praxisRequestSchema>;
export type PraxisSuccess = z.infer<typeof praxisSuccessSchema>;
export type PraxisFailure = z.infer<typeof praxisFailureSchema>;
export type PraxisResult = z.infer<typeof praxisResultSchema>;
export type PraxisResolution = z.infer<typeof praxisResolutionSchema>;
export type PraxisVerification = z.infer<typeof praxisVerificationSchema>;
export type PraxisLifecycleEvent = z.infer<typeof praxisLifecycleEventSchema>;
export type PraxisDurableTransaction = z.infer<typeof praxisDurableTransactionSchema>;
export type PraxisDurableQualityFinding = z.infer<typeof praxisDurableQualityFindingSchema>;
export type PraxisRunObservation = z.infer<typeof praxisRunObservationSchema>;
