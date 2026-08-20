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

export function registerObservePraxisSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "observe_praxis_session",
    {
      title: "Observe live Praxis session",
      description:
        "Return bounded factual browser state and opaque context-control references from the current Page/document. References are session/document scoped and the external agent selects one explicitly.",
      inputSchema: { praxisSessionId: uuid },
      annotations: readOnly,
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              observation: await client.get(`/praxis-sessions/${praxisSessionId}/observation`),
            },
            "Current factual observation loaded; choose an exact reference explicitly.",
          ),
        "Observation refused.",
      ),
  );
}
