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

export function registerGetMissionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_mission",
    {
      title: "Get Mission context",
      description:
        "Read objectives, supporting Flows, classified Runs, accepted evidence, reports, and resume pointer.",
      inputSchema: { missionId: uuid },
      annotations: readOnly,
    },
    async ({ missionId }) =>
      result({ mission: await client.get(`/missions/${missionId}`) }, "Mission context loaded."),
  );
}
