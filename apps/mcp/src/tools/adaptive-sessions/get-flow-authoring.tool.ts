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

export function registerGetFlowAuthoringTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_flow_authoring",
    {
      title: "Reconnect to Flow Authoring",
      description:
        "Read durable Mission authoring state only after client or worker interruption, stale recovery, or when the user explicitly requests status. latestTurn.continuation exists only for a genuinely pending turn. For terminal environment failures, use decisionBoundary.authoringRecovery exactly; it binds the current Mission, Objective, Flow, session, environment, failed operation, and the admissible intents-vs-continue kind. Do not poll this tool.",
      inputSchema: { sessionId: uuid },
      annotations: readOnly,
    },
    async ({ sessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            { session: await client.get(`/mission-flow-authoring/${sessionId}`) },
            "Mission authoring state loaded.",
          ),
        "Flow authoring reconnect was rejected.",
      ),
  );
}
