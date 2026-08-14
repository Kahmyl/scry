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

export function registerPublishMissionReportTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "publish_mission_report",
    {
      title: "Publish Mission report",
      description:
        "Publish an immutable consolidated FINAL report only after all required Objectives are terminal. awaiting_user is non-terminal and is rejected; communicate it as an intermediate user message, fulfill the prerequisite, and resume the same Mission instead.",
      inputSchema: {
        ...missionContext,
        overallConclusion: z.string().trim().min(1).max(20_000),
        journeySummary: z.array(z.string().trim().min(1).max(2_000)).min(1).max(500),
        remainingActions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
        expectedRevision: z.number().int().nonnegative(),
      },
      annotations: writes,
    },
    async ({ missionId, agentSessionId, ...body }) =>
      result(
        {
          report: await client.post(`/missions/${missionId}/reports`, {
            missionId,
            agentSessionId,
            ...body,
          }),
          ...agentSessionFinalization(agentSessionId, "completed"),
        },
        "Immutable Mission report published.",
      ),
  );
}
