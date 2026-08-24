import { z } from "zod";

export const operationalEventNameSchema = z.enum([
  "api.request_rejected",
  "mcp.request_rejected",
  "worker.execution_failed",
  "praxis.action_failed",
  "protected_operation.reconciliation_required",
  "persistence.write_failed",
  "report.finalization_failed",
  "external_agent.lifecycle_settled",
  "external_agent.blocked",
]);

export const operationalEventClassificationSchema = z.enum([
  "validation",
  "policy_refusal",
  "stale_authority",
  "application_provider",
  "infrastructure",
  "persistence",
  "reconciliation_unknown",
]);

export const operationalComponentSchema = z.enum(["api", "mcp", "worker", "praxis", "runtime"]);
export const operationalEventOutcomeSchema = z.enum([
  "failed",
  "refused",
  "inconclusive",
  "reconciliation_required",
]);

const boundedIdentitySchema = z.string().trim().min(1).max(200);
export const operationalCausalitySchema = z
  .object({
    projectId: boundedIdentitySchema.optional(),
    workspaceId: boundedIdentitySchema.optional(),
    missionId: boundedIdentitySchema.optional(),
    objectiveId: boundedIdentitySchema.optional(),
    agentSessionId: boundedIdentitySchema.optional(),
    mcpSessionId: boundedIdentitySchema.optional(),
    runId: boundedIdentitySchema.optional(),
    attemptId: boundedIdentitySchema.optional(),
    praxisSessionId: boundedIdentitySchema.optional(),
    operationId: boundedIdentitySchema.optional(),
    protectedOperationId: boundedIdentitySchema.optional(),
    correlationId: boundedIdentitySchema.optional(),
    browserContextId: boundedIdentitySchema.optional(),
    documentAuthorityId: boundedIdentitySchema.optional(),
  })
  .strict();

const operationalTransitionSchema = z
  .object({
    from: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/i),
    to: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/i),
  })
  .strict();

export const operationalEventInputSchema = z
  .object({
    name: operationalEventNameSchema,
    classification: operationalEventClassificationSchema,
    reasonCode: z.string(),
    outcome: operationalEventOutcomeSchema,
    causality: operationalCausalitySchema.optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    transition: operationalTransitionSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const operationalEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: operationalEventNameSchema,
    component: operationalComponentSchema,
    occurredAt: z.iso.datetime({ offset: true }),
    critical: z.literal(true),
    classification: operationalEventClassificationSchema,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/),
    outcome: operationalEventOutcomeSchema,
    releaseId: boundedIdentitySchema,
    schemaFingerprint: boundedIdentitySchema,
    causality: operationalCausalitySchema,
    durationMs: z.number().finite().nonnegative().optional(),
    transition: operationalTransitionSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type OperationalEventName = z.infer<typeof operationalEventNameSchema>;
export type OperationalEventClassification = z.infer<typeof operationalEventClassificationSchema>;
export type OperationalComponent = z.infer<typeof operationalComponentSchema>;
export type OperationalCausality = Readonly<z.infer<typeof operationalCausalitySchema>>;
export type OperationalEventInput = Readonly<z.infer<typeof operationalEventInputSchema>>;
export type OperationalEvent = Readonly<z.infer<typeof operationalEventSchema>>;

export type OperationalEventSink = (event: OperationalEvent) => void | Promise<void>;
export type OperationalEventWriter = Pick<OperationalEventEmitter, "emit">;

type OperationalEventEmitterOptions = Readonly<{
  component: OperationalComponent;
  releaseId?: string;
  schemaFingerprint?: string;
  sink?: OperationalEventSink;
  now?: () => Date;
}>;

const forbiddenKey =
  /(?:^|_)(?:authorization|cookie|credential|password|secret|token|request_body|response_body|protected_value|raw_value|value)(?:$|_)/i;
const sensitiveString =
  /\bBearer\s+\S+|\b(?:session|auth|access|refresh)[_-]?token\s*[=:]\s*\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i;

export class OperationalEventEmitter {
  private readonly sink: OperationalEventSink;
  private readonly now: () => Date;

  constructor(private readonly options: OperationalEventEmitterOptions) {
    this.sink = options.sink ?? stdoutOperationalEventSink;
    this.now = options.now ?? (() => new Date());
  }

  /** Operational telemetry is best-effort and can never redefine product truth. */
  async emit(input: OperationalEventInput): Promise<void> {
    try {
      await this.sink(
        buildOperationalEvent({
          ...this.options,
          now: this.now,
          input,
        }),
      );
    } catch {
      // A telemetry transport failure must not change a Run, mutation, or report outcome.
    }
  }
}

export function buildOperationalEvent(options: {
  component: OperationalComponent;
  releaseId?: string;
  schemaFingerprint?: string;
  now?: () => Date;
  input: OperationalEventInput;
}): OperationalEvent {
  const causality = sanitizeCausality(options.input.causality ?? {});
  const details = sanitizeDetails(options.input.details);
  const durationMs = safeDuration(options.input.durationMs);
  const transition = sanitizeTransition(options.input.transition);

  return operationalEventSchema.parse({
    schemaVersion: 1,
    name: options.input.name,
    component: options.component,
    occurredAt: (options.now ?? (() => new Date()))().toISOString(),
    // These events describe refusal, ambiguity, or failure and are never sampling candidates.
    critical: true,
    classification: options.input.classification,
    reasonCode: safeOperationalReasonCode(options.input.reasonCode),
    outcome: options.input.outcome,
    releaseId: safeIdentity(options.releaseId) ?? "development",
    schemaFingerprint: safeIdentity(options.schemaFingerprint) ?? "development-baseline",
    causality,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(transition ? { transition } : {}),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  });
}

/** Reject central-ingestion payloads that did not already pass canonical emission sanitization. */
export function parseOperationalEvent(value: unknown): OperationalEvent {
  const parsed = operationalEventSchema.parse(value);
  const sanitizedCausality = sanitizeCausality(parsed.causality);
  const sanitizedDetails = sanitizeDetails(parsed.details);
  if (
    JSON.stringify(sanitizedCausality) !== JSON.stringify(parsed.causality) ||
    JSON.stringify(sanitizedDetails) !== JSON.stringify(parsed.details)
  ) {
    throw new Error("OPERATIONAL_EVENT_NOT_SANITIZED");
  }
  return parsed;
}

/** Every sink is attempted so a durable transport failure cannot suppress fallback evidence. */
export function createFanOutOperationalEventSink(
  sinks: readonly OperationalEventSink[],
): OperationalEventSink {
  return async (event) => {
    await Promise.allSettled(sinks.map((sink) => Promise.resolve().then(() => sink(event))));
  };
}

export function stdoutOperationalEventSink(event: OperationalEvent) {
  process.stdout.write(`${JSON.stringify({ kind: "scry.operational_event", ...event })}\n`);
}

export function safeOperationalReasonCode(value: unknown, fallback = "OPERATIONAL_FAILURE") {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,119}$/.test(value) ? value : fallback;
}

function sanitizeCausality(value: OperationalCausality): OperationalCausality {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const identity = safeIdentity(item);
      return identity ? [[key, identity]] : [];
    }),
  );
}

function sanitizeTransition(value: OperationalEventInput["transition"]) {
  if (!value) return undefined;
  const from = safeState(value.from);
  const to = safeState(value.to);
  return from && to ? { from, to } : undefined;
}

function sanitizeDetails(
  value: OperationalEventInput["details"],
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return sanitizeRecord(value, 0);
}

function sanitizeRecord(value: Readonly<Record<string, unknown>>, depth: number) {
  if (depth > 3) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey.test(toSnakeCase(key))) {
      output[key] = "[REDACTED]";
      continue;
    }
    const sanitized = sanitizeValue(item, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string")
    return sensitiveString.test(value) ? "[REDACTED]" : value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeValue(item, depth));
  if (typeof value === "object" && value !== null && depth <= 3)
    return sanitizeRecord(value as Record<string, unknown>, depth);
  return undefined;
}

function safeIdentity(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= 200 &&
    !/[\r\n\0]/.test(normalized) &&
    !sensitiveString.test(normalized)
    ? normalized
    : undefined;
}

function safeState(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/i.test(value) ? value : undefined;
}

function safeDuration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000) / 1000
    : undefined;
}

function toSnakeCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
