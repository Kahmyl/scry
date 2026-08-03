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

export function registerListMissionFlowDraftsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_mission_flow_drafts",
    {
      title: "List Mission Flow drafts",
      description: "List authoring work without mixing it into Runs.",
      inputSchema: { missionId: uuid },
      annotations: readOnly,
    },
    async ({ missionId }) =>
      result(
        { drafts: await client.get(`/missions/${missionId}/flow-drafts`) },
        "Mission authoring drafts loaded.",
      ),
  );
}
