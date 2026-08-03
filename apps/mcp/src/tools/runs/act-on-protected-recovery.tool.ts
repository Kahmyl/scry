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

export function registerActOnProtectedRecoveryTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "act_on_protected_recovery",
    {
      title: "Act on protected acquisition recovery",
      description:
        "Retry an approved acquisition method, request secure assistance, revoke, or abandon. This never repeats the mutation.",
      inputSchema: {
        runId: uuid,
        operationId: z.string().min(1).max(128),
        ...protectedRecoveryCommandSchema.shape,
      },
      annotations: writes,
    },
    async ({ runId, operationId, ...body }) =>
      result(
        {
          recovery: await client.post(
            `/runs/${runId}/protected-transactions/${operationId}/recovery`,
            body,
          ),
        },
        "Protected recovery action recorded.",
      ),
  );
}
