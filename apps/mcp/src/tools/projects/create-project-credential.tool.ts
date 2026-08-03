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

export function registerCreateProjectCredentialTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "create_project_credential",
    {
      title: "Create project credential",
      description:
        "Create a new encrypted credential only when the user explicitly supplied its value for this project and requested this use. Never infer a value, reuse transcript content from another purpose, or call this to replace an existing credential. Stored values can never be read back through MCP.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        name: z.string().trim().min(1).max(200),
        value: z
          .string()
          .min(1)
          .max(20_000)
          .describe("Sensitive value explicitly supplied by the user for this credential."),
        purpose: z.string().trim().min(1).max(500),
        confirmedUserProvided: z
          .literal(true)
          .describe(
            "Confirms the user explicitly supplied this value for the stated project and purpose.",
          ),
      },
      annotations: writes,
    },
    async ({ projectId, missionId, objectiveId, agentSessionId, name, value }) => {
      const created = await client.post<{
        id: string;
        projectId: string;
        name: string;
        createdAt: string;
        updatedAt: string;
      }>(`/projects/${projectId}/credentials`, {
        missionId,
        objectiveId,
        agentSessionId,
        name,
        value,
      });
      const credential = {
        id: created.id,
        projectId: created.projectId,
        name: created.name,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
      return result(
        { credential },
        "Credential encrypted and stored. Its value cannot be read back through MCP.",
      );
    },
  );
}
