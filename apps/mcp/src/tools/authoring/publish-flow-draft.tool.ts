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

export function registerPublishFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "publish_flow_draft",
    {
      title: "Publish execution-ready Flow",
      description: "Freeze an execution-ready draft as one immutable Flow revision.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        expectedVersion: z.number().int().positive(),
        compilationId: uuid,
        visibility: flowVisibilitySchema.default("mission_local"),
        purpose: flowPurposeSchema.default("primary"),
        reason: z.string().trim().min(1).max(2000),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ draftId, idempotencyKey, ...body }) =>
      result(
        {
          publication: await client.post(`/flow-drafts/${draftId}/publish`, {
            ...body,
            idempotencyKey: idempotencyKey ?? stableKey("publish", { draftId, ...body }),
          }),
        },
        "Execution-ready Flow revision published.",
      ),
  );
}
