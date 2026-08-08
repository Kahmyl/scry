import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  adaptiveSessionOperationInputSchema,
  adaptiveSessionTransitionSchema,
  advanceAdaptiveSessionTurnSchema,
  startAdaptiveSessionSchema,
} from "@scry/contracts";
import { z } from "zod";

import { ScryApiError, type ScryApiClient } from "../../api-client.js";
import { readOnly, stableKey, toolResult, uuid, writes } from "../../tool-registry.js";

export function registerAdaptiveSessionTools(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_adaptive_session",
    {
      title: "Start Adaptive Session",
      description:
        "Start mission-independent adaptive authoring. Mission, Objective, and Flow tools remain optional compatibility adapters and are not execution prerequisites.",
      inputSchema: {
        ...startAdaptiveSessionSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: startAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...input }) => {
      return withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = startAdaptiveSessionSchema.parse({
          ...input,
          idempotencyKey: idempotencyKey ?? stableKey("adaptive-session-start", input),
        });
        return toolResult(
          { session: await client.post("/adaptive-sessions", body) },
          "Adaptive Session started without requiring Mission, Objective, or Flow state.",
        );
      }, "Adaptive Session start was rejected.");
    },
  );

  server.registerTool(
    "advance_adaptive_session",
    {
      title: "Advance Adaptive Session",
      description:
        "Advance up to 20 deterministic operations in one server-owned turn through the shared execution kernel. Returns only after a typed boundary; no client polling is required.",
      inputSchema: {
        sessionId: uuid,
        operations: z
          .array(
            z
              .object({
                ...adaptiveSessionOperationInputSchema.shape,
                idempotencyKey: z.string().trim().min(8).max(200).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        budgets: advanceAdaptiveSessionTurnSchema.shape.budgets,
        idempotencyKey: advanceAdaptiveSessionTurnSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ sessionId, idempotencyKey, operations, budgets }) => {
      return withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const normalizedOperations = operations.map((operation, index) => ({
          ...operation,
          idempotencyKey:
            operation.idempotencyKey ??
            stableKey("adaptive-session-operation", { sessionId, index, operation }),
        }));
        const body = advanceAdaptiveSessionTurnSchema.parse({
          operations: normalizedOperations,
          budgets,
          idempotencyKey:
            idempotencyKey ??
            stableKey("adaptive-session-turn", { sessionId, operations: normalizedOperations }),
        });
        return toolResult(
          { session: await client.post(`/adaptive-sessions/${sessionId}/advance`, body) },
          "Adaptive Session turn reached a durable typed decision boundary.",
        );
      }, "Adaptive Session advance was rejected.");
    },
  );

  server.registerTool(
    "get_adaptive_session",
    {
      title: "Get Adaptive Session",
      description:
        "Read the durable state, append-only operation journal, and current decision boundary for an Adaptive Session.",
      inputSchema: { sessionId: uuid },
      annotations: readOnly,
    },
    async ({ sessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            { session: await client.get(`/adaptive-sessions/${sessionId}`) },
            "Adaptive Session loaded.",
          ),
        "Adaptive Session read was rejected.",
      ),
  );

  registerTransitionTool(server, client, {
    name: "suspend_adaptive_session",
    title: "Suspend Adaptive Session",
    action: "suspend",
    description:
      "Suspend an active Adaptive Session at a durable boundary without introducing Mission or Flow execution state.",
    message: "Adaptive Session suspended at a durable boundary.",
  });
  registerTransitionTool(server, client, {
    name: "resume_adaptive_session",
    title: "Resume Adaptive Session",
    action: "resume",
    description:
      "Resume a suspended or recovery-required Adaptive Session through the existing shared execution lifecycle.",
    message: "Adaptive Session resumed.",
  });
  registerTransitionTool(server, client, {
    name: "cancel_adaptive_session",
    title: "Cancel Adaptive Session",
    action: "cancel",
    description:
      "Cancel an Adaptive Session durably. This does not duplicate or bypass execution owned by the shared kernel.",
    message: "Adaptive Session cancelled.",
  });
}

function registerTransitionTool(
  server: McpServer,
  client: ScryApiClient,
  options: {
    name: "suspend_adaptive_session" | "resume_adaptive_session" | "cancel_adaptive_session";
    title: string;
    action: "suspend" | "resume" | "cancel";
    description: string;
    message: string;
  },
) {
  server.registerTool(
    options.name,
    {
      title: options.title,
      description: options.description,
      inputSchema: {
        sessionId: uuid,
        ...adaptiveSessionTransitionSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: adaptiveSessionTransitionSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ sessionId, idempotencyKey, ...input }) => {
      return withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = adaptiveSessionTransitionSchema.parse({
          ...input,
          idempotencyKey:
            idempotencyKey ??
            stableKey(`adaptive-session-${options.action}`, { sessionId, ...input }),
        });
        return toolResult(
          {
            session: await client.post(`/adaptive-sessions/${sessionId}/${options.action}`, body),
          },
          options.message,
        );
      }, `Adaptive Session ${options.action} was rejected.`);
    },
  );
}

async function withAdaptiveSessionError<T>(operation: () => Promise<T>, rejectionMessage: string) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ScryApiError)) throw error;
    return {
      ...toolResult(
        {
          rejection: {
            code: error.code,
            status: error.status,
            safeActions: error.safeActions,
          },
        },
        rejectionMessage,
      ),
      isError: true,
    };
  }
}
