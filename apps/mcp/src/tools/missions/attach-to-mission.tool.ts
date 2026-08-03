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

export function registerAttachToMissionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "attach_to_mission",
    {
      title: "Attach to Mission",
      description: "Alias for resuming an existing Mission from another agent connection.",
      annotations: writes,
      inputSchema: {
        missionId: uuid,
        instructionSnapshot: z.string().trim().min(1).max(20_000),
        provider: z.enum(["codex", "claude", "scry_agent", "human"]).default("codex"),
        connectionId: z.string().trim().min(1).max(500).optional(),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
    },
    async ({ missionId, idempotencyKey, ...body }) => {
      const session = await client.post(`/missions/${missionId}/agent-sessions`, {
        ...body,
        idempotencyKey: idempotencyKey ?? stableKey("mission-attach", { missionId, ...body }),
      });
      const mission = await client.get(`/missions/${missionId}`);
      return result(
        { session, mission },
        "Attached to Mission. Follow its persisted resume pointer.",
      );
    },
  );
}
