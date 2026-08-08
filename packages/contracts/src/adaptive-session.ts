import { z } from "zod";

import { agentDecisionBoundarySchema, operationOutcomeSchema } from "./execution-kernel.js";
import { currentActionSchema } from "./current.js";
import { expectedEffectSchema } from "./grounding.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const adaptiveSessionStateSchema = z.enum([
  "created",
  "provisioning",
  "active",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "recovery_required",
]);

export const adaptiveSessionEventTypeSchema = z.enum([
  "session_created",
  "provisioning_started",
  "session_activated",
  "session_suspended",
  "session_resumed",
  "session_completed",
  "session_failed",
  "session_cancelled",
  "recovery_required",
  "operation_started",
  "operation_completed",
  "operation_failed",
  "decision_boundary_reached",
]);

export const startAdaptiveSessionSchema = z
  .object({
    projectId: uuid,
    environmentId: uuid,
    objective: z.string().trim().min(1).max(4_000),
    allowedOrigins: z.array(z.string().url()).min(1).max(20),
    idempotencyKey: z.string().trim().min(8).max(200),
    correlationId: uuid.optional(),
    controlPlaneLink: z
      .object({
        missionId: uuid.optional(),
        objectiveId: uuid.optional(),
        flowDraftId: uuid.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const adaptiveSessionOperationInputSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(200),
    action: currentActionSchema,
    expectedEffect: expectedEffectSchema,
    mode: z.enum(["observe", "rehearse", "transact", "certify", "run"]),
    protectedInputReferences: z.array(uuid).max(20).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const referenced = new Set<string>();
    if (input.action.type === "fill" && input.action.secretRef) {
      referenced.add(input.action.secretRef);
    }
    if (input.action.type === "protectedTransaction") {
      for (const protectedInput of Object.values(input.action.inputs)) {
        if (protectedInput.classification === "known_secret") {
          referenced.add(protectedInput.credentialRef);
        }
      }
    }
    const supplied = new Set(input.protectedInputReferences);
    if (
      supplied.size !== input.protectedInputReferences.length ||
      [...referenced].some((reference) => !supplied.has(reference)) ||
      [...supplied].some((reference) => !referenced.has(reference))
    ) {
      context.addIssue({
        code: "custom",
        path: ["protectedInputReferences"],
        message: "protected input references must exactly match the typed action",
      });
    }
  });

export const advanceAdaptiveSessionTurnSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
    operations: z.array(adaptiveSessionOperationInputSchema).min(1).max(20),
    budgets: z
      .object({
        maxOperations: z.number().int().min(1).max(20),
        maxDurationMs: z.number().int().min(1_000).max(300_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operations.length > input.budgets.maxOperations) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "operation count exceeds the turn budget",
      });
    }
    const ids = new Set(input.operations.map((operation) => operation.operationId));
    const keys = new Set(input.operations.map((operation) => operation.idempotencyKey));
    if (ids.size !== input.operations.length || keys.size !== input.operations.length) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "operation IDs and idempotency keys must be unique within a turn",
      });
    }
  });

export const advanceAdaptiveSessionSchema = z.union([
  adaptiveSessionOperationInputSchema,
  advanceAdaptiveSessionTurnSchema,
]);

export const adaptiveSessionTransitionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const adaptiveSessionOperationSchema = z
  .object({
    operationId: z.string(),
    sequence: z.number().int().positive(),
    mode: z.enum(["observe", "rehearse", "transact", "certify", "run"]),
    state: z.enum(["pending", "running", "completed", "failed"]),
    action: currentActionSchema,
    expectedEffect: z.record(z.string(), z.unknown()),
    observationEpoch: z.number().int().nonnegative().nullable(),
    candidateDecisionDigest: digest.nullable(),
    capabilityManifestDigest: digest.nullable(),
    dispatchBoundary: z.enum(["not_dispatched", "dispatching", "dispatched", "acknowledged"]),
    outcome: operationOutcomeSchema.nullable(),
    decisionBoundary: agentDecisionBoundarySchema.nullable(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const adaptiveSessionSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    environmentId: uuid,
    correlationId: uuid,
    state: adaptiveSessionStateSchema,
    version: z.number().int().positive(),
    objective: z.string(),
    allowedOrigins: z.array(z.string().url()),
    decisionBoundary: agentDecisionBoundarySchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    operations: z.array(adaptiveSessionOperationSchema),
    events: z.array(
      z
        .object({
          sequence: z.number().int().positive(),
          type: adaptiveSessionEventTypeSchema,
          safeFacts: z.record(z.string(), z.unknown()),
          occurredAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export type AdaptiveSessionState = z.infer<typeof adaptiveSessionStateSchema>;
export type AdaptiveSessionEventType = z.infer<typeof adaptiveSessionEventTypeSchema>;
export type StartAdaptiveSessionInput = z.infer<typeof startAdaptiveSessionSchema>;
export type AdaptiveSessionOperationInput = z.infer<typeof adaptiveSessionOperationInputSchema>;
export type AdvanceAdaptiveSessionInput = z.infer<typeof advanceAdaptiveSessionSchema>;
export type AdaptiveSessionTransitionInput = z.infer<typeof adaptiveSessionTransitionSchema>;
export type AdaptiveSession = z.infer<typeof adaptiveSessionSchema>;
