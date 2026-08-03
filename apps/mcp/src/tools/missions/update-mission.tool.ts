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

export function registerUpdateMissionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "update_mission",
    {
      title: "Update Mission",
      description:
        "Correct the existing Mission title or original instruction instead of creating replacement work.",
      inputSchema: {
        ...missionContext,
        title: z.string().trim().min(1).max(200).optional(),
        originalInstruction: z.string().trim().min(1).max(20_000).optional(),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          mission: await client.patch(`/missions/${missionId}`, {
            missionId,
            ...body,
          }),
        },
        "Mission definition updated.",
      ),
  );
}
