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
      description: `${action} scheduling while preserving Mission history and accepted evidence.`,
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
