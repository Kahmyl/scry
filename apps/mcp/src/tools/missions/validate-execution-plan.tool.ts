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

export function registerValidateExecutionPlanTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "validate_execution_plan",
    {
      title: "Validate Mission execution plan",
      description:
        "Check objective coverage, immutable bindings, project consistency, and authorization prerequisites.",
      inputSchema: {
        missionId: uuid,
        planRevision: z.number().int().positive(),
      },
      annotations: readOnly,
    },
    async ({ missionId, planRevision }) =>
      result(
        {
          validation: await client.get(
            `/missions/${missionId}/execution-plans/${planRevision}/validate`,
          ),
        },
        "Execution plan validation completed.",
      ),
  );
}
