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

export function registerStartRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_run",
    {
      title: "Start run",
      description: "Create and queue a run from an immutable Flow revision.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        environmentId: uuid,
        flowRevisionId: uuid,
        compiledContractId: uuid,
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
      annotations: writes,
    },
    async ({ projectId, idempotencyKey, ...body }) => {
      await client.requireCurrentRelease();
      const run = await client.post<Record<string, unknown>>(`/projects/${projectId}/runs`, {
        ...body,
        browser: "chromium",
        idempotencyKey: idempotencyKey ?? stableKey("run", { projectId, ...body }),
      });
      return result({ run }, "Run queued.");
    },
  );
}
