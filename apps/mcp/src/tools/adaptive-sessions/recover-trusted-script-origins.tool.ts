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

export function registerRecoverTrustedScriptOriginsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "recover_trusted_script_origins",
    {
      title: "Recover trusted script origins",
      description:
        "Atomically recover an ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED boundary. approvedOrigins must exactly match the safely disclosed missingTrustedScriptOrigins on the source authoring session; this call records explicit approval but never chooses or guesses origins. It creates an immutable replacement environment, cloned Mission-owned Flow draft, and replacement authoring session. Navigation is not performed and remains a separate advance_flow_authoring action.",
      inputSchema: {
        ...recoverTrustedOriginsSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: recoverTrustedOriginsSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...input }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = recoverTrustedOriginsSchema.parse({
          ...input,
          idempotencyKey: idempotencyKey ?? stableKey("trusted-origin-recovery", input),
        });
        return toolResult(
          { recovery: await client.post("/mission-flow-authoring/recover-trusted-origins", body) },
          "Trusted-origin recovery lifecycle created atomically; navigation remains pending.",
        );
      }, "Trusted-origin recovery was rejected."),
  );
}
