import { z } from "zod";
import { startBrowserRunSchema } from "./browser-lifecycle.js";

/** Bounded JSON, including direct in-process callers rather than HTTP JSON alone. */
const completionCriteria = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const pending: Array<[unknown, number]> = [[value, 0]],
    seen = new Set<object>();
  let count = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (
      ++count > 2048 ||
      depth > 16 ||
      (typeof item === "number" && !Number.isFinite(item)) ||
      ["undefined", "function", "symbol", "bigint"].includes(typeof item)
    ) {
      ctx.addIssue({ code: "custom", message: "Completion criteria must be bounded JSON" });
      return;
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        ctx.addIssue({ code: "custom", message: "Completion criteria cannot contain cycles" });
        return;
      }
      seen.add(item);
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32_768)
    ctx.addIssue({ code: "custom", message: "Completion criteria exceed the byte limit" });
});

export const prepareBrowserJourneySchema = startBrowserRunSchema
  .pick({
    projectId: true,
    missionId: true,
    agentSessionId: true,
    environmentId: true,
    protectedInputIds: true,
    authenticationCommitLimit: true,
    businessCommitLimit: true,
  })
  .extend({
    contractVersion: z.literal(1).default(1),
    attemptId: z.string().min(8).max(128),
    title: z.string().min(1).max(200),
    purpose: z.string().max(4000).default(""),
    completionCriteria,
    objectiveOrder: z.number().int().nonnegative(),
  })
  .strict();
export type PrepareBrowserJourneyInput = z.infer<typeof prepareBrowserJourneySchema>;
export const preparedBrowserJourneySchema = z.strictObject({
  objectiveId: z.string().uuid(),
  flowId: z.string().uuid(),
  flowRevisionId: z.string().uuid(),
  runId: z.string().uuid(),
  browserSessionId: z.string().uuid(),
  contractVersion: z.literal(1),
  replay: z.boolean(),
});
export type PreparedBrowserJourney = z.infer<typeof preparedBrowserJourneySchema>;

export const journeyIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inspect") }),
  z.strictObject({
    kind: z.literal("change_access"),
    restoration: z.strictObject({
      strategy: z.literal("received_link"),
      preservesAdministrator: z.literal(true),
    }),
  }),
]);
export const testingContextRequestSchema = z.strictObject({
  contractVersion: z.literal(1).default(1),
  projectId: z.string().uuid(),
  missionId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  required: z
    .array(
      z.enum([
        "browser",
        "mailboxRead",
        "protectedNavigation",
        "finalize",
        "release",
        "report",
        "journey",
        "sequence",
        "apiRequests",
        "downloadVerification",
        "viewportControl",
      ]),
    )
    .max(11)
    .default([]),
  intent: journeyIntentSchema.default({ kind: "inspect" }),
});
export type TestingContextRequest = z.infer<typeof testingContextRequestSchema>;
