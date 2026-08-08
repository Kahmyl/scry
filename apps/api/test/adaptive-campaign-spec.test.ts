import { describe, expect, it } from "vitest";

import { generatedCoreCampaignCalls } from "../scripts/adaptive-campaign-support.js";
import {
  classifyCampaignCall,
  findDecisionBoundary,
  parseMcpResponse,
} from "../scripts/deployed-adaptive-campaign.js";

const ids = {
  campaignId: "campaign-test",
  correlationId: "11111111-1111-4111-8111-111111111111",
  fixtureOrigin: "http://127.0.0.1:45678",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  emailCredentialId: "44444444-4444-4444-8444-444444444444",
  passwordCredentialId: "55555555-5555-4555-8555-555555555555",
};

describe("self-contained adaptive core campaign specs", () => {
  it("generates a fine-grained M0 baseline with one operation per authoring call", () => {
    const spec = generatedCoreCampaignCalls({ ...ids, milestone: "M0" });

    expect(spec.calls[0]).toMatchObject({
      name: "start_adaptive_session",
      arguments: {
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        allowedOrigins: [ids.fixtureOrigin],
        correlationId: ids.correlationId,
      },
    });
    const advances = spec.calls.slice(1);
    expect(advances).toHaveLength(9);
    expect(advances.every((call) => call.name === "advance_adaptive_session")).toBe(true);
    expect(
      advances.every(
        (call) =>
          call.arguments.sessionId === "${SESSION_ID}" &&
          Array.isArray(call.arguments.operations) &&
          call.arguments.operations.length === 1,
      ),
    ).toBe(true);
  });

  it("generates one grouped M1 authoring call and uses only credential references", () => {
    const spec = generatedCoreCampaignCalls({ ...ids, milestone: "M1" });

    expect(spec.calls.map((call) => call.name)).toEqual([
      "start_adaptive_session",
      "advance_adaptive_session",
    ]);
    const operations = spec.calls[1]?.arguments.operations as Array<{
      action: Record<string, unknown>;
      protectedInputReferences: string[];
      expectedEffect: { type: string };
    }>;
    expect(operations).toHaveLength(9);
    const fills = operations.filter((operation) => operation.action.type === "fill");
    expect(fills).toHaveLength(2);
    expect(fills.map((operation) => operation.action.secretRef)).toEqual([
      ids.emailCredentialId,
      ids.passwordCredentialId,
    ]);
    expect(fills.map((operation) => operation.protectedInputReferences)).toEqual([
      [ids.emailCredentialId],
      [ids.passwordCredentialId],
    ]);
    expect(JSON.stringify(spec)).not.toContain('"value"');
    expect(operations.every((operation) => operation.expectedEffect.type.length > 0)).toBe(true);
  });

  it("measures session startup separately from comparable authoring calls", () => {
    expect(classifyCampaignCall("start_adaptive_session")).toEqual({
      kind: "session_start",
      phase: "mcp_session_start_round_trip",
      countsAsAuthoring: false,
    });
    expect(classifyCampaignCall("advance_adaptive_session")).toEqual({
      kind: "authoring",
      phase: "mcp_round_trip",
      countsAsAuthoring: true,
    });
  });

  it("reads the typed boundary instead of mistaking an action type for a boundary", () => {
    expect(
      findDecisionBoundary({
        result: {
          structuredContent: {
            session: {
              operationsCompleted: [{ action: { type: "navigate" } }],
              decisionBoundary: { type: "objective_completed" },
            },
          },
        },
      }),
    ).toBe("objective_completed");
  });

  it("parses standard MCP SSE responses that begin with an event field", () => {
    expect(
      parseMcpResponse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'),
    ).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});
