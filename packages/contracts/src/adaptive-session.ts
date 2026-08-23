import { z } from "zod";

import { agentDecisionBoundarySchema, operationOutcomeSchema } from "./execution-kernel.js";
import { currentActionSchema } from "./current.js";
import { expectedEffectSchema } from "./grounding.js";
import { missionAuthoringIntentSchema } from "./authoring.js";

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
  "reconciliation_started",
  "reconciliation_completed",
  "operation_started",
  "operation_completed",
  "operation_failed",
  "decision_boundary_reached",
  "turn_started",
  "turn_completed",
  "flow_handoff_started",
  "flow_handoff_completed",
  "session_closed",
]);

export const missionAuthoringTurnBudgetsSchema = z
  .object({
    maxOperations: z.number().int().min(1).max(20),
    maxDurationMs: z.number().int().min(1_000).max(60_000),
  })
  .strict();

export const startAdaptiveSessionSchema = z
  .object({
    projectId: uuid,
    missionId: uuid,
    objectiveId: uuid,
    flowDraftId: uuid,
    environmentId: uuid,
    agentSessionId: uuid,
    objective: z.string().trim().min(1).max(4_000),
    allowedOrigins: z.array(z.string().url()).min(1).max(20),
    idempotencyKey: z.string().trim().min(8).max(200),
    correlationId: uuid.optional(),
    turnBudgets: missionAuthoringTurnBudgetsSchema.default({
      maxOperations: 20,
      maxDurationMs: 60_000,
    }),
    initialProtectedReferenceIds: z.array(uuid).max(20).default([]),
    protection: z.enum(["ordinary", "protected"]).default("ordinary"),
  })
  .strict();

/** @deprecated Internal compatibility schema. External callers must use MissionAuthoringIntent. */
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

/** @deprecated Internal compatibility schema retained until Packet C removes legacy runtime entrypoints. */
export const internalAdaptiveSessionTurnSchema = z
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

export const advanceAdaptiveSessionIntentsSchema = z
  .object({
    kind: z.literal("intents"),
    idempotencyKey: z.string().trim().min(8).max(200),
    intents: z.array(missionAuthoringIntentSchema).min(1).max(20),
    budgets: missionAuthoringTurnBudgetsSchema,
    recoveryBinding: agentDecisionBoundarySchema.shape.authoringRecovery.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.intents.length > input.budgets.maxOperations)
      context.addIssue({
        code: "custom",
        path: ["intents"],
        message: "intent count exceeds the turn budget",
      });
    if (new Set(input.intents.map((intent) => intent.intentId)).size !== input.intents.length)
      context.addIssue({
        code: "custom",
        path: ["intents"],
        message: "intent IDs must be unique within a turn",
      });
  });

export const continueAdaptiveSessionTurnSchema = z
  .object({
    kind: z.literal("continue"),
    idempotencyKey: z.string().trim().min(8).max(200),
    turnId: uuid,
    budgets: missionAuthoringTurnBudgetsSchema,
  })
  .strict();

export const reconcileAdaptiveOperationSchema = z
  .object({
    missionId: uuid,
    operationId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const adaptiveOperationReconciliationResultSchema = z
  .object({
    sessionId: uuid,
    operationId: z.string().trim().min(1).max(200),
    originalMutationOutcome: z.literal("unknown"),
    result: z.enum(["proven_applied", "proven_not_applied", "still_unknown"]),
    redispatchAllowed: z.literal(false),
    missionFenceCleared: z.boolean(),
    reasonCode: z.string().trim().min(1).max(120),
    replayed: z.boolean(),
    safeActions: z.array(z.string().trim().min(1).max(120)),
    requiresFreshIdempotencyKey: z.boolean(),
    nextAttemptId: uuid.optional(),
  })
  .strict();

export const praxisObservationSchema = z
  .object({
    documentEpoch: z.number().int().nonnegative(),
    url: z.string().url(),
    semanticPageContext: operationOutcomeSchema.shape.semanticPageContext.unwrap(),
  })
  .strict();

export const advanceAdaptiveSessionSchema = z.discriminatedUnion("kind", [
  advanceAdaptiveSessionIntentsSchema,
  continueAdaptiveSessionTurnSchema,
]);

export const missionAuthoringSemanticDeltaSchema = z
  .object({
    intentId: z.string().trim().min(1).max(200),
    state: z.enum(["completed", "failed", "skipped"]),
    effectVerified: z.boolean(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    functionalResult: z.enum(["succeeded", "failed", "inconclusive"]),
    mutationOutcome: z.enum(["not_applied", "applied", "unknown"]),
    /** Whether this semantic action entered a Veil-protected interval. */
    privacyApplicable: z.boolean(),
    privacyResult: z.enum(["verified", "unverified", "degraded", "sealed"]),
    evidence: z
      .object({
        state: z.enum(["available", "suppressed", "quarantined", "failed"]),
        count: z.number().int().nonnegative(),
        reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(8),
      })
      .strict(),
    semanticEvidence: z
      .object({
        count: z.number().int().min(0).max(1),
        resolvedTarget: operationOutcomeSchema.shape.resolvedTarget,
      })
      .strict()
      .default({ count: 0 }),
    semanticPageContext: operationOutcomeSchema.shape.semanticPageContext,
    quality: z
      .object({
        findingCount: z.number().int().nonnegative(),
        reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(8),
      })
      .strict(),
    generatedReferences: operationOutcomeSchema.shape.generatedReferences,
  })
  .strict();

const missionAuthoringChannelOutcomeSchema = z
  .object({
    state: z.enum(["passed", "failed", "unavailable", "not_applicable", "pending"]),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  })
  .strict();

export const missionAuthoringTurnResultSchema = z
  .object({
    turnId: uuid,
    state: z.enum(["completed", "decision_required", "pending"]),
    completed: z.array(missionAuthoringSemanticDeltaSchema).max(20),
    stateDelta: z
      .object({
        activeObjectiveId: uuid.optional(),
        activeFlowDraftId: uuid.optional(),
        url: z.string().url().optional(),
        documentEpoch: z.number().int().nonnegative().optional(),
      })
      .strict(),
    channels: z
      .object({
        functional: missionAuthoringChannelOutcomeSchema,
        mutation: missionAuthoringChannelOutcomeSchema,
        privacy: missionAuthoringChannelOutcomeSchema,
        evidence: missionAuthoringChannelOutcomeSchema,
        quality: missionAuthoringChannelOutcomeSchema,
      })
      .strict(),
    timings: z
      .object({
        resolveMs: z.number().int().nonnegative(),
        executeMs: z.number().int().nonnegative(),
        verifyMs: z.number().int().nonnegative(),
        journalMs: z.number().int().nonnegative(),
        totalMs: z.number().int().nonnegative(),
      })
      .strict(),
    decisionBoundary: agentDecisionBoundarySchema.nullable(),
    continuation: z
      .object({ turnId: uuid, phase: z.string().trim().min(1).max(100) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.state === "pending" && !result.continuation)
      context.addIssue({
        code: "custom",
        path: ["continuation"],
        message: "pending turns require a stable continuation",
      });
    if (result.state !== "pending" && result.continuation)
      context.addIssue({
        code: "custom",
        path: ["continuation"],
        message: "only pending turns may include a continuation",
      });
  });

/** @deprecated Legacy alias retained for internal callers until Packet C. */
export const advanceAdaptiveSessionTurnSchema = internalAdaptiveSessionTurnSchema;

export const adaptiveSessionTransitionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const closeAdaptiveSessionSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const recoverTrustedOriginsSchema = z
  .object({
    projectId: uuid,
    missionId: uuid,
    objectiveId: uuid,
    agentSessionId: uuid,
    sourceEnvironmentId: uuid,
    sourceFlowDraftId: uuid,
    sourceAuthoringSessionId: uuid,
    approvedOrigins: z.array(z.string().url()).min(1).max(20),
    approval: z
      .object({ kind: z.literal("explicit"), reason: z.string().trim().min(1).max(2_000) })
      .strict(),
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
    reconciliation: z
      .object({
        available: z.boolean(),
        redispatchAllowed: z.literal(false),
        result: z.enum(["proven_applied", "proven_not_applied", "still_unknown"]).nullable(),
        reasonCode: z.string().nullable(),
        safeAction: z.literal("reconcile_unknown_operation").nullable(),
      })
      .strict()
      .nullable()
      .default(null),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const adaptiveSessionSchema = z
  .object({
    id: uuid,
    projectId: uuid,
    missionId: uuid,
    objectiveId: uuid,
    flowDraftId: uuid,
    activeObjectiveId: uuid.optional(),
    activeFlowDraftId: uuid.optional(),
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
    linkedFlows: z
      .array(
        z
          .object({
            objectiveId: uuid,
            flowDraftId: uuid,
            purpose: z.enum([
              "setup",
              "primary",
              "acceptance",
              "diagnostic",
              "reconciliation",
              "cleanup",
            ]),
            sequence: z.number().int().positive(),
          })
          .strict(),
      )
      .default([]),
    latestTurn: missionAuthoringTurnResultSchema.nullable().default(null),
  })
  .strict();

export const praxisSessionStartResultSchema = adaptiveSessionSchema.extend({
  replayed: z.boolean(),
});

export const praxisSessionCloseResultSchema = z
  .object({
    id: uuid,
    state: z.literal("completed"),
    replayed: z.boolean(),
  })
  .strict();

export type AdaptiveSessionState = z.infer<typeof adaptiveSessionStateSchema>;
export type AdaptiveSessionEventType = z.infer<typeof adaptiveSessionEventTypeSchema>;
export type StartAdaptiveSessionInput = z.input<typeof startAdaptiveSessionSchema>;
export type MissionAuthoringAdvanceInput = z.infer<typeof advanceAdaptiveSessionSchema>;
export type MissionAuthoringTurnResult = z.infer<typeof missionAuthoringTurnResultSchema>;
/** @deprecated Internal compatibility type retained until Packet C. */
export type AdaptiveSessionOperationInput = z.infer<typeof adaptiveSessionOperationInputSchema>;
/** @deprecated Internal compatibility type retained until Packet C. */
export type AdvanceAdaptiveSessionInput =
  AdaptiveSessionOperationInput | z.infer<typeof internalAdaptiveSessionTurnSchema>;
export type AdaptiveSessionTransitionInput = z.infer<typeof adaptiveSessionTransitionSchema>;
export type CloseAdaptiveSessionInput = z.infer<typeof closeAdaptiveSessionSchema>;
export type RecoverTrustedOriginsInput = z.infer<typeof recoverTrustedOriginsSchema>;
export type ReconcileAdaptiveOperationInput = z.infer<typeof reconcileAdaptiveOperationSchema>;
export type AdaptiveOperationReconciliationResult = z.infer<
  typeof adaptiveOperationReconciliationResultSchema
>;
export type PraxisObservation = z.infer<typeof praxisObservationSchema>;
export type AdaptiveSession = z.infer<typeof adaptiveSessionSchema>;
export type PraxisSessionStartResult = z.infer<typeof praxisSessionStartResultSchema>;
export type PraxisSessionCloseResult = z.infer<typeof praxisSessionCloseResultSchema>;
