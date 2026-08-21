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

export function registerStartFlowAuthoringTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_flow_authoring",
    {
      title: "Start Flow Authoring",
      description:
        "Start one durable authoring session for an existing Mission-owned Flow draft and approved environment; an exact idempotency replay returns that same session. Scry provisions and verifies the controlled browser runtime before the session becomes active, so a successful response is execution-ready rather than merely a durable environment record. turnBudgets requires maxOperations 1-20 and maxDurationMs 1000-60000. Create the environment first; credentials are needed only for protected fills and must be authorized to that environment.",
      inputSchema: {
        ...startAdaptiveSessionSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: startAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...input }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = startAdaptiveSessionSchema.parse({
          ...input,
          idempotencyKey: idempotencyKey ?? stableKey("flow-authoring-start", input),
        });
        return toolResult(
          { session: await client.post("/mission-flow-authoring", body) },
          "Mission-owned Flow authoring started.",
        );
      }, "Flow authoring start was rejected."),
  );
}
