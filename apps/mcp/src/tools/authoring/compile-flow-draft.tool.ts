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

export function registerCompileFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "compile_flow_draft",
    {
      title: "Compile Flow draft",
      description:
        "Compile all probe knowledge into one execution contract and return every blocker together.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        environmentId: uuid,
        draftVersion: z.number().int().positive(),
        probeSessionId: uuid,
        authenticationContractRevisionId: uuid.optional(),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ draftId, idempotencyKey, ...body }) =>
      result(
        {
          compilation: await client.post(`/flow-drafts/${draftId}/compile`, {
            ...body,
            idempotencyKey: idempotencyKey ?? stableKey("compile", { draftId, ...body }),
          }),
        },
        "Flow draft compiled.",
      ),
  );
}
