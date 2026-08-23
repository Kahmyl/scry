import { describe, expect, it, vi } from "vitest";

import { observeMcpRequestRejected } from "../src/operational-events.js";

describe("MCP operational observability", () => {
  it("projects invalid-request identity without accepting authorization material", async () => {
    const events = { emit: vi.fn(async () => undefined) };
    await observeMcpRequestRejected(
      {
        reasonCode: "MCP_ACCESS_TOKEN_REQUIRED",
        status: 401,
        method: "POST",
        correlationId: "correlation-1",
        sessionId: "session-1",
      },
      events,
    );

    expect(events.emit).toHaveBeenCalledWith({
      name: "mcp.request_rejected",
      classification: "policy_refusal",
      reasonCode: "MCP_ACCESS_TOKEN_REQUIRED",
      outcome: "refused",
      causality: {
        correlationId: "correlation-1",
        agentSessionId: "session-1",
      },
      details: { method: "POST", status: 401 },
    });
  });
});
