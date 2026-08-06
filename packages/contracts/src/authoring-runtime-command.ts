import { z } from "zod";

const uuid = z.string().uuid();

export const authoringRuntimeCommandTypeSchema = z.enum([
  "observe_document",
]);

export const authoringRuntimeCommandStateSchema = z.enum([
  "pending",
  "claimed",
  "completed",
  "failed",
  "cancelled",
]);

export const authoringRuntimeCommandOutcomeSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
]);

export const createAuthoringRuntimeCommandSchema = z
  .object({
    missionId: uuid,
    agentSessionId: uuid,
    type: authoringRuntimeCommandTypeSchema,
    payload: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const claimedAuthoringRuntimeCommandSchema = z
  .object({
    id: uuid,
    probeSessionId: uuid,
    browserLeaseId: uuid,
    type: authoringRuntimeCommandTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    claimToken: uuid,
  })
  .strict();

export const authoringRuntimeCommandResultSchema = z
  .object({
    commandId: uuid,
    probeSessionId: uuid,
    outcome: authoringRuntimeCommandOutcomeSchema,
    safeResult: z.record(z.string(), z.unknown()).nullable(),
    safeError: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.outcome === "completed" &&
      (value.safeResult === null || value.safeError !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["safeResult"],
        message: "Completed commands require only a safe result.",
      });
    }

    if (
      value.outcome === "failed" &&
      (value.safeResult !== null || value.safeError === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["safeError"],
        message: "Failed commands require only a safe error.",
      });
    }

    if (
      value.outcome === "cancelled" &&
      value.safeResult !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["safeResult"],
        message: "Cancelled commands cannot contain a result.",
      });
    }
  });

export type AuthoringRuntimeCommandType = z.infer<
  typeof authoringRuntimeCommandTypeSchema
>;

export type AuthoringRuntimeCommandState = z.infer<
  typeof authoringRuntimeCommandStateSchema
>;

export type AuthoringRuntimeCommandOutcome = z.infer<
  typeof authoringRuntimeCommandOutcomeSchema
>;

export type CreateAuthoringRuntimeCommandInput = z.infer<
  typeof createAuthoringRuntimeCommandSchema
>;

export type ClaimedAuthoringRuntimeCommand = z.infer<
  typeof claimedAuthoringRuntimeCommandSchema
>;

export type AuthoringRuntimeCommandResult = z.infer<
  typeof authoringRuntimeCommandResultSchema
>;
