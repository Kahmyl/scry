import { z } from "zod";
import { browserOutputSelectionSchema } from "./browser-execution-v2.js";

const reference = z.string().uuid();
const effectId = z.string().uuid();

export const browserCommandV2Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().url() }),
  z.object({ kind: z.literal("observe") }),
  z
    .object({
      kind: z.literal("fill"),
      reference,
      publicValue: z.string().max(10_000).optional(),
      protectedValueId: z.string().uuid().optional(),
    })
    .superRefine((value, context) => {
      if ((value.publicValue === undefined) === (value.protectedValueId === undefined))
        context.addIssue({ code: "custom", message: "exactly one fill value source is required" });
    }),
  z.object({ kind: z.literal("click"), reference }),
  z.object({
    kind: z.literal("press"),
    reference,
    key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]),
  }),
  z.object({
    kind: z.literal("capture_dom"),
    effectId,
    reference,
  }),
  z.object({
    kind: z.literal("commit"),
    reference,
    effectClass: z.enum(["authentication", "business"]),
    effectIdempotencyKey: z.string().min(8).max(256),
    intentSummary: z.string().min(1).max(1_000),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  }),
  z.object({
    kind: z.literal("publish_capture"),
    effectId,
    captureId: z.string().uuid(),
    selections: z.array(browserOutputSelectionSchema).min(1).max(100),
  }),
  z.object({ kind: z.literal("discard_capture"), effectId, captureId: z.string().uuid() }),
  z.object({
    kind: z.literal("determine"),
    effectId,
    outcome: z.enum(["applied", "not_applied", "unknown"]),
    source: z.string().min(1).max(500),
  }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("close_for_failure") }),
]);

export const submitBrowserCommandV2Schema = z.object({
  idempotencyKey: z.string().min(8).max(256),
  command: browserCommandV2Schema,
});

export type BrowserCommandV2 = z.infer<typeof browserCommandV2Schema>;
export type SubmitBrowserCommandV2Input = z.infer<typeof submitBrowserCommandV2Schema>;
