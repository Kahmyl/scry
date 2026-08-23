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
  idempotentExternalOpenWorldOperation,
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

export function registerStartPraxisSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_praxis_session",
    {
      title: "Start live Praxis session",
      description:
        "Start an agent-owned live Praxis browser session. agentSessionId must be the exact active Mission agent-session ID returned to this external agent by start_mission or resume_mission under the current user's Mission choice; never invent, generate, guess, or substitute an authoring/Praxis session ID. If this agent has not established Mission authority and an existing Mission merely appears related, call list_missions and ask the user whether to continue it or start distinct work. Only after the user explicitly chose continuation may the agent call resume_mission and use the agentSessionId returned by that call. authoring.reusable.sessionId is not an agentSessionId, and runtime_admitted is not proof that its browser process is still live. Set protection=protected before protected observation or dispatch. The Praxis session owns Page/document identity and opaque references; it does not create a Run or choose an operation.",
      inputSchema: {
        ...startAdaptiveSessionSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: startAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      outputSchema: z.object({ message: z.string(), session: adaptiveSessionSchema }).strict(),
      annotations: idempotentExternalOpenWorldOperation,
    },
    async ({ idempotencyKey, ...input }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = startAdaptiveSessionSchema.parse({
          ...input,
          idempotencyKey: idempotencyKey ?? stableKey("praxis-session-start", input),
        });
        return toolResult(
          { session: await client.post("/praxis-sessions", body) },
          "Live Praxis session started; observe before selecting a target.",
        );
      }, "Praxis session start refused."),
  );
}
