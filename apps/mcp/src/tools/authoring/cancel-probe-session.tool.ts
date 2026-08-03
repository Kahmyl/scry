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

export function registerCancelProbeSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "cancel_probe_session",
    {
      title: "Cancel Probe Session",
      description: "Request cancellation without creating a Run result.",
      inputSchema: { ...missionContext, probeSessionId: uuid },
      annotations: writes,
    },
    async ({ probeSessionId, ...body }) =>
      result(
        {
          probe: await client.post(`/probe-sessions/${probeSessionId}/cancel`, body),
        },
        "Probe cancellation requested.",
      ),
  );
}
