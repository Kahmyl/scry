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

export function registerTightenVeilPreferencesTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "tighten_veil_preferences",
    {
      title: "Tighten Veil preferences",
      description:
        "Apply a strictly more private environment policy. This tool cannot enable a disabled channel, add an origin, extend a lease, or weaken Veil's safety floor.",
      inputSchema: { environmentId: uuid, ...veilPreferenceUpdateSchema.shape },
      annotations: writes,
    },
    async ({ environmentId, ...preferences }) =>
      result(
        {
          veil: await client.patch(`/environments/${environmentId}/veil`, preferences),
        },
        "Veil preferences tightened; the hard safety floor remains active.",
      ),
  );
}
