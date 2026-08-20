import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  randomUUID,
  advanceAdaptiveSessionSchema,
  agentDecisionBoundarySchema,
  closeAdaptiveSessionSchema,
  missionAuthoringTurnBudgetsSchema,
  recoverTrustedOriginsSchema,
  startAdaptiveSessionSchema,
  prepareFlowAuthoringSchema,
  preparedFlowAuthoringSchema,
  reconcileAdaptiveOperationSchema,
  agentProviderSchema,
  flowDraftPurposeSchema,
  flowRevisionContentSchema,
  z,
  readOnly,
  stableKey,
  toolResult,
  uuid,
  writes,
  publicPlanSchema,
  navigationExpectedEffectGuidance,
  hostAuthoringIntentSchema,
  withAdaptiveSessionError,
  type ScryApiClient,
} from "./shared.js";

export function registerCloseFlowAuthoringTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "close_flow_authoring",
    {
      title: "Close Flow Authoring",
      description:
        "Close Mission authoring at a verified safe boundary. Unknown mutations must be reconciled before close.",
      inputSchema: {
        sessionId: uuid,
        idempotencyKey: closeAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ sessionId, idempotencyKey }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = closeAdaptiveSessionSchema.parse({
          idempotencyKey: idempotencyKey ?? stableKey("flow-authoring-close", { sessionId }),
        });
        return toolResult(
          { session: await client.post(`/mission-flow-authoring/${sessionId}/close`, body) },
          "Mission authoring closed at a safe boundary.",
        );
      }, "Flow authoring close was rejected."),
  );
}
