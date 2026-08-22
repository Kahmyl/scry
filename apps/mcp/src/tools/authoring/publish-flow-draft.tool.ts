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

import { apiRejection, ScryApiError, type ScryApiClient } from "../../api-client.js";
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
      title: "Publish Flow representation",
      description:
        "Freeze a mechanically valid draft as one immutable representation-only Flow revision. The returned publication.revisionId is the Flow revision identifier used by start_run; draftId is not a Flow revision ID. Publication does not compile, certify, admit, or execute browser operations.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        expectedVersion: z.number().int().positive(),
        visibility: flowVisibilitySchema.default("mission_local"),
        purpose: flowPurposeSchema.default("primary"),
        reason: z.string().trim().min(1).max(2000),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ draftId, idempotencyKey, ...body }) => {
      try {
        await client.requireCurrentRelease();
        const publication = await client.post(`/flow-drafts/${draftId}/publish`, {
          ...body,
          idempotencyKey: idempotencyKey ?? stableKey("publish", { draftId, ...body }),
        });
        return result(
          { publication },
          "Immutable representation-only Flow revision published; no compilation or certification admits execution.",
        );
      } catch (error) {
        if (!(error instanceof ScryApiError)) throw error;
        return {
          ...result(
            {
              rejection: apiRejection(error),
            },
            "Flow publication was rejected.",
          ),
          isError: true,
        };
      }
    },
  );
}
