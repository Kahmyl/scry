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

export function registerStartReadyObjectivesTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_ready_objectives",
    {
      title: "Start ready approved objectives",
      description:
        "Ask Scry to claim and start currently ready automated objectives without exceeding project concurrency.",
      inputSchema: {
        ...missionContext,
        objectiveIds: z.array(uuid).max(500).optional(),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          orchestration: await client.post(`/missions/${missionId}/orchestration/start-ready`, {
            missionId,
            ...body,
          }),
        },
        "Ready objectives were scheduled subject to authoritative readiness and available slots.",
      ),
  );
}
