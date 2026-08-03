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

export function registerGrantMissionExecutionAuthorizationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "grant_mission_execution_authorization",
    {
      title: "Grant Mission execution authorization",
      description:
        "Persist explicit owner/admin authorization for a scoped Live or protected operation. Authorization is never inferred.",
      inputSchema: {
        ...objectiveContext,
        environmentId: uuid,
        kind: authorizationKindSchema,
        reason: z.string().trim().min(1).max(2000),
        expiresAt: z.string().datetime().optional(),
        confirmedUserAuthorized: z.literal(true),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          authorization: await client.post(`/missions/${missionId}/authorizations`, {
            missionId,
            ...body,
          }),
        },
        "Explicit scoped execution authorization recorded.",
      ),
  );
}
