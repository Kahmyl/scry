import { z } from "zod";

/** Stable, privacy-safe classification for agent-facing refusals. */
export const publicRejectionClassSchema = z.enum([
  "invalid_input",
  "stale_authority",
  "policy_authorization",
  "application_provider",
  "infrastructure_persistence",
  "reconciliation_unknown",
]);

export const agentResolutionClassSchema = z.enum([
  "correct_input",
  "refresh_authority",
  "obtain_authorization",
  "inspect_application",
  "restore_infrastructure",
  "reconcile_unknown",
  "manual_review",
]);

export const agentRetrySemanticsSchema = z.enum([
  "unspecified",
  "safe",
  "safe_to_retry",
  "safe_after_prerequisite",
  "safe_same_idempotency_key",
  "requires_authorization",
  "requires_new_context",
  "requires_reobservation",
  "requires_revision",
  "environment_recovery_required",
  "reconciliation_required",
  "retry_requires_reconciliation",
  "not_safe",
  "unsafe",
]);

export const mutationAppliedStateSchema = z.enum([
  "not_applicable",
  "not_started",
  "not_attempted",
  "not_applied",
  "applied",
  "unknown",
]);

export const exactAgentIdsSchema = z
  .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,99}Id$/), z.string().trim().min(1).max(200))
  .superRefine((value, context) => {
    if (Object.keys(value).length > 20)
      context.addIssue({ code: "custom", message: "too many exact identifiers" });
  });

const boundedActionSchema = z.string().trim().min(1).max(200);

export const agentResponseGuidanceSchema = z
  .object({
    code: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(500),
    exactIds: exactAgentIdsSchema,
    resolution: agentResolutionClassSchema,
    safeActions: z.array(boundedActionSchema).max(20),
    nextActions: z.array(boundedActionSchema).max(20),
    retry: agentRetrySemanticsSchema,
    appliedState: mutationAppliedStateSchema,
  })
  .strict()
  .superRefine(assertUnknownIsNotRetrySafe);

export const publicApiRejectionSchema = z
  .object({
    ...agentResponseGuidanceSchema.shape,
    status: z.number().int().min(400).max(599),
    rejectionClass: publicRejectionClassSchema,
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine(assertUnknownIsNotRetrySafe);

function assertUnknownIsNotRetrySafe(
  value: { appliedState: string; retry: string },
  context: z.RefinementCtx,
) {
  if (
    value.appliedState === "unknown" &&
    !["reconciliation_required", "retry_requires_reconciliation", "not_safe", "unsafe"].includes(
      value.retry,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["retry"],
      message: "unknown mutation truth cannot be retry-safe",
    });
}

export type PublicRejectionClass = z.infer<typeof publicRejectionClassSchema>;
export type AgentResolutionClass = z.infer<typeof agentResolutionClassSchema>;
export type AgentResponseGuidance = z.infer<typeof agentResponseGuidanceSchema>;
export type PublicApiRejection = z.infer<typeof publicApiRejectionSchema>;
