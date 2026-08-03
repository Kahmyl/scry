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

export function registerRevokeAuthenticatedSessionLeaseTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "revoke_authenticated_session_lease",
    {
      title: "Revoke authenticated session lease",
      description: "Revoke an encrypted reusable browser session without exposing its contents.",
      inputSchema: { leaseId: uuid },
      annotations: writes,
    },
    async ({ leaseId }) =>
      result(
        {
          lease: await client.post(`/authenticated-session-leases/${leaseId}/revoke`),
        },
        "Authenticated session lease revoked.",
      ),
  );
}
