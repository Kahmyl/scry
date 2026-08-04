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

export function registerCreateMissionObjectiveTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "create_mission_objective",
    {
      title: "Create Mission objective",
      description: "Create an ordered, user-visible completion objective.",
      inputSchema: {
        ...missionContext,
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).default(""),
        dependencies: z.array(uuid).max(100).default([]),
        completionCriteria: z
          .array(
            z
              .object({
                description: z.string().trim().min(1).max(2_000),
                required: z.boolean().default(true),
              })
              .strict(),
          )
          .min(1),
        order: z.number().int().nonnegative(),
      },
      annotations: writes,
    },
    async ({ missionId, ...body }) =>
      result(
        {
          objective: await client.post(`/missions/${missionId}/objectives`, {
            missionId,
            ...body,
          }),
        },
        "Objective created.",
      ),
  );
}
