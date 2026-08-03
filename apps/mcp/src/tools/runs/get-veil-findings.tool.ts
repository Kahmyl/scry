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

export function registerGetVeilFindingsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_veil_findings",
    {
      title: "Get Veil privacy findings",
      description:
        "Read the effective Veil profile, privacy timeline, capture gaps, safe reason codes, and remediation without exposing protected values.",
      inputSchema: { runId: uuid },
      annotations: readOnly,
    },
    async ({ runId }) =>
      result({ veil: await client.get(`/runs/${runId}/veil`) }, "Veil privacy findings loaded."),
  );
}
