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

export function registerReconcileUnknownOperationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "reconcile_unknown_operation",
    {
      title: "Reconcile Unknown Operation",
      description:
        "Ask Scry to perform an authoritative observation-only reconciliation of one durable UNKNOWN authoring operation. This never redispatches or repeats the uncertain action. The caller identifies the Mission, authoring session, and operation but cannot supply an outcome or evidence. Results are proven_applied, proven_not_applied, or still_unknown. still_unknown preserves the Mission-wide fence and prohibits retry; if later state or evidence changes, call again without idempotencyKey so Scry creates a fresh attempt. requiresFreshIdempotencyKey and nextAttemptId describe that boundary.",
      inputSchema: {
        sessionId: uuid,
        missionId: reconcileAdaptiveOperationSchema.shape.missionId,
        operationId: reconcileAdaptiveOperationSchema.shape.operationId,
        idempotencyKey: reconcileAdaptiveOperationSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ sessionId, missionId, operationId, idempotencyKey }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = reconcileAdaptiveOperationSchema.parse({
          missionId,
          operationId,
          idempotencyKey: idempotencyKey ?? `unknown-operation-reconciliation-${randomUUID()}`,
        });
        return toolResult(
          {
            reconciliation: await client.post(
              `/mission-flow-authoring/${sessionId}/reconcile-unknown`,
              body,
            ),
          },
          "Authoritative observation-only reconciliation completed; the uncertain action was not redispatched.",
        );
      }, "Unknown-operation reconciliation was rejected."),
  );
}
