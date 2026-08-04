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

export function registerGetOrchestrationStatusTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_orchestration_status",
    {
      title: "Inspect Mission orchestration",
      description:
        "List ready, running, waiting, blocked, manual, and completed objectives plus active project slots.",
      inputSchema: { missionId: uuid },
      annotations: readOnly,
    },
    async ({ missionId }) =>
      result(
        {
          orchestration: await client.get(`/missions/${missionId}/orchestration`),
        },
        "Authoritative orchestration status loaded.",
      ),
  );
}
