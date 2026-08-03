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

export function registerActivateExecutionPlanTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "activate_execution_plan",
    {
      title: "Activate Mission execution plan",
      description:
        "Activate one explicitly approved plan revision and let Scry calculate readiness.",
      inputSchema: {
        ...missionContext,
        planRevision: z.number().int().positive(),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          orchestration: await client.post(`/missions/${missionId}/execution-plans/activate`, {
            missionId,
            ...body,
          }),
        },
        "Execution plan activated; Scry readiness is authoritative.",
      ),
  );
}
