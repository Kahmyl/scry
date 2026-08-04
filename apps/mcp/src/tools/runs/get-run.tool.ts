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

export function registerGetRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_run",
    {
      title: "Get run observation",
      description:
        "Read the canonical run observation: current attempt, independent step channels, typed failure, safe artifact manifest, privacy timeline, integrity status, and permitted next actions.",
      inputSchema: { runId: uuid },
      annotations: readOnly,
    },
    async ({ runId }) =>
      result(
        { observation: await client.get(`/runs/${runId}`) },
        "Canonical run observation loaded.",
      ),
  );
}
