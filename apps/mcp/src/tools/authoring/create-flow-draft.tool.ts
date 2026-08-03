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

export function registerCreateFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "create_flow_draft",
    {
      title: "Create Flow draft",
      description: "Create mutable authoring state; this does not publish a Flow revision.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        environmentId: uuid,
        flowId: uuid.optional(),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).default(""),
        content: flowRevisionContentSchema,
        plan: currentPlanSchema,
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...body }) =>
      result(
        {
          draft: await client.post("/flow-drafts", {
            ...body,
            idempotencyKey: idempotencyKey ?? stableKey("draft", body),
          }),
        },
        "Mutable Flow draft created.",
      ),
  );
}
