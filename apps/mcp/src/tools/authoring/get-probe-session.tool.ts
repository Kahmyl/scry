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

export function registerGetProbeSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_probe_session",
    {
      title: "Get Probe Session",
      description: "Monitor authoring progress and read the consolidated safe correction set.",
      inputSchema: { probeSessionId: uuid },
      annotations: readOnly,
    },
    async ({ probeSessionId }) =>
      result(
        { probe: await client.get(`/probe-sessions/${probeSessionId}`) },
        "Probe Session loaded.",
      ),
  );
}
