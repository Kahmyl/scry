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
        "Close an agent session after persisting the Mission resume pointer or terminal decision.",
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
