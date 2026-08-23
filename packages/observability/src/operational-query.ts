import { z } from "zod";

import {
  operationalComponentSchema,
  operationalEventClassificationSchema,
  operationalEventNameSchema,
  operationalEventSchema,
} from "./operational-event.js";

const identityFilterSchema = z.string().trim().min(1).max(200);
const optionalDateTimeSchema = z.iso.datetime({ offset: true }).optional();

const operationalEventQueryBaseSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().trim().min(1).max(512).optional(),
    occurredAfter: optionalDateTimeSchema,
    occurredBefore: optionalDateTimeSchema,
    eventName: operationalEventNameSchema.optional(),
    component: operationalComponentSchema.optional(),
    classification: operationalEventClassificationSchema.optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,119}$/)
      .optional(),
    projectId: identityFilterSchema.optional(),
    missionId: identityFilterSchema.optional(),
    runId: identityFilterSchema.optional(),
    praxisSessionId: identityFilterSchema.optional(),
    protectedOperationId: identityFilterSchema.optional(),
    correlationId: identityFilterSchema.optional(),
  })
  .strict();

export const operationalEventQuerySchema = operationalEventQueryBaseSchema.refine(
  (value) =>
    !value.occurredAfter ||
    !value.occurredBefore ||
    new Date(value.occurredAfter) <= new Date(value.occurredBefore),
  "occurredAfter must be earlier than occurredBefore",
);

export const operationalCausalDimensionSchema = z.enum([
  "correlation",
  "mission",
  "run",
  "praxis",
  "protected_operation",
]);

export const operationalCausalLookupSchema = z
  .object({
    dimension: operationalCausalDimensionSchema,
    id: identityFilterSchema,
  })
  .strict();

export const operationalSummaryQuerySchema = z
  .object({
    projectId: identityFilterSchema.optional(),
    windowHours: z.coerce.number().int().min(1).max(168).default(24),
  })
  .strict();

export const operationalExportQuerySchema = operationalEventQueryBaseSchema
  .omit({ limit: true, cursor: true })
  .extend({
    limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
    format: z.enum(["json", "jsonl"]).default("json"),
  })
  .strict();

export const storedOperationalEventSchema = operationalEventSchema.extend({
  id: z.string().uuid(),
  ingestedAt: z.iso.datetime({ offset: true }),
});

export const operationalEventPageSchema = z
  .object({
    items: z.array(storedOperationalEventSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

export const operationalAlertTypeSchema = z.enum([
  "unknown_protected_operation",
  "worker_execution_failure",
  "reconciliation_latency",
  "report_blocker",
  "release_compatibility_refusal",
  "evidence_finalization_failure",
]);

export const operationalAlertSchema = z
  .object({
    type: operationalAlertTypeSchema,
    severity: z.enum(["warning", "critical"]),
    count: z.number().int().nonnegative(),
    firstOccurredAt: z.iso.datetime({ offset: true }).optional(),
    lastOccurredAt: z.iso.datetime({ offset: true }).optional(),
    correlationId: identityFilterSchema.optional(),
    safeAction: z.string().min(1).max(300),
  })
  .strict();

export const operationalSummarySchema = z
  .object({
    generatedAt: z.iso.datetime({ offset: true }),
    windowStartedAt: z.iso.datetime({ offset: true }),
    totalEvents: z.number().int().nonnegative(),
    byClassification: z.partialRecord(
      operationalEventClassificationSchema,
      z.number().int().nonnegative(),
    ),
    alerts: z.array(operationalAlertSchema),
  })
  .strict();

export type OperationalEventQuery = z.infer<typeof operationalEventQuerySchema>;
export type OperationalCausalDimension = z.infer<typeof operationalCausalDimensionSchema>;
export type OperationalSummaryQuery = z.infer<typeof operationalSummaryQuerySchema>;
export type OperationalExportQuery = z.infer<typeof operationalExportQuerySchema>;
export type StoredOperationalEvent = z.infer<typeof storedOperationalEventSchema>;
export type OperationalEventPage = z.infer<typeof operationalEventPageSchema>;
export type OperationalAlert = z.infer<typeof operationalAlertSchema>;
export type OperationalSummary = z.infer<typeof operationalSummarySchema>;
