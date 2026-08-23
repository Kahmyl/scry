export type OperationalEventName =
  | "api.request_rejected"
  | "mcp.request_rejected"
  | "worker.execution_failed"
  | "praxis.action_failed"
  | "protected_operation.reconciliation_required"
  | "persistence.write_failed"
  | "report.finalization_failed";

export type OperationalEventClassification =
  | "validation"
  | "policy_refusal"
  | "stale_authority"
  | "application_provider"
  | "infrastructure"
  | "persistence"
  | "reconciliation_unknown";

export type OperationalComponent = "api" | "mcp" | "worker" | "praxis" | "runtime";

export type OperationalCausality = Readonly<{
  projectId?: string;
  workspaceId?: string;
  missionId?: string;
  objectiveId?: string;
  agentSessionId?: string;
  runId?: string;
  attemptId?: string;
  praxisSessionId?: string;
  operationId?: string;
  protectedOperationId?: string;
  correlationId?: string;
  browserContextId?: string;
  documentAuthorityId?: string;
}>;

export type OperationalEventInput = Readonly<{
  name: OperationalEventName;
  classification: OperationalEventClassification;
  reasonCode: string;
  outcome: "failed" | "refused" | "inconclusive" | "reconciliation_required";
  causality?: OperationalCausality;
  durationMs?: number;
  transition?: Readonly<{ from: string; to: string }>;
  details?: Readonly<Record<string, unknown>>;
}>;

export type OperationalEvent = Readonly<{
  schemaVersion: 1;
  name: OperationalEventName;
  component: OperationalComponent;
  occurredAt: string;
  critical: true;
  classification: OperationalEventClassification;
  reasonCode: string;
  outcome: OperationalEventInput["outcome"];
  releaseId: string;
  schemaFingerprint: string;
  causality: OperationalCausality;
  durationMs?: number;
  transition?: Readonly<{ from: string; to: string }>;
  details?: Readonly<Record<string, unknown>>;
}>;

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
    this.sink = options.sink ?? stdoutSink;
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

  return {
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
  };
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

function stdoutSink(event: OperationalEvent) {
  process.stdout.write(`${JSON.stringify({ kind: "scry.operational_event", ...event })}\n`);
}
