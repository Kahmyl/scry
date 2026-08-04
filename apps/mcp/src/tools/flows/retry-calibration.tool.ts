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

export function registerRetryCalibrationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "retry_calibration",
    {
      title: "Retry safe calibration preflight",
      description: "Retry a failed or sealed calibration session only when no mutation began.",
      inputSchema: {
        ...objectiveContext,
        sessionId: uuid,
        idempotencyKey: z.string().trim().min(8).max(200),
      },
      annotations: writes,
    },
    async ({ sessionId, ...body }) =>
      result(
        {
          calibration: await client.post(`/calibration-sessions/${sessionId}/retry`, body),
        },
        "Calibration session queued for a fenced retry.",
      ),
  );
}
