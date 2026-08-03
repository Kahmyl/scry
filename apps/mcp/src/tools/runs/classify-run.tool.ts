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

export function registerClassifyRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "classify_run",
    {
      title: "Classify Mission Run",
      description: "Classify a Run's purpose within its Mission.",
      inputSchema: {
        ...missionContext,
        runId: uuid,
        role: runRoleSchema,
        reason: z.string().trim().min(1).max(2_000),
      },
      annotations: writes,
    },
    async ({ runId, ...body }) =>
      result({ run: await client.post(`/runs/${runId}/classification`, body) }, "Run classified."),
  );
}
