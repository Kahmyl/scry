import { z } from "zod";
import { interactionTargetIntentSchema } from "./grounding.js";

const nonEmptyText = z.string().trim().min(1).max(2_000);
const timeout = z.number().int().min(100).max(60_000).optional();

export const budgetsSchema = z
  .object({
    maxActions: z.number().int().min(1).max(500).default(100),
    maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(120_000),
    maxNavigations: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const assertionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("visible"),
      target: interactionTargetIntentSchema,
      timeoutMs: timeout,
    })
    .strict(),
  z
    .object({
      type: z.literal("enabled"),
      target: interactionTargetIntentSchema,
      timeoutMs: timeout,
    })
    .strict(),
  z
    .object({
      type: z.literal("hidden"),
      target: interactionTargetIntentSchema,
      timeoutMs: timeout,
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      target: interactionTargetIntentSchema,
      expected: nonEmptyText,
      exact: z.boolean().default(true),
      timeoutMs: timeout,
    })
    .strict(),
  z
    .object({
      type: z.literal("value"),
      target: interactionTargetIntentSchema,
      expected: z.string().max(20_000),
      timeoutMs: timeout,
    })
    .strict(),
  z
    .object({
      type: z.literal("url"),
      expected: z.string().min(1).max(2_048),
      match: z.enum(["exact", "path", "contains"]).default("path"),
      timeoutMs: timeout,
    })
    .strict(),
]);

const readinessStatusRangeSchema = z
  .object({
    min: z.number().int().min(100).max(599),
    max: z.number().int().min(100).max(599),
  })
  .strict()
  .refine(({ min, max }) => min <= max, "status range min must not exceed max");

export const readinessConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visible"), target: interactionTargetIntentSchema }).strict(),
  z.object({ type: z.literal("hidden"), target: interactionTargetIntentSchema }).strict(),
  z
    .object({
      type: z.literal("text"),
      target: interactionTargetIntentSchema,
      expected: nonEmptyText,
      exact: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("value"),
      target: interactionTargetIntentSchema,
      expected: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("checked"),
      target: interactionTargetIntentSchema,
      expected: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("url"),
      expected: z.string().min(1).max(2_048),
      match: z.enum(["exact", "path", "contains"]).default("path"),
    })
    .strict(),
  z
    .object({
      type: z.literal("content"),
      target: interactionTargetIntentSchema,
      minimumChildren: z.number().int().min(1).max(10_000).optional(),
      minimumTextLength: z.number().int().min(1).max(1_000_000).optional(),
      requiredText: nonEmptyText.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.minimumChildren !== undefined ||
        value.minimumTextLength !== undefined ||
        value.requiredText !== undefined,
      "content readiness requires a threshold",
    ),
  z
    .object({
      type: z.literal("request"),
      urlPattern: nonEmptyText,
      method: z
        .string()
        .trim()
        .min(1)
        .max(20)
        .transform((value) => value.toUpperCase())
        .optional(),
      status: readinessStatusRangeSchema.default({ min: 200, max: 399 }),
    })
    .strict(),
  z
    .object({
      type: z.literal("domStable"),
      quietWindowMs: z.number().int().min(100).max(3_000).default(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("networkQuiet"),
      quietWindowMs: z.number().int().min(100).max(3_000).default(500),
      ignoreUrlPatterns: z.array(nonEmptyText).max(50).default([]),
    })
    .strict(),
  z
    .object({ type: z.literal("delay"), durationMs: z.number().int().min(100).max(30_000) })
    .strict(),
]);

export const readinessSchema = z
  .object({
    mode: z.enum(["all", "any"]).default("all"),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    conditions: z.array(readinessConditionSchema).min(1).max(20),
  })
  .strict();

export type Assertion = z.infer<typeof assertionSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
export type ReadinessCondition = z.infer<typeof readinessConditionSchema>;
