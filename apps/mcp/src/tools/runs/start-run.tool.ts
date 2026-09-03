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
  idempotentDurableWrite,
  readOnly,
  stableKey,
  toolResult as result,
  uuid,
  writes,
} from "../../tool-registry.js";

export function registerStartRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_run",
    {
      title: "Start run",
      description:
        "Open a durable agent-directed Run ledger bound to an existing live Praxis session. flowRevisionId must be the exact publication.revisionId returned by publish_flow_draft; never use a Flow draft ID as flowRevisionId. This does not create or queue a browser.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        environmentId: uuid,
        flowRevisionId: uuid,
        praxisSessionId: uuid,
        qualificationCampaignAuthorizationId: uuid.optional(),
        protectedAuthorizations: z
          .array(z.object({ operationId: z.string().min(1), authorizationId: uuid }))
          .default([]),
        role: runRoleSchema.default("candidate"),
        viewport: z
          .object({
            width: z.number().int().min(320).max(3_840),
            height: z.number().int().min(320).max(2_160),
          })
          .default({ width: 1280, height: 720 }),
        seed: z.number().int().min(0).max(4_294_967_295).default(1),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
      annotations: idempotentDurableWrite,
    },
    async ({ projectId, idempotencyKey, ...body }) => {
      try {
        await client.requireCurrentRelease();
        const run = await client.post<Record<string, unknown>>(`/projects/${projectId}/runs`, {
          ...body,
          browser: "chromium",
          idempotencyKey: idempotencyKey ?? stableKey("run", { projectId, ...body }),
        });
        return result({ run }, "Agent-directed Run ledger opened.");
      } catch (error) {
        if (!(error instanceof ScryApiError)) throw error;
        return {
          ...result({ rejection: apiRejection(error) }, "Run creation was rejected."),
          isError: true,
        };
      }
    },
  );
}
