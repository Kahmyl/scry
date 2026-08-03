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

export function registerGetMissionActivityTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_mission_activity",
    {
      title: "Get Mission activity",
      description: "Read the meaningful journey, optionally including technical supporting work.",
      inputSchema: {
        missionId: uuid,
        includeTechnical: z.boolean().default(false),
      },
      annotations: readOnly,
    },
    async ({ missionId, includeTechnical }) =>
      result(
        {
          activities: await client.get(
            `/missions/${missionId}/activities?technical=${includeTechnical}`,
          ),
        },
        "Mission activity loaded.",
      ),
  );
}
