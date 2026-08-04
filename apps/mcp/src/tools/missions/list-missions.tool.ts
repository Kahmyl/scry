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

export function registerListMissionsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_missions",
    {
      title: "List project Missions",
      description:
        "List newest-created Missions before starting work so related non-terminal work can be resumed or edited.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) => {
      const missions = await client.get<unknown[]>(`/projects/${projectId}/missions`);
      return result({ missions }, `Found ${missions.length} Missions, newest-created first.`);
    },
  );
}
