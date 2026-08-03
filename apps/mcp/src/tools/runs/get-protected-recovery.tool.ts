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

export function registerGetProtectedRecoveryTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_protected_recovery",
    {
      title: "Get protected acquisition recovery",
      description: "Inspect the bounded recovery state without exposing protected values.",
      inputSchema: { runId: uuid, operationId: z.string().min(1).max(128) },
      annotations: readOnly,
    },
    async ({ runId, operationId }) =>
      result(
        {
          recovery: await client.get(
            `/runs/${runId}/protected-transactions/${operationId}/recovery`,
          ),
        },
        "Protected recovery state loaded.",
      ),
  );
}
