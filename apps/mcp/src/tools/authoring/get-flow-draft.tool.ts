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

export function registerGetFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_flow_draft",
    {
      title: "Get Flow draft context",
      description:
        "Read draft versions, Probe Sessions, consolidated diagnostics, and compilations.",
      inputSchema: { draftId: uuid },
      annotations: readOnly,
    },
    async ({ draftId }) =>
      result({ draft: await client.get(`/flow-drafts/${draftId}`) }, "Flow draft context loaded."),
  );
}
