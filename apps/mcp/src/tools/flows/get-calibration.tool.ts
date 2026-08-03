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

export function registerGetCalibrationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_calibration",
    {
      title: "Get calibration",
      description:
        "Inspect immutable calibration revisions, sessions, safe diagnostics, attestations, decisions, and safe actions.",
      inputSchema: { calibrationId: uuid },
      annotations: readOnly,
    },
    async ({ calibrationId }) =>
      result(
        { calibration: await client.get(`/calibrations/${calibrationId}`) },
        "Calibration loaded.",
      ),
  );
}
