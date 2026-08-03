import { z } from "zod";

export const VEIL_CONTRACT_VERSION = 1 as const;

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const origin = z.string().url().refine((value) => new URL(value).origin === value, "must be a canonical origin");

export const veilProfileSchema = z.enum(["balanced", "private", "minimal_capture", "custom"]);
export const veilEvidenceChannelSchema = z.enum([
  "screenshot", "video", "dom", "accessibility", "console", "page_error", "network",
  "event", "report", "metadata", "trace", "clipboard", "download",
]);
export const veilClassificationSchema = z.enum(["public", "sensitive", "secret", "unknown"]);
export const veilDispositionSchema = z.enum(["allow", "sanitize", "suppress", "quarantine"]);
export const veilOperationSchema = z.enum([
  "schedule", "observe", "interact", "protected_transaction", "capture", "admit_evidence",
]);
export const veilScopeSchema = z.enum(["operation", "channel", "document"]);

export const veilPolicyControlsSchema = z.object({
  screenshots: z.boolean(),
  video: z.boolean(),
  dom: z.boolean(),
  accessibility: z.boolean(),
  diagnostics: z.boolean(),
  network: z.boolean(),
  trace: z.boolean(),
  clipboard: z.boolean(),
  downloads: z.boolean(),
  maskSensitiveVisuals: z.literal(true),
  sanitizeStructuredEvidence: z.literal(true),
  quarantineUnknown: z.literal(true),
}).strict();

export const veilPolicyPreferencesSchema = z.object({
  profile: veilProfileSchema.default("balanced"),
  allowedOrigins: z.array(origin).min(1).max(100),
  controls: veilPolicyControlsSchema.partial().default({}),
  leaseTtlMs: z.number().int().min(100).max(60_000).default(5_000),
}).strict();

export const veilPolicySnapshotSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  profile: veilProfileSchema,
  allowedOrigins: z.array(origin).min(1).max(100),
  controls: veilPolicyControlsSchema,
  leaseTtlMs: z.number().int().min(100).max(60_000),
  digest,
}).strict();

export const veilContextSchema = z.object({
  userId: identifier,
  environmentId: identifier,
  transactionId: identifier,
  origin,
  browserContextId: identifier,
  pageId: identifier,
  frameId: identifier,
  documentEpoch: z.number().int().nonnegative(),
}).strict();

export const veilLeaseRequestSchema = z.object({
  context: veilContextSchema,
  operation: veilOperationSchema,
  channel: veilEvidenceChannelSchema,
  classification: veilClassificationSchema,
  scope: veilScopeSchema,
}).strict();

export const veilDecisionSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  decisionId: identifier,
  policyDigest: digest,
  disposition: veilDispositionSchema,
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  decidedAt: z.string().datetime(),
}).strict();

export const veilCapabilityLeaseSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  token: z.string().regex(/^veil_[A-Za-z0-9_-]{32,}$/),
  policyDigest: digest,
  expiresAt: z.string().datetime(),
}).strict();

export const veilVisualRegionSchema = z.object({
  regionId: identifier,
  classification: z.enum(["sensitive", "unknown"]),
  surface: z.enum(["editable", "aria_sensitive", "unclassified_text", "image", "css_image", "closed_shadow", "cross_origin_frame", "canvas", "svg", "video"]),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  masked: z.literal(true),
}).strict();

export const veilCapturePermitSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  token: z.string().regex(/^veil_capture_[A-Za-z0-9_-]{32,}$/),
  policyDigest: digest,
  contextDigest: digest,
  browserContextId: identifier,
  pageId: identifier,
  frameId: identifier,
  documentEpoch: z.number().int().nonnegative(),
  maskDigest: digest,
  regionCount: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const veilVideoSegmentPermitSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  token: z.string().regex(/^veil_video_[A-Za-z0-9_-]{32,}$/),
  segmentId: identifier,
  policyDigest: digest,
  contextDigest: digest,
  browserContextId: identifier,
  pageId: identifier,
  frameId: identifier,
  documentEpoch: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const veilVideoMaskCheckpointSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  segmentId: identifier,
  sequence: z.number().int().positive(),
  documentEpoch: z.number().int().nonnegative(),
  capturePermitDigest: digest,
  maskDigest: digest,
  previousCheckpointDigest: digest.nullable(),
  checkpointDigest: digest,
  observedAt: z.string().datetime(),
}).strict();

export const veilVideoSegmentFinalizationSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  segmentId: identifier,
  segmentPermitDigest: digest,
  policyDigest: digest,
  contextDigest: digest,
  documentEpoch: z.number().int().nonnegative(),
  checkpointCount: z.number().int().positive(),
  checkpointChainDigest: digest,
  finalizedAt: z.string().datetime(),
}).strict();

export const veilCollectorPhaseSchema = z.enum(["prepare", "suspend", "isolate", "resume", "seal", "finalize"]);
export const veilCollectorManifestSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  collectorId: identifier,
  channels: z.array(veilEvidenceChannelSchema).min(1),
  phases: z.array(veilCollectorPhaseSchema).min(1),
}).strict();
export const veilCollectorAcknowledgementSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  collectorId: identifier,
  phase: veilCollectorPhaseSchema,
  operationId: identifier.optional(),
  stateVersion: z.number().int().positive(),
  acknowledgedAt: z.string().datetime(),
}).strict();

export const veilRuntimeStateSchema = z.enum([
  "normal", "preparing", "suspended", "isolated", "protected", "resuming", "sealed", "finalized",
]);
export const veilRuntimeTransitionSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  sequence: z.number().int().positive(),
  from: veilRuntimeStateSchema,
  to: veilRuntimeStateSchema,
  operationId: identifier.optional(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  occurredAt: z.string().datetime(),
}).strict();

export const veilEvidenceManifestSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  evidenceId: identifier,
  channel: veilEvidenceChannelSchema,
  classification: veilClassificationSchema,
  disposition: veilDispositionSchema,
  policyDigest: digest,
  decisionId: identifier,
  transactionId: identifier.optional(),
  contentDigest: digest.optional(),
  omissionIntervals: z.array(z.object({ startMs: z.number().nonnegative(), endMs: z.number().nonnegative() }).refine((v) => v.endMs >= v.startMs)).default([]),
  createdAt: z.string().datetime(),
}).strict();

export const veilFailureSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  code: z.string().regex(/^VEIL_[A-Z0-9_]+$/),
  provenance: z.enum(["policy", "authority", "collector", "runtime", "evidence"]),
  retry: z.enum(["safe", "requires_reauthorization", "requires_new_context", "unsafe"]),
  message: z.string().max(500).optional(),
  collectorId: identifier.optional(),
}).strict();

export const veilPreferenceUpdateSchema = z.object({
  profile: veilProfileSchema.optional(),
  allowedOrigins: z.array(origin).min(1).max(100).optional(),
  controls: veilPolicyControlsSchema.partial().optional(),
  leaseTtlMs: z.number().int().min(100).max(60_000).optional(),
  reasonCode: z.enum(["VEIL_USER_REQUESTED_PRIVACY", "VEIL_AGENT_REQUESTED_PRIVACY", "VEIL_POLICY_REMEDIATION"]),
}).strict();

export const veilPreferenceRecordSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  environmentId: z.string().uuid(),
  preferences: veilPolicyPreferencesSchema,
  effectivePolicy: veilPolicySnapshotSchema,
  updatedAt: z.string().datetime(),
}).strict();

export const veilFindingSchema = z.object({
  code: z.string().regex(/^VEIL_[A-Z0-9_]+$/),
  severity: z.enum(["info", "warning", "blocking"]),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  channel: veilEvidenceChannelSchema.optional(),
  occurredAt: z.string().datetime().optional(),
  remediation: z.string().min(1).max(500),
}).strict();

export const veilRunObservationSchema = z.object({
  schemaVersion: z.literal(VEIL_CONTRACT_VERSION),
  effectiveProfile: veilProfileSchema,
  policyDigest: digest,
  status: z.enum(["pending", "verified", "degraded", "sealed"]),
  timeline: z.array(z.object({
    sequence: z.number().int().nonnegative(),
    type: z.enum(["transition", "gap", "disposition"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    channel: veilEvidenceChannelSchema.optional(),
  }).strict()),
  gaps: z.array(z.object({
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    remediation: z.string().min(1).max(500),
  }).strict()),
  findings: z.array(veilFindingSchema),
}).strict();

export type VeilProfile = z.infer<typeof veilProfileSchema>;
export type VeilEvidenceChannel = z.infer<typeof veilEvidenceChannelSchema>;
export type VeilClassification = z.infer<typeof veilClassificationSchema>;
export type VeilDisposition = z.infer<typeof veilDispositionSchema>;
export type VeilOperation = z.infer<typeof veilOperationSchema>;
export type VeilScope = z.infer<typeof veilScopeSchema>;
export type VeilPolicyControls = z.infer<typeof veilPolicyControlsSchema>;
export type VeilPolicyPreferences = z.input<typeof veilPolicyPreferencesSchema>;
export type VeilPolicySnapshot = z.infer<typeof veilPolicySnapshotSchema>;
export type VeilContext = z.infer<typeof veilContextSchema>;
export type VeilLeaseRequest = z.infer<typeof veilLeaseRequestSchema>;
export type VeilDecision = z.infer<typeof veilDecisionSchema>;
export type VeilCapabilityLease = z.infer<typeof veilCapabilityLeaseSchema>;
export type VeilVisualRegion = z.infer<typeof veilVisualRegionSchema>;
export type VeilCapturePermit = z.infer<typeof veilCapturePermitSchema>;
export type VeilVideoSegmentPermit = z.infer<typeof veilVideoSegmentPermitSchema>;
export type VeilVideoMaskCheckpoint = z.infer<typeof veilVideoMaskCheckpointSchema>;
export type VeilVideoSegmentFinalization = z.infer<typeof veilVideoSegmentFinalizationSchema>;
export type VeilCollectorPhase = z.infer<typeof veilCollectorPhaseSchema>;
export type VeilCollectorManifest = z.infer<typeof veilCollectorManifestSchema>;
export type VeilCollectorAcknowledgement = z.infer<typeof veilCollectorAcknowledgementSchema>;
export type VeilRuntimeState = z.infer<typeof veilRuntimeStateSchema>;
export type VeilRuntimeTransition = z.infer<typeof veilRuntimeTransitionSchema>;
export type VeilEvidenceManifest = z.infer<typeof veilEvidenceManifestSchema>;
export type VeilFailure = z.infer<typeof veilFailureSchema>;
export type VeilPreferenceUpdate = z.input<typeof veilPreferenceUpdateSchema>;
export type VeilPreferenceRecord = z.infer<typeof veilPreferenceRecordSchema>;
export type VeilFinding = z.infer<typeof veilFindingSchema>;
export type VeilRunObservation = z.infer<typeof veilRunObservationSchema>;
