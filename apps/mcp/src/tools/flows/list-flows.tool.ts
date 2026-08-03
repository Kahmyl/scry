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

export function registerListFlowsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_flows",
    {
      title: "List Flows",
      description: "List current Flows and their latest immutable revisions.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) => {
      await client.requireCurrentRelease();
      const flows = await client.get<unknown[]>(`/projects/${projectId}/flows`);
      return result({ flows }, `Found ${flows.length} Flows.`);
    },
  );
}
