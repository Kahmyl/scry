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

export function registerListProjectCredentialsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_project_credentials",
    {
      title: "List project credentials",
      description: "List credential references without exposing values.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) => {
      const credentials = await client.get<unknown[]>(`/projects/${projectId}/credentials`);
      return result({ credentials }, `Found ${credentials.length} credentials.`);
    },
  );
}
