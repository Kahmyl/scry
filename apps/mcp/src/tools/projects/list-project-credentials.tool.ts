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
      description: "List a bounded set of Project-scoped safe credential metadata—never values. Supply missionId whenever a Mission has been selected. Each result then includes factual usedInMission: true when the credential was created for that Mission or has already appeared in a recorded protected operation for that Mission, false when no such evidence exists; without missionId it is null. usedInMission=true allows an active/applicable credential to be reused without asking again. usedInMission=false or null means the credential is only a Project candidate: even a unique or obvious semantic match does not authorize first Mission use. When user choice is required, always present \"Create a new credential set\" as an explicit alternative alongside the existing credential choices; do not wait for the user to reject every existing candidate first. A new set has two supported fulfillment routes: the user may add it through Project settings → Test credentials → Add credential, or explicitly entrust plaintext to the agent-assisted create_project_credential path. A supplied exact credential reference resolves precisely but does not itself grant first-use authority. Environment authorization alone is not Mission reuse authority. Top-level or per-item truncation forbids negative or uniqueness inference.",
      inputSchema: {
        projectId: uuid,
        credentialReferenceId: uuid.optional().describe(
          "Exact opaque credential reference supplied by the human; resolves only inside this Project.",
        ),
        missionId: uuid.optional().describe(
          "Selected Mission whose factual credential-use history should be reported. Omit only when no Mission has been selected.",
        ),
      },
      annotations: readOnly,
    },
    async ({ projectId, credentialReferenceId, missionId }) => {
      const parameters: string[] = [];
      if (credentialReferenceId)
        parameters.push(`referenceId=${encodeURIComponent(credentialReferenceId)}`);
      if (missionId)
        parameters.push(`missionId=${encodeURIComponent(missionId)}`);
      const query = parameters.length ? `?${parameters.join("&")}` : "";
      const credentials = await client.get<{ items: unknown[]; truncated: boolean }>(
        `/projects/${projectId}/credential-candidates${query}`,
      );
      const credentialCreationAlternative = {
        available: true,
        kind: "create_new_credential_set" as const,
        label: "Create a new credential set",
        routes: [
          {
            kind: "dashboard_managed" as const,
            location: "Project settings → Test credentials → Add credential",
            plaintextSeenByAgent: false,
          },
          {
            kind: "agent_assisted" as const,
            tool: "create_project_credential",
            requiresExplicitPlaintextFromUser: true,
            plaintextSeenByAgent: true,
          },
        ],
      };

      return result(
        { credentials, credentialCreationAlternative },
        `Found ${credentials.items.length} credential records${credentials.truncated ? "; more exist, so do not infer uniqueness" : ""}. When credential choice is required, present "Create a new credential set" as an explicit option alongside the existing choices.`,
      );
    },
  );
}
