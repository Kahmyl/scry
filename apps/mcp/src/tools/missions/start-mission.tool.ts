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
  missionPurposeSchema,
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

export function registerStartMissionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_mission",
    {
      title: "Start Mission",
      description:
        "Create a durable work item only after listing Missions. Purpose is immutable: primary is the user-facing acceptance path, diagnostic is isolated exploratory diagnosis, and recovery owns reconciliation work. Before risky exploration when a primary Mission exists, expose the choice: continue inside it and inherit its blockers, or—only with explicit user authority—start a distinct diagnostic/recovery Mission and then relate it. Never auto-create distinct work, move UNKNOWN truth, or invent authority. Normal unrelated creation needs no confirmation; distinctReason always requires distinctAuthority.",
      annotations: writes,
      inputSchema: {
        projectId: uuid,
        title: z.string().trim().min(1).max(200),
        originalInstruction: z.string().trim().min(1).max(20_000),
        instructionSnapshot: z.string().trim().min(1).max(20_000),
        provider: z.enum(["codex", "claude", "scry_agent", "human"]).default("codex"),
        connectionId: z.string().trim().min(1).max(500).optional(),
        purpose: missionPurposeSchema.default("primary"),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
        distinctReason: z.string().trim().min(1).max(2000).optional(),
        distinctAuthority: z
          .object({
            confirmedUserAuthorized: z.literal(true),
            selection: z.literal("start_distinct_mission"),
            source: z.enum(["current_request_explicit", "followup_explicit_choice"]),
          })
          .strict()
          .optional(),
      },
    },
    async ({ projectId, idempotencyKey, ...body }) =>
      result(
        await client.post(`/projects/${projectId}/missions`, {
          ...body,
          idempotencyKey: idempotencyKey ?? stableKey("mission", { projectId, ...body }),
        }),
        "Mission and agent session started. Pass both IDs to every later write.",
      ),
  );
}
