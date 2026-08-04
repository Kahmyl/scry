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

export function registerAcceptObjectiveEvidenceTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "accept_objective_evidence",
    {
      title: "Accept objective evidence",
      description:
        "Select one passed Run and optional safe artifacts as authoritative objective evidence.",
      inputSchema: {
        ...missionContext,
        objectiveId: uuid,
        runId: uuid,
        artifactIds: z.array(uuid).max(500).default([]),
        conclusion: z.string().trim().min(1).max(10_000),
      },
      annotations: writes,
    },
    async ({ objectiveId, ...body }) =>
      result(
        {
          evidence: await client.post(`/objectives/${objectiveId}/evidence`, body),
        },
        "Evidence accepted for objective.",
      ),
  );
}
