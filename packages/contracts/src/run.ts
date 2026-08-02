import { z } from "zod";
import { praxisRunObservationSchema } from "./praxis.js";

export const runStateSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "finalizing",
  "passed",
  "failed",
  "cancelled",
  "timed_out",
  "infrastructure_error",
]);

export const artifactSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["screenshot", "trace", "video", "dom", "network", "report"]),
    availability: z.enum(["pending", "available", "incomplete", "quarantined", "destroyed", "failed"]),
    privacyClassification: z.enum(["safe", "sanitized", "uncertain"]),
    failureProvenance: z.enum(["executor", "privacy", "storage", "browser", "policy"]).optional(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    relativePath: z.string().min(1).optional(),
    observation: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const recordingTimelineEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("trace_segment"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    reason: z.enum(["run_started", "safe_resume"]),
    status: z.enum(["available", "quarantined", "failed"]),
    privacyStatus: z.enum(["verified_safe", "quarantined"]),
    artifactId: z.string().uuid().optional(),
    failureCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  }).strict(),
  z.object({
    type: z.literal("video_segment"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    pageId: z.string().min(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    reason: z.enum(["run_started", "safe_resume", "page_switch"]),
    status: z.enum(["available", "quarantined", "failed"]),
    privacyStatus: z.enum(["verified_safe", "quarantined"]),
    artifactId: z.string().uuid().optional(),
    failureCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  }).strict(),
  z.object({
    type: z.literal("protected_gap"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    operationId: z.string().min(1),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    reason: z.string().trim().min(1).max(500),
    privacyStatus: z.literal("capture_suppressed"),
  }).strict(),
  z.object({
    type: z.literal("unavailable_interval"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    failureCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }).strict(),
  z.object({
    type: z.literal("quarantine_record"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    channel: z.string().min(1),
    occurredAt: z.string().datetime(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    artifactId: z.string().uuid().optional(),
  }).strict(),
  z.object({
    type: z.literal("capture_epoch"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    epoch: z.number().int().positive(),
    contextId: z.string().uuid(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    startReason: z.enum(["run_started", "checkpoint_restored"]),
    endReason: z.enum(["run_completed", "checkpoint_context_destroyed", "sealed", "browser_lost"]),
    status: z.enum(["completed", "sealed"]),
  }).strict(),
  z.object({
    type: z.literal("checkpoint_boundary"),
    id: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    checkpointId: z.string().min(1),
    boundary: z.enum(["established", "context_destroyed", "restoring", "verified", "failed"]),
    occurredAt: z.string().datetime(),
    captureEpoch: z.number().int().positive(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    continuedAtStepId: z.string().min(1).optional(),
  }).strict(),
]);

export const recordingTimelineSchema = z.array(recordingTimelineEntrySchema).superRefine((entries, context) => {
  for (const [index, entry] of entries.entries()) {
    if (entry.sequence !== index) {
      context.addIssue({ code: "custom", message: "recording timeline sequence must be contiguous", path: [index, "sequence"] });
    }
    if ("endedAt" in entry && "startedAt" in entry && Date.parse(entry.endedAt) < Date.parse(entry.startedAt)) {
      context.addIssue({ code: "custom", message: "recording timeline entry ends before it starts", path: [index, "endedAt"] });
    }
  }
});

export const outcomeClassificationSchema = z.enum([
  "passed",
  "assertion_failure",
  "readiness_timeout",
  "transient_observation",
  "inconclusive_plan",
  "confirmed_product_failure",
  "non_reproduced_failure",
  "infrastructure_failure",
  "policy_failure",
  "execution_timeout",
  "cancelled",
]);

export const runEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    type: z.enum([
      "attempt.started",
      "step.started",
      "step.passed",
      "step.failed",
      "step.evidence_started",
      "step.readiness_started",
      "step.assertions_started",
      "privacy.state_changed",
      "privacy.operation_started",
      "privacy.operation_completed",
      "privacy.operation_failed",
      "privacy.credential_compromised",
      "checkpoint.established",
      "checkpoint.restored",
      "checkpoint.failed",
      "calibration.boundary_reached",
      "recording.segment_started",
      "recording.segment_stopped",
      "recording.gap_started",
      "recording.gap_ended",
      "recording.sealed",
      "policy.rejected",
      "artifact.created",
      "diagnostic.console",
      "diagnostic.page_error",
      "diagnostic.request_failed",
      "attempt.finalizing",
      "attempt.completed",
    ]),
    occurredAt: z.string().datetime(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const attemptResultSchema = z
  .object({
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    state: runStateSchema.extract([
      "passed",
      "failed",
      "cancelled",
      "timed_out",
      "infrastructure_error",
    ]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    requiredAssertions: z.object({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      unevaluated: z.number().int().nonnegative(),
    }),
    artifacts: z.array(artifactSchema),
  })
  .strict();

export type RunState = z.infer<typeof runStateSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type RecordingTimelineEntry = z.infer<typeof recordingTimelineEntrySchema>;
export const artifactTimelineSchema = recordingTimelineSchema;
export type ArtifactTimelineEntry = RecordingTimelineEntry;
export type OutcomeClassification = z.infer<typeof outcomeClassificationSchema>;

export const runObservationSectionStatusSchema = z.enum(["pending", "complete", "unavailable", "failed"]);

export const runObservationSchema = z.object({
  run: z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    environmentId: z.string().uuid(),
    flowRevisionId: z.string().uuid(),
    state: runStateSchema,
    phase: z.string().min(1),
    currentPhase: z.string().min(1),
    outcomeClassification: outcomeClassificationSchema.nullish(),
    planSnapshot: z.record(z.string(), z.unknown()),
    environmentSnapshot: z.record(z.string(), z.unknown()),
    policySnapshot: z.record(z.string(), z.unknown()),
    executionSnapshot: z.record(z.string(), z.unknown()),
    rerunOfRunId: z.string().uuid().nullish(),
    createdAt: z.union([z.string(), z.date()]),
    updatedAt: z.union([z.string(), z.date()]),
  }).passthrough(),
  attempts: z.array(z.object({
    id: z.string().uuid(), attemptNumber: z.number().int().positive(), state: z.string().min(1),
    startedAt: z.union([z.string(), z.date()]).nullish(), completedAt: z.union([z.string(), z.date()]).nullish(), error: z.string().nullish(),
  }).passthrough()),
  currentAttempt: z.object({
    id: z.string().uuid(), attemptNumber: z.number().int().positive(), state: z.string().min(1),
    startedAt: z.union([z.string(), z.date()]).nullish(), completedAt: z.union([z.string(), z.date()]).nullish(), error: z.string().nullish(),
  }).passthrough().nullish(),
  steps: z.array(z.object({
    attemptId: z.string().uuid(), stepId: z.string().min(1), title: z.string().min(1), ordinal: z.number().int().nonnegative(),
    action: z.object({ status: z.enum(["passed", "failed", "unevaluated"]), error: z.string().nullish() }),
    readiness: z.record(z.string(), z.unknown()).nullish(),
    assertions: z.array(z.object({ index: z.number().int().nonnegative(), type: z.string().min(1), status: z.enum(["passed", "failed", "unevaluated"]), error: z.string().nullish() })),
    assertionsSummary: z.record(z.string(), z.number()),
    evidence: z.array(z.record(z.string(), z.unknown())),
    startedAt: z.union([z.string(), z.date()]).nullish(), completedAt: z.union([z.string(), z.date()]).nullish(), durationMs: z.number().int().nonnegative().nullish(),
  })),
  events: z.array(z.object({ id: z.union([z.string(), z.number()]), attemptId: z.string().uuid(), sequence: z.number().int().nonnegative(), type: z.string(), payload: z.record(z.string(), z.unknown()), occurredAt: z.union([z.string(), z.date()]) })),
  artifacts: z.array(z.object({
    id: z.string().uuid(), attemptId: z.string().uuid(), stepId: z.string().nullish(), kind: z.string(),
    availability: z.enum(["pending", "available", "incomplete", "quarantined", "destroyed", "failed"]),
    privacyClassification: z.enum(["safe", "sanitized", "uncertain"]), failureProvenance: z.string().nullish(), reasonCode: z.string().nullish(),
    contentType: z.string(), sizeBytes: z.union([z.string(), z.number()]).nullish(), checksumSha256: z.string().nullish(),
    observation: z.record(z.string(), z.unknown()), resource: z.string().regex(/^scry:\/\/artifact\/[0-9a-f-]+$/).nullish(),
    createdAt: z.union([z.string(), z.date()]),
  })),
  artifactTimeline: artifactTimelineSchema,
  privacy: z.object({ intervals: z.array(z.record(z.string(), z.unknown())), operations: z.array(z.record(z.string(), z.unknown())), credentialIncidents: z.array(z.record(z.string(), z.unknown())) }),
  praxis: praxisRunObservationSchema.default({ contractVersion: 1, runtimeVersions: [], status: "complete", transactions: [], findings: [] }),
  failure: z.object({ provenance: z.enum(["product", "plan", "policy", "infrastructure", "privacy", "executor"]), code: z.string(), message: z.string().optional(), stepId: z.string().optional(), channel: z.string().optional() }).nullish(),
  sections: z.object({ attempts: runObservationSectionStatusSchema, steps: runObservationSectionStatusSchema, events: runObservationSectionStatusSchema, artifacts: runObservationSectionStatusSchema, timeline: runObservationSectionStatusSchema }),
  integrity: z.object({ status: z.enum(["complete", "partial", "failed"]), issues: z.array(z.object({ code: z.string(), message: z.string() })) }),
  safeActions: z.array(z.enum(["cancel", "rerun", "revise_flow", "read_artifact"])),
  release: z.object({ releaseId: z.string(), schemaFingerprint: z.string() }),
}).strict();

export type RunObservation = z.infer<typeof runObservationSchema>;
