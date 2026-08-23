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
  return events.emit({
    name: "mcp.request_rejected",
    classification:
      input.status >= 500
        ? "infrastructure"
        : input.status === 401 || input.status === 403
          ? "policy_refusal"
          : "validation",
    reasonCode: input.reasonCode,
    outcome: "refused",
    causality: {
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.sessionId ? { agentSessionId: input.sessionId } : {}),
    },
    details: {
      method: input.method ?? "UNKNOWN",
      status: input.status,
    },
  });
}
