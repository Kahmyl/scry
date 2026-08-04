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

export function registerSetMissionResumePointerTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "set_mission_resume_pointer",
    {
      title: "Set Mission resume pointer",
      description: "Persist the single authoritative next action for later agents and users.",
      inputSchema: {
        ...missionContext,
        pointer: missionResumePointerSchema.nullable(),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          mission: await client.patch(`/missions/${missionId}/resume-pointer`, {
            missionId,
            ...body,
          }),
        },
        "Mission resume pointer updated.",
      ),
  );
}
