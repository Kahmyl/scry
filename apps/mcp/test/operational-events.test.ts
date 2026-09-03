import { describe, expect, it, vi } from "vitest";

import {
  createMcpOperationalEventApiSink,
  observeMcpRequestRejected,
} from "../src/operational-events.js";

describe("MCP operational observability", () => {
  it("projects invalid-request identity without accepting authorization material", async () => {
    const events = {
      emit: vi.fn(async () => {
        throw new Error("TELEMETRY_SINK_UNAVAILABLE");
      }),
    };
    await expect(
      observeMcpRequestRejected(
        {
          reasonCode: "MCP_ACCESS_TOKEN_REQUIRED",
          status: 401,
          method: "POST",
          correlationId: "correlation-1",
          sessionId: "session-1",
        },
        events,
      ),
    ).resolves.toBeUndefined();

    expect(events.emit).toHaveBeenCalledWith({
      name: "mcp.request_rejected",
      classification: "policy_refusal",
      reasonCode: "MCP_ACCESS_TOKEN_REQUIRED",
      outcome: "refused",
      causality: {
        correlationId: "correlation-1",
        mcpSessionId: "session-1",
      },
      details: { method: "POST", status: 401 },
    });
  });

  it("uses the service-authenticated API ingestion seam", async () => {
    const request = vi.fn(async () => new Response(null, { status: 202 }));
    const sink = createMcpOperationalEventApiSink({
      baseUrl: "http://api.test/api/",
      serviceToken: "service-token",
      request,
    });
    const event = {
      schemaVersion: 1 as const,
      name: "mcp.request_rejected" as const,
      component: "mcp" as const,
      occurredAt: "2026-08-23T10:00:00.000Z",
      critical: true as const,
      classification: "validation" as const,
      reasonCode: "MCP_REQUEST_INVALID",
      outcome: "refused" as const,
      releaseId: "release-1",
      schemaFingerprint: "schema-1",
      causality: {},
    };

    await sink(event);
    expect(request).toHaveBeenCalledWith(
      "http://api.test/api/operations/events/ingest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer service-token" }),
        body: JSON.stringify(event),
      }),
    );
  });
});
