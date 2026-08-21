import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  flowRevisionContentSchema,
  currentPlanSchema,
  executionPolicySchema,
  requestCalibrationSchema,
  flowPurposeSchema,
  flowVisibilitySchema,
  runRoleSchema,
  missionResumePointerSchema,
  executionBindingSchema,
  authorizationKindSchema,
  protectedRecoveryCommandSchema,
  veilPreferenceUpdateSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import {
  missionContext,
  objectiveContext,
  readOnly,
  stableKey,
  toolResult as result,
  uuid,
  writes,
} from "../../tool-registry.js";

export function registerCancelMissionOrchestrationTool(server: McpServer, client: ScryApiClient) {
  const action = "cancel" as const;
  server.registerTool(
    `${action}_mission_orchestration`,
    {
      title: `${action} Mission orchestration`,
      description:
        "Use only for an explicit user cancellation or another authoritative cancellation decision. This stops Mission scheduling while preserving Mission history and accepted evidence; it is not the response to an obtainable awaiting_user prerequisite, which should remain non-terminal and resumable.",
      inputSchema: {
        ...missionContext,
        reason: z.string().trim().min(1).max(2000),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          orchestration: await client.post(`/missions/${missionId}/orchestration/${action}`, {
            missionId,
            ...body,
          }),
        },
        `Mission orchestration ${action} request recorded.`,
      ),
  );
}
