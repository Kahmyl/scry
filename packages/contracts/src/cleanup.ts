import { z } from "zod";

export const cleanupDecisionSchema = z.strictObject({
  kind: z.enum(["resource", "credential"]),
  itemId: z.uuid(),
  decision: z.enum(["retain", "close", "revoke"]),
  reason: z.enum([
    "testing_finished",
    "user_selected_retention",
    "shared_preexisting",
    "needed_for_recovery",
  ]),
  confirmed: z.literal(true),
  idempotencyKey: z.string().min(8).max(128),
});
export type CleanupDecision = z.infer<typeof cleanupDecisionSchema>;
