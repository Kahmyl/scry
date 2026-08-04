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

export function registerCreateExecutionPlanTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "create_execution_plan",
    {
      title: "Create Mission execution plan",
      description:
        "Bind every objective to manual work or an immutable Flow revision and environment.",
      inputSchema: {
        ...missionContext,
        bindings: z.array(executionBindingSchema).min(1).max(500),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ missionId, idempotencyKey, ...body }) =>
      result(
        {
          plan: await client.post(`/missions/${missionId}/execution-plans`, {
            missionId,
            ...body,
            idempotencyKey: idempotencyKey ?? stableKey("execution-plan", { missionId, ...body }),
          }),
        },
        "Execution plan drafted. Validate it before activation.",
      ),
  );
}
