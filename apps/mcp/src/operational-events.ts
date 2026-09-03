import {
  createFanOutOperationalEventSink,
  OperationalEventEmitter,
  stdoutOperationalEventSink,
  type OperationalEventSink,
  type OperationalEventWriter,
} from "@scry/observability";

const serviceToken = process.env.SCRY_SERVICE_TOKEN;
const durableSink = serviceToken
  ? createMcpOperationalEventApiSink({
      baseUrl: process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api",
      serviceToken,
    })
  : undefined;

const defaultEvents = new OperationalEventEmitter({
  component: "mcp",
  ...(process.env.SCRY_RELEASE_ID ? { releaseId: process.env.SCRY_RELEASE_ID } : {}),
  ...(process.env.SCRY_SCHEMA_FINGERPRINT
    ? { schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT }
    : {}),
  sink: createFanOutOperationalEventSink([
    stdoutOperationalEventSink,
    ...(durableSink ? [durableSink] : []),
  ]),
});

export function createMcpOperationalEventApiSink(options: {
  baseUrl: string;
  serviceToken: string;
  request?: typeof fetch;
}): OperationalEventSink {
  const request = options.request ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/operations/events/ingest`;
  return async (event) => {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`MCP_OPERATIONAL_EVENT_INGESTION_FAILED_${response.status}`);
  };
}

export function observeMcpRequestRejected(
  input: {
    reasonCode: string;
    status: number;
    method?: string;
    correlationId?: string;
    sessionId?: string;
  },
  events: OperationalEventWriter = defaultEvents,
) {
  return emitBestEffort(events, {
    name: "mcp.request_rejected" as const,
    classification:
      input.status >= 500
        ? ("infrastructure" as const)
        : input.status === 401 || input.status === 403
          ? ("policy_refusal" as const)
          : ("validation" as const),
    reasonCode: input.reasonCode,
    outcome: "refused" as const,
    causality: {
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.sessionId ? { mcpSessionId: input.sessionId } : {}),
    },
    details: {
      method: input.method ?? "UNKNOWN",
      status: input.status,
    },
  });
}

async function emitBestEffort(
  events: OperationalEventWriter,
  input: Parameters<OperationalEventWriter["emit"]>[0],
) {
  try {
    await events.emit(input);
  } catch {
    // MCP refusal telemetry cannot replace the transport response.
  }
}
