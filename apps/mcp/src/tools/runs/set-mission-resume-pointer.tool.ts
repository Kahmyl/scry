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
      description:
        "Persist the single authoritative next action. For await_user, externalInput.lifecycle states that the same Mission/Objective remains active; provide only genuinely supported fulfillmentPaths with factual agentExposure, result, and continuation. For protected credentials expose both dashboard_managed (Project settings → Test credentials → Add credential; agentExposure none) and agent_assisted (create_project_credential; plaintext is visible to the agent before encrypted storage) when both are available. Do not publish failure/final report, retry blindly, continue background mutation, manufacture choices, or create a replacement Mission. externalInput.resumeRef is the bare durable Objective UUID string and must exactly equal pointer.objectiveId; never prefix it with 'objective:' or use an operation/session reference. Later agents recover with resume_mission.",
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
