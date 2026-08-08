import { z } from "zod";

import { currentActionSchema, currentPlanSchema } from "./current.js";
import { expectedEffectSchema } from "./grounding.js";
import { executionPolicySchema } from "./policy.js";

const uuid = z.string().uuid();

export const executionKernelModeSchema = z.enum([
  "observe",
  "rehearse",
  "transact",
  "certify",
  "run",
]);

export const executionCapabilityNameSchema = z.enum([
  "browser",
  "praxis",
  "veil",
  "evidence",
  "journal",
  "protected_operations",
  "checkpoint",
  "calibration",
]);

export const executionCapabilityStateSchema = z.enum(["available", "policy_denied", "unavailable"]);

export const executionCapabilityManifestSchema = z
  .object({
    version: z.literal(1),
    mode: executionKernelModeSchema,
    correlationId: uuid,
    capabilities: z.record(
      executionCapabilityNameSchema,
      z
        .object({
          state: executionCapabilityStateSchema,
          reasonCode: z.string().trim().min(1).max(120).optional(),
        })
        .strict(),
    ),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const executionAdmissionFailureCodeSchema = z.enum([
  "EXECUTION_CAPABILITY_INCOMPLETE",
  "EXECUTION_CAPABILITY_BINDING_MISMATCH",
  "EXECUTION_CAPABILITY_DIGEST_MISMATCH",
  "EXECUTION_MODE_POLICY_DENIED",
  "EXECUTION_REQUEST_INVALID",
  "EXECUTION_MUTATION_IDENTITY_REQUIRED",
  "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
]);

export const executionAdmissionFailureSchema = z
  .object({
    code: executionAdmissionFailureCodeSchema,
    mode: executionKernelModeSchema,
    missingCapabilities: z.array(executionCapabilityNameSchema).default([]),
    safeActions: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict();

export const evidenceChannelOutcomeSchema = z
  .object({
    channel: z.enum(["screenshot", "video", "trace", "dom", "network", "console", "report"]),
    state: z.enum(["available", "suppressed", "quarantined", "failed"]),
    reasonCode: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const agentDecisionBoundarySchema = z
  .object({
    type: z.enum([
      "ambiguous_candidate",
      "authorization_required",
      "protected_input_required",
      "mutation_reconciliation_required",
      "policy_refused",
      "environment_unavailable",
      "objective_completed",
      "turn_budget_exhausted",
    ]),
    reasonCode: z.string().trim().min(1).max(120),
    safeActions: z.array(z.string().trim().min(1).max(120)).default([]),
    candidateDistinctions: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(240),
            distinction: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export const operationOutcomeSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
    functionalResult: z.enum(["succeeded", "failed", "inconclusive"]),
    mutationOutcome: z.enum(["not_applied", "applied", "unknown"]),
    privacyResult: z.enum(["verified", "unverified", "degraded", "sealed"]),
    evidenceResult: z.array(evidenceChannelOutcomeSchema),
    qualityFindings: z.array(z.record(z.string(), z.unknown())),
    durationMs: z.number().nonnegative(),
    reasonCode: z.string().trim().min(1).max(120).optional(),
    nextDecisionBoundary: agentDecisionBoundarySchema.optional(),
  })
  .strict();

export const executionRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    operationId: z.string().trim().min(1).max(200),
    correlationId: uuid,
    mode: executionKernelModeSchema,
    plan: currentPlanSchema,
    policy: executionPolicySchema,
    capabilityManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
    mutationIdentity: z.string().trim().min(8).max(200).optional(),
    semanticContext: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

const authoringTurnOperationSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
    action: currentActionSchema,
    expectedEffect: expectedEffectSchema,
  })
  .strict();

export const advanceAuthoringTurnPayloadSchema = z
  .object({
    correlationId: uuid.optional(),
    objectiveDelta: z.string().trim().min(1).max(4_000),
    operations: z.array(authoringTurnOperationSchema).min(1).max(20),
    authorization: z
      .object({
        mutationAllowed: z.boolean(),
        protectedOperationAllowed: z.boolean(),
      })
      .strict(),
    budgets: z
      .object({
        maxOperations: z.number().int().min(1).max(20),
        maxDurationMs: z.number().int().min(1_000).max(300_000),
        maxPreDispatchRetries: z.number().int().min(0).max(3).default(1),
      })
      .strict(),
    protectedInputReferences: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict()
  .superRefine((payload, context) => {
    const supplied = new Set(payload.protectedInputReferences);
    if (supplied.size !== payload.protectedInputReferences.length) {
      context.addIssue({
        code: "custom",
        path: ["protectedInputReferences"],
        message: "protected input references must be unique",
      });
    }
    const referenced = new Set<string>();
    for (const operation of payload.operations) {
      if (operation.action.type === "fill" && operation.action.secretRef) {
        referenced.add(operation.action.secretRef);
      }
      if (operation.action.type === "protectedTransaction") {
        for (const input of Object.values(operation.action.inputs)) {
          if (input.classification === "known_secret") referenced.add(input.credentialRef);
        }
      }
    }
    for (const reference of supplied) {
      if (!referenced.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["protectedInputReferences"],
          message: "unused protected input reference",
        });
      }
    }
    for (const reference of referenced) {
      if (!supplied.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["protectedInputReferences"],
          message: "operation protected reference must be declared",
        });
      }
    }
  });

export const advanceAuthoringTurnResultSchema = z
  .object({
    correlationId: uuid,
    operationsCompleted: z.array(operationOutcomeSchema),
    safeState: z
      .object({
        documentEpoch: z.number().int().nonnegative(),
        url: z.string().url(),
      })
      .strict(),
    decisionBoundary: agentDecisionBoundarySchema,
    timings: z.record(z.string(), z.number().nonnegative()),
    bytesReturned: z.number().int().nonnegative(),
  })
  .strict();

export const advanceAuthoringTurnCommandSchema = z
  .object({
    missionId: uuid,
    agentSessionId: uuid,
    payload: advanceAuthoringTurnPayloadSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export type ExecutionMode = z.infer<typeof executionKernelModeSchema>;
export type ExecutionCapabilityName = z.infer<typeof executionCapabilityNameSchema>;
export type ExecutionCapabilityManifest = z.infer<typeof executionCapabilityManifestSchema>;
export type ExecutionCapabilityBundle = ExecutionCapabilityManifest["capabilities"];
export type ExecutionAdmissionFailure = z.infer<typeof executionAdmissionFailureSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>;
export type AgentDecisionBoundary = z.infer<typeof agentDecisionBoundarySchema>;
export type AdvanceAuthoringTurnPayload = z.infer<typeof advanceAuthoringTurnPayloadSchema>;
export type AdvanceAuthoringTurnResult = z.infer<typeof advanceAuthoringTurnResultSchema>;
export type AdvanceAuthoringTurnCommand = z.infer<typeof advanceAuthoringTurnCommandSchema>;
