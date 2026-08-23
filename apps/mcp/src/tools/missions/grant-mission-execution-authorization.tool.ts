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
  grantMissionAuthorizationSchema,
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

export function registerGrantMissionExecutionAuthorizationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "grant_mission_execution_authorization",
    {
      title: "Grant Mission execution authorization",
      description:
        "Persist explicit owner/admin authorization for one scoped Live or protected operation. Set authorization.kind=protected_mutation with authorization.operationId for the exact intent/operation and authorization.praxisSessionId for the exact live protected Praxis session, alongside the current Mission, Objective, agent-session, and environment IDs in that canonical authorization object. Use the returned authorization ID only for that bound operation; authorization is never inferred or portable across a new session/document.",
      inputSchema: z.object({ authorization: grantMissionAuthorizationSchema }).strict(),
      annotations: writes,
    },
    async ({ authorization: { missionId, ...body } }) =>
      result(
        {
          authorization: await client.post(`/missions/${missionId}/authorizations`, {
            missionId,
            ...body,
          }),
        },
        "Explicit scoped execution authorization recorded.",
      ),
  );
}
