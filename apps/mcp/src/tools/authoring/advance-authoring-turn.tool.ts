import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { advanceAuthoringTurnPayloadSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { missionContext, stableKey, toolResult, uuid, writes } from "../../tool-registry.js";

export function registerAdvanceAuthoringTurnTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "advance_authoring_turn",
    {
      title: "Advance Authoring Turn",
      description:
        "Execute a bounded group of deterministic authoring operations and return only at a typed semantic decision boundary.",
      inputSchema: {
        ...missionContext,
        probeSessionId: uuid,
        correlationId: uuid.optional(),
        objectiveDelta: z.string().trim().min(1).max(4_000),
        operations: advanceAuthoringTurnPayloadSchema.shape.operations,
        authorization: advanceAuthoringTurnPayloadSchema.shape.authorization,
        budgets: advanceAuthoringTurnPayloadSchema.shape.budgets,
        protectedInputReferences:
          advanceAuthoringTurnPayloadSchema.shape.protectedInputReferences.optional(),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ probeSessionId, idempotencyKey, missionId, agentSessionId, ...payload }) => {
      const body = {
        missionId,
        agentSessionId,
        payload: advanceAuthoringTurnPayloadSchema.parse(payload),
        idempotencyKey:
          idempotencyKey ?? stableKey("authoring-turn", { probeSessionId, missionId, payload }),
      };
      return toolResult(
        {
          turn: await client.post(`/probe-sessions/${probeSessionId}/advance`, body),
        },
        "Authoring turn reached a decision boundary.",
      );
    },
  );
}
