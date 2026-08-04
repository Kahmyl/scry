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

export function registerEnsureCalibrationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "ensure_calibration",
    {
      title: "Ensure protected operation calibration",
      description:
        "Find an effective attestation or idempotently create a disposable protected calibration session. Scry derives the operation digest and structure, exercises the protected operation once, and returns only safe actions. Call only with explicit user authorization and confirmed disposable data.",
      inputSchema: { projectId: uuid, calibration: requestCalibrationSchema },
      annotations: writes,
    },
    async ({ projectId, calibration }) =>
      result(
        {
          calibration: await client.post(
            `/projects/${projectId}/calibration-sessions`,
            calibration,
          ),
        },
        "Calibration resolved or queued. Follow only the returned safeActions.",
      ),
  );
}
