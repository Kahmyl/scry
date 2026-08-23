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

export function registerPrepareFlowAuthoringTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "prepare_flow_authoring",
    {
      title: "Prepare Flow Authoring",
      description:
        "Atomically create the supplied durable Mission, agent session, first Objective, Flow draft, and provisioning authoring session, then admit browser runtime before returning success. A runtime admission failure preserves the durable lifecycle and returns factual recovery; it is not an atomic browser-side effect. Reuse only an exact active authoringSessionId returned by get_operating_context. This performs no authored browser navigation or product action and never infers equivalence between Missions or Objectives.",
      inputSchema: {
        kind: z.enum(["create", "reuse"]),
        projectId: uuid,
        environmentId: uuid.optional(),
        authoringSessionId: uuid.optional(),
        mission: z
          .object({
            title: z.string().trim().min(1).max(200),
            originalInstruction: z.string().trim().min(1).max(20_000),
            instructionSnapshot: z.string().trim().min(1).max(20_000),
            connectionId: z.string().trim().min(1).max(500).optional(),
            distinctReason: z.string().trim().min(1).max(2_000).optional(),
          })
          .strict()
          .optional(),
        objective: z
          .object({
            title: z.string().trim().min(1).max(200),
            description: z.string().trim().max(2_000).default(""),
            dependencies: z.array(uuid).max(0).default([]),
            completionCriteria: z
              .array(
                z
                  .object({
                    description: z.string().trim().min(1).max(2_000),
                    required: z.boolean().default(true),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
            order: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        draft: z
          .object({
            name: z.string().trim().min(1).max(200),
            description: z.string().trim().max(2_000).default(""),
            purpose: flowDraftPurposeSchema.default("primary"),
            content: flowRevisionContentSchema,
            plan: publicPlanSchema,
          })
          .strict()
          .optional(),
        authoring: z
          .object({
            objective: z.string().trim().min(1).max(4_000),
            allowedOrigins: z.array(z.string().url()).min(1).max(20),
            turnBudgets: missionAuthoringTurnBudgetsSchema.default({
              maxOperations: 20,
              maxDurationMs: 60_000,
            }),
            initialProtectedReferenceIds: z.array(uuid).max(20).default([]),
          })
          .strict()
          .optional(),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
      outputSchema: preparedFlowAuthoringSchema.extend({ message: z.string() }),
      annotations: writes,
    },
    async (input) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = prepareFlowAuthoringSchema.parse(
          input.kind === "create" && input.mission
            ? {
                ...input,
                mission: { ...input.mission, ...client.missionProvenance() },
              }
            : input,
        );
        const prepared = preparedFlowAuthoringSchema.parse(
          await client.post("/mission-flow-authoring/prepare", body),
        );
        return toolResult(
          prepared,
          prepared.reused
            ? "Existing authoring session is ready."
            : "Flow authoring lifecycle prepared atomically.",
        );
      }, "Flow authoring preparation was rejected."),
  );
}
