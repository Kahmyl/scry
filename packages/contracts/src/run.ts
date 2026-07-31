import { z } from "zod";

export const runStateSchema = z.enum([
  "draft",
  "queued",
  "preparing",
  "running",
  "awaiting_user",
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
    status: z.enum(["pending", "available", "missing", "failed", "expired"]),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    relativePath: z.string().min(1).optional(),
    observation: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

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
      "policy.rejected",
      "interaction.requested",
      "interaction.started",
      "interaction.return_rejected",
      "interaction.completed",
      "interaction.expired",
      "control.changed",
      "evidence.suspended",
      "evidence.resumed",
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
export type OutcomeClassification = z.infer<typeof outcomeClassificationSchema>;

export const browserControlStateSchema = z.enum([
  "agent",
  "handoff_pending",
  "user",
  "resuming",
]);

export type BrowserControlState = z.infer<typeof browserControlStateSchema>;
