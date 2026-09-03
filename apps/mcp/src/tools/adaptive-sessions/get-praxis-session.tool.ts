import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  randomUUID,
  advanceAdaptiveSessionSchema,
  adaptiveSessionSchema,
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

export function registerGetPraxisSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_praxis_session",
    {
      title: "Get Praxis session facts",
      description:
        "Read durable lifecycle facts. This does not observe, dispatch, resume, or choose progression.",
      inputSchema: { praxisSessionId: uuid },
      outputSchema: z.object({ message: z.string(), session: adaptiveSessionSchema }).strict(),
      annotations: readOnly,
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              session: await client.get(`/praxis-sessions/${praxisSessionId}`),
            },
            "Praxis session lifecycle facts loaded.",
          ),
        "Session read refused.",
      ),
  );
}
