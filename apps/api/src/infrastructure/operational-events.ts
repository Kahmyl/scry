import { Inject, Injectable } from "@nestjs/common";
import {
  createFanOutOperationalEventSink,
  OperationalEventEmitter,
  parseOperationalEvent,
  stdoutOperationalEventSink,
  type OperationalComponent,
  type OperationalEvent,
  type OperationalEventClassification,
  type OperationalEventInput,
  type OperationalEventSink,
} from "@scry/observability";

import { OperationalEventStore } from "./operational-event-store.js";

@Injectable()
export class OperationalEvents {
  private readonly emitters = new Map<OperationalComponent, OperationalEventEmitter>();
  private readonly sink: OperationalEventSink;

  constructor(@Inject(OperationalEventStore) private readonly store: OperationalEventStore) {
    this.sink = createFanOutOperationalEventSink([
      stdoutOperationalEventSink,
      (event) => this.store.write(event),
    ]);
  }

  emit(component: OperationalComponent, input: OperationalEventInput) {
    let emitter = this.emitters.get(component);
    if (!emitter) {
      emitter = new OperationalEventEmitter({
        component,
        ...(process.env.SCRY_RELEASE_ID ? { releaseId: process.env.SCRY_RELEASE_ID } : {}),
        ...(process.env.SCRY_SCHEMA_FINGERPRINT
          ? { schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT }
          : {}),
        sink: this.sink,
      });
      this.emitters.set(component, emitter);
    }
    return emitter.emit(input);
  }

  /** Service-authenticated central ingestion for components that do not own a database connection. */
  async ingest(value: OperationalEvent) {
    const event = parseOperationalEvent(value);
    // Preserve fallback evidence even when the durable ingestion response must report failure.
    stdoutOperationalEventSink(event);
    await this.store.write(event);
  }

  pruneExpired(now = new Date()) {
    return this.store.prune({
      retentionDays: configuredInteger("SCRY_OPERATIONAL_EVENT_RETENTION_DAYS", 30, 1, 3_650),
      batchSize: configuredInteger("SCRY_OPERATIONAL_EVENT_RETENTION_BATCH_SIZE", 1_000, 1, 5_000),
      now,
    });
  }
}

export type ApiOperationalEventWriter = Pick<OperationalEvents, "emit">;

export function installApiRequestObservability(
  server: {
    addHook(
      name: "onSend",
      hook: (
        request: {
          method: string;
          headers: Record<string, string | string[] | undefined>;
          routeOptions?: { url?: string };
        },
        reply: { statusCode: number },
        payload: unknown,
      ) => Promise<unknown>,
    ): void;
  },
  events: ApiOperationalEventWriter,
) {
  server.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    const status = reply.statusCode;
    const responseCode = structuredResponseCode(payload);
    try {
      await events.emit("api", {
        name: "api.request_rejected",
        classification: rejectionClassification(responseCode, status),
        reasonCode: responseCode ?? `API_REQUEST_REJECTED_${status}`,
        outcome: "refused",
        causality: {
          ...requestCausality(request.headers),
        },
        details: {
          method: request.method,
          route: request.routeOptions?.url ?? "unmatched",
          status,
        },
      });
    } catch {
      // Rejection telemetry cannot replace or mutate the API response.
    }
    return payload;
  });
}

function structuredResponseCode(payload: unknown) {
  try {
    const value =
      typeof payload === "string"
        ? JSON.parse(payload)
        : Buffer.isBuffer(payload)
          ? JSON.parse(payload.toString("utf8"))
          : payload;
    if (!value || typeof value !== "object") return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,119}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function rejectionClassification(
  code: string | undefined,
  status: number,
): OperationalEventClassification {
  if (code) {
    if (/RECONCILIATION|OUTCOME_UNKNOWN/.test(code)) return "reconciliation_unknown";
    if (/DATABASE|PERSIST|STORAGE|ARTIFACT|SQL/.test(code)) return "persistence";
    if (/STALE|FENCED|REVISION|AUTHORITY|REFERENCE|CONTEXT|MISMATCH|CONFLICT/.test(code))
      return "stale_authority";
    if (/POLICY|DENIED|REFUSED|FORBIDDEN|UNAUTHORIZED|AUTHORIZATION|ACCESS_TOKEN/.test(code))
      return "policy_refusal";
    if (/PROVIDER|APPLICATION/.test(code)) return "application_provider";
    if (/VALIDATION|INVALID|REQUIRED|NOT_FOUND|MISSING/.test(code)) return "validation";
  }
  if (status >= 500) return "infrastructure";
  if (status === 401 || status === 403) return "policy_refusal";
  if (status === 409) return "application_provider";
  return "validation";
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const causalRequestHeaders = {
  "x-scry-project-id": "projectId",
  "x-scry-mission-id": "missionId",
  "x-scry-objective-id": "objectiveId",
  "x-scry-agent-session-id": "agentSessionId",
  "x-scry-mcp-session-id": "mcpSessionId",
  "x-scry-run-id": "runId",
  "x-scry-attempt-id": "attemptId",
  "x-scry-praxis-session-id": "praxisSessionId",
  "x-scry-operation-id": "operationId",
  "x-scry-protected-operation-id": "protectedOperationId",
  "x-correlation-id": "correlationId",
} as const;

function requestCausality(headers: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(causalRequestHeaders).flatMap(([header, key]) => {
      const value = firstHeader(headers[header]);
      return value && value.length <= 200 && !/[\r\n]/.test(value) ? [[key, value]] : [];
    }),
  );
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name}_INVALID`);
  return value;
}
