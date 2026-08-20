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

export function registerAuthorizeEnvironmentCredentialsTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "authorize_environment_credentials",
    {
      title: "Authorize environment credentials",
      description:
        "Authorize explicitly selected opaque Project credential references for an environment and admit only those selected references into matching non-terminal Praxis sessions for this exact Mission/Objective/agent-session context. Use this only after Mission credential-selection authority already exists. If list_project_credentials for the selected missionId reports usedInMission=false or null, the user must explicitly choose that existing credential before this call. usedInMission=true may be reused when active and applicable. Environment secret_refs, credentials selected for another Mission, or semantic name matches are not authority. User-managed and agent-assisted credentials remain opaque here; this never exposes credential values.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        environmentId: uuid,
        credentialIds: z.array(uuid).min(1).max(100),
      },
      annotations: writes,
    },
    async ({ projectId, environmentId, credentialIds, missionId, objectiveId, agentSessionId }) => {
      const environments = await client.get<
        Array<{
          id: string;
          baseOrigin: string;
          policy: z.infer<typeof executionPolicySchema>;
          secretRefs: string[];
        }>
      >(`/projects/${projectId}/environments`);
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error("Environment not found in the selected project.");

      const {
        externalResourcePresentationAuthorities: serverManagedPresentationAuthorities,
        ...writablePolicy
      } = environment.policy;
      void serverManagedPresentationAuthorities;

      const secretRefs = [...new Set([...environment.secretRefs, ...credentialIds])];
      const updated = await client.patch<{
        id: string;
        projectId: string;
        name: string;
        baseOrigin: string;
        secretRefs: string[];
        admittedPraxisSessionCount: number;
      }>(`/environments/${environmentId}`, {
        baseOrigin: environment.baseOrigin,
        policy: writablePolicy,
        missionId,
        objectiveId,
        agentSessionId,
        missionCredentialSelectionRefs: credentialIds,
        secretRefs,
      });
      return result(
        { environment: updated },
        `Authorized ${credentialIds.length} selected credential reference(s) for the environment and admitted them into ${updated.admittedPraxisSessionCount ?? 0} matching Praxis session(s).`,
      );
    },
  );
}
