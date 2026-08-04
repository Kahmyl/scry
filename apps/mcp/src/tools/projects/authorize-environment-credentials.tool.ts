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
        "Explicitly add opaque credential references to an existing environment allowlist. This never exposes credential values and never infers authorization from credential names or Flow contents.",
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
      const secretRefs = [...new Set([...environment.secretRefs, ...credentialIds])];
      const updated = await client.patch<{
        id: string;
        projectId: string;
        name: string;
        baseOrigin: string;
        secretRefs: string[];
      }>(`/environments/${environmentId}`, {
        baseOrigin: environment.baseOrigin,
        policy: environment.policy,
        missionId,
        objectiveId,
        agentSessionId,
        secretRefs,
      });
      return result(
        { environment: updated },
        `Authorized ${credentialIds.length} credential reference(s) for the environment.`,
      );
    },
  );
}
