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

export function registerRelateMissionActivityTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "relate_mission_activity",
    {
      title: "Relate Mission activity",
      description: "Persist an explicit causal relationship between two activities in one Mission.",
      inputSchema: {
        ...missionContext,
        fromActivityId: uuid,
        toActivityId: uuid,
        relation: z.enum([
          "caused_by",
          "diagnoses",
          "replaces",
          "depends_on",
          "produced",
          "verified_by",
          "accepted_for",
        ]),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          relation: await client.post(`/missions/${missionId}/activity-relations`, {
            missionId,
            ...body,
          }),
        },
        "Causal activity relationship recorded.",
      ),
  );
}
