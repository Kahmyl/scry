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
  agentSessionFinalization,
  missionContext,
  objectiveContext,
  readOnly,
  stableKey,
  toolResult as result,
  uuid,
  writes,
} from "../../tool-registry.js";

export function registerUpdateMissionObjectiveTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "update_mission_objective",
    {
      title: "Update Mission objective",
      description:
        "Revise an existing Objective or explicitly record its reviewed terminal conclusion instead of replacing the Mission. Terminal status responses include agentSessionFinalization naming the required end_agent_session call.",
      inputSchema: {
        ...missionContext,
        objectiveId: uuid,
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2_000).optional(),
        dependencies: z.array(uuid).max(100).optional(),
        completionCriteria: z
          .array(
            z
              .object({
                description: z.string().trim().min(1).max(2_000),
                required: z.boolean().default(true),
              })
              .strict(),
          )
          .min(1)
          .optional(),
        order: z.number().int().nonnegative().optional(),
        status: z.enum(["pending", "running", "passed", "failed", "blocked", "skipped"]).optional(),
        conclusion: z.string().trim().min(1).max(5000).optional(),
      },
      annotations: writes,
    },
    async ({ objectiveId, agentSessionId, ...body }) =>
      result(
        {
          objective: await client.patch(`/objectives/${objectiveId}`, { agentSessionId, ...body }),
          ...(["passed", "failed", "blocked", "skipped"].includes(body.status ?? "")
            ? agentSessionFinalization(
                agentSessionId,
                body.status === "passed" || body.status === "skipped" ? "completed" : "failed",
              )
            : {}),
        },
        "Objective updated after explicit review.",
      ),
  );
}
