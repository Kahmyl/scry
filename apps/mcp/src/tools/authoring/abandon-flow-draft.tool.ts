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

export function registerAbandonFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "abandon_flow_draft",
    {
      title: "Abandon Flow draft",
      description: "Close obsolete unpublished authoring work while retaining its audit history.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(2000),
      },
      annotations: writes,
    },
    async ({ draftId, ...body }) =>
      result(
        { draft: await client.post(`/flow-drafts/${draftId}/abandon`, body) },
        "Flow draft abandoned; its history is retained.",
      ),
  );
}
