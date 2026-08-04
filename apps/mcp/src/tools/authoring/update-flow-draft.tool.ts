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

export function registerUpdateFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "update_flow_draft",
    {
      title: "Update Flow draft",
      description:
        "Apply a complete correction set to an unpublished draft using optimistic versioning.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        expectedVersion: z.number().int().positive(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).optional(),
        content: flowRevisionContentSchema.optional(),
        plan: currentPlanSchema.optional(),
        reason: z.string().trim().min(1).max(2000),
      },
      annotations: writes,
    },
    async ({ draftId, ...body }) =>
      result(
        { draft: await client.patch(`/flow-drafts/${draftId}`, body) },
        "Flow draft updated; prior compilation is stale.",
      ),
  );
}
