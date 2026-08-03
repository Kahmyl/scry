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

export function registerListAuthenticatedSessionLeasesTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "list_authenticated_session_leases",
    {
      title: "List authenticated session leases",
      description:
        "Read sanitized encrypted-session lease metadata; cookies and storage are never returned.",
      inputSchema: { projectId: uuid },
      annotations: readOnly,
    },
    async ({ projectId }) =>
      result(
        {
          leases: await client.get(`/projects/${projectId}/authenticated-session-leases`),
        },
        "Authenticated session lease metadata loaded.",
      ),
  );
}
