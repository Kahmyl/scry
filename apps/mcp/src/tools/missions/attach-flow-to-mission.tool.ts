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

export function registerAttachFlowToMissionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "attach_flow_to_mission",
    {
      title: "Attach Flow to Mission",
      description:
        "Reuse an existing project Flow for an objective or explicitly promote it to the reusable library.",
      inputSchema: {
        ...objectiveContext,
        flowId: uuid,
        visibility: flowVisibilitySchema,
        purpose: flowPurposeSchema,
        reason: z.string().trim().min(1).max(2_000),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          flow: await client.post(`/missions/${missionId}/flows`, {
            missionId,
            ...body,
          }),
        },
        "Flow attached to Mission.",
      ),
  );
}
