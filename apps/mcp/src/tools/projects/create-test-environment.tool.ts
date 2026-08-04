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
      description: "Create an approved execution environment and credential allowlist.",
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
