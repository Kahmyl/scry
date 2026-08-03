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

export function registerListCalibrationsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_calibrations",
    {
      title: "List calibrations",
      description: "List calibration contracts and their effective decisions.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) =>
      result(
        {
          calibrations: await client.get<unknown[]>(`/projects/${projectId}/calibrations`),
        },
        "Calibrations loaded.",
      ),
  );
}
