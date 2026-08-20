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
        "List newest-created Missions before starting work. The external agent owns semantic comparison: ignore clearly unrelated Missions. If an existing non-terminal Mission plausibly overlaps the current request and the user has not already selected it, do not resume it automatically; tell the user what related Mission was found and ask whether to continue it or start distinct work.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) => {
      const missions = await client.get<unknown[]>(`/projects/${projectId}/missions`);
      return result({ missions }, `Found ${missions.length} Missions, newest-created first.`);
    },
  );
}
