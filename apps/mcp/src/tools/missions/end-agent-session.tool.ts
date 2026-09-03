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

export function registerEndAgentSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "end_agent_session",
    {
      title: "End agent session",
      description:
        "Required final lifecycle write after persisting a Mission resume pointer, reviewed terminal Objective decision, or final report. When a final Mission report is still intended in the current interaction, publish that report before ending the current agent session. Use completed when external work reached its intended terminal boundary, interrupted when resumable work stopped, and failed when no safe continuation remains.",
      inputSchema: {
        agentSessionId: uuid,
        status: z.enum(["completed", "interrupted", "failed"]),
      },
      annotations: writes,
    },
    async ({ agentSessionId, status }) =>
      result(
        {
          session: await client.post(`/agent-sessions/${agentSessionId}/end`, {
            status,
          }),
        },
        "Agent session ended.",
      ),
  );
}
