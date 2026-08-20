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

export function registerCreateTestEnvironmentTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "create_test_environment",
    {
      title: "Create environment",
      description:
        "Create an approved execution environment and credential allowlist. policy requires 1-20 allowedOrigins; maxActions 1-500, maxDurationMs 1000-1800000, and maxNavigations 1-50 (navigation budget cannot be zero). policy.trustedScriptOrigins separately admits user-approved third-party scripts. Example policy: {allowedOrigins:['https://example.test'],trustedScriptOrigins:['https://scripts.example.test'],allowPrivateNetwork:false,allowDownloads:false,allowPopups:false,maxActions:10,maxDurationMs:60000,maxNavigations:2}. For a runtime ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED boundary, explicitly approve exactly environmentRecovery.missingTrustedScriptOrigins and use recover_trusted_script_origins; do not manually reconstruct or guess later origins. Scry never auto-trusts an origin.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        name: z.string().trim().min(1).max(200),
        baseOrigin: z.string().url(),
        policy: executionPolicySchema,
        secretRefs: z.array(uuid).max(100).default([]),
      },
      annotations: writes,
    },
    async ({ projectId, ...body }) =>
      result(
        {
          environment: await client.post(`/projects/${projectId}/environments`, body),
        },
        "Environment created.",
      ),
  );
}
