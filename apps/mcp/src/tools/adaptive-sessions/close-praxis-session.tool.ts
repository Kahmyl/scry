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
  idempotentPotentiallyDestructiveExternalOperation,
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

export function registerClosePraxisSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "close_praxis_session",
    {
      title: "Close Praxis session",
      description:
        "Close the live session. A completed operation, turn, or Objective boundary does not itself close an active Praxis session. When its runtime work is complete and final Mission publication is intended, close the session before publish_mission_report. Its references become permanently stale; continuation requires a new session, re-observation, and new references.",
      inputSchema: {
        praxisSessionId: uuid,
        idempotencyKey: closeAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      outputSchema: z.object({ message: z.string(), session: adaptiveSessionSchema }).strict(),
      annotations: idempotentPotentiallyDestructiveExternalOperation,
    },
    async ({ praxisSessionId, idempotencyKey }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = closeAdaptiveSessionSchema.parse({
          idempotencyKey: idempotencyKey ?? stableKey("praxis-session-close", { praxisSessionId }),
        });
        return toolResult(
          { session: await client.post(`/praxis-sessions/${praxisSessionId}/close`, body) },
          "Praxis session closed; all references from it are stale.",
        );
      }, "Session close refused."),
  );
}
