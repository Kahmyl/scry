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

export function registerListProjectCredentialsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_project_credentials",
    {
      title: "List project credentials",
      description: "List a bounded set of Project-scoped safe credential metadata: opaque reference, human name, active/compromised/revoked state, eligibility for authorization, authorized environment IDs with a per-item truncation flag, and timestamps—never values. Credentials persist independently across Missions. Refresh after dashboard creation through Project settings → Test credentials → Add credential. An external agent may use a unique obvious semantic match, but must not choose by order or among multiple plausible/role-ambiguous candidates; ask the human with safe names/refs instead. A supplied exact credential reference ID resolves precisely, subject to Project scope, active state, and later environment/task authorization. Top-level or per-item truncation forbids negative/uniqueness inference.",
      inputSchema: {
        projectId: uuid,
        credentialReferenceId: uuid.optional().describe(
          "Exact opaque credential reference supplied by the human; resolves only inside this Project.",
        ),
      },
      annotations: readOnly,
    },
    async ({ projectId, credentialReferenceId }) => {
      const credentials = await client.get<{ items: unknown[]; truncated: boolean }>(
        `/projects/${projectId}/credential-candidates${credentialReferenceId
          ? `?referenceId=${encodeURIComponent(credentialReferenceId)}` : ""}`,
      );
      return result({ credentials },
        `Found ${credentials.items.length} credential records${credentials.truncated ? "; more exist, so do not infer uniqueness" : ""}.`);
    },
  );
}
