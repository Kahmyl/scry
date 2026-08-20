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

export function registerReconcilePraxisUnknownOperationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "reconcile_unknown_operation",
    {
      title: "Reconcile unknown operation",
      description:
        "Perform observation-only reconciliation of one UNKNOWN operation. This never redispatches it; still_unknown remains fenced.",
      inputSchema: {
        praxisSessionId: uuid,
        missionId: reconcileAdaptiveOperationSchema.shape.missionId,
        operationId: reconcileAdaptiveOperationSchema.shape.operationId,
        idempotencyKey: reconcileAdaptiveOperationSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ praxisSessionId, missionId, operationId, idempotencyKey }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = reconcileAdaptiveOperationSchema.parse({
          missionId,
          operationId,
          idempotencyKey: idempotencyKey ?? `praxis-reconciliation-${randomUUID()}`,
        });
        return toolResult(
          {
            reconciliation: await client.post(
              `/praxis-sessions/${praxisSessionId}/reconcile-unknown`,
              body,
            ),
          },
          "Observation-only reconciliation recorded; no operation was redispatched.",
        );
      }, "Reconciliation refused."),
  );
}
