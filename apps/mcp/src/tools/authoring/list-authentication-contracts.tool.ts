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

export function registerListAuthenticationContractsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_authentication_contracts",
    {
      title: "List Authentication Contracts",
      description:
        "Read reusable environment-bound authentication setup without exposing browser state.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) =>
      result(
        {
          contracts: await client.get(`/projects/${projectId}/authentication-contracts`),
        },
        "Authentication Contracts loaded.",
      ),
  );
}
