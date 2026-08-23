import { OperationalEventEmitter, type OperationalEventWriter } from "@scry/observability";

const defaultEvents = new OperationalEventEmitter({
  component: "mcp",
  ...(process.env.SCRY_RELEASE_ID ? { releaseId: process.env.SCRY_RELEASE_ID } : {}),
  ...(process.env.SCRY_SCHEMA_FINGERPRINT
    ? { schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT }
    : {}),
});

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
