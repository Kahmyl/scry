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

export function registerCancelCalibrationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "cancel_calibration",
    {
      title: "Cancel queued calibration",
      description: "Cancel a calibration before a worker claims it.",
      inputSchema: { ...objectiveContext, sessionId: uuid },
      annotations: writes,
    },
    async ({ sessionId, ...body }) =>
      result(
        {
          calibration: await client.post(`/calibration-sessions/${sessionId}/cancel`, body),
        },
        "Queued calibration cancelled.",
      ),
  );
}
