import { z } from "zod";
import { objectiveContextSchema } from "./mission.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const uuid = z.string().uuid();

export const calibrationSessionStateSchema = z.enum([
  "requested", "queued", "claimed", "preparing", "executing_preflight", "boundary_reached",
  "arming_privacy", "capsule_bootstrapping", "preparation_running", "preparation_verified", "executing_protected_transaction", "verifying_safe_exit", "scanning_channels",
  "attested", "failed", "cancelled", "expired", "sealed", "mutation_outcome_unknown",
]);

export const calibrationFailureProvenanceSchema = z.enum([
  "plan", "product", "policy", "credential", "privacy", "infrastructure", "cancelled", "timeout",
]);

export const requestCalibrationSchema = z.object({
  missionId: uuid,
  objectiveId: uuid,
  agentSessionId: uuid,
  name: z.string().trim().min(1).max(200),
  sourceFlowRevisionId: uuid,
  operationId: identifier,
  environmentId: uuid,
  disposableDataConfirmed: z.literal(true),
  confirmedUserAuthorized: z.literal(true),
  purpose: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const decideCalibrationSchema = objectiveContextSchema.extend({
  confirmedUserAuthorized: z.literal(true).optional(),
  reasonCode: identifier.optional(),
}).strict();

export const bindCalibrationSchema = z.object({
  missionId: uuid,
  objectiveId: uuid,
  agentSessionId: uuid,
  reason: z.string().trim().min(1).max(2_000),
  expectedRevisionId: uuid,
  environmentId: uuid,
  operationId: identifier,
  attestationId: uuid,
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const retryCalibrationSchema = objectiveContextSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();
export const cancelCalibrationSchema=objectiveContextSchema;

export const calibrationSafeActionSchema = z.enum([
  "inspect", "retry_preflight", "request_owner_approval", "approve_attestation", "reject_attestation",
  "bind_to_flow", "cancel", "create_new_revision", "manual_cleanup_required",
]);

export type RequestCalibrationInput = z.infer<typeof requestCalibrationSchema>;
export type BindCalibrationInput = z.infer<typeof bindCalibrationSchema>;
export type RetryCalibrationInput = z.infer<typeof retryCalibrationSchema>;
export type DecideCalibrationInput=z.infer<typeof decideCalibrationSchema>;
export type CancelCalibrationInput=z.infer<typeof cancelCalibrationSchema>;
export type CalibrationSessionState = z.infer<typeof calibrationSessionStateSchema>;
export type CalibrationFailureProvenance = z.infer<typeof calibrationFailureProvenanceSchema>;
