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

export function registerStartProbeSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_probe_session",
    {
      title: "Start Probe Session",
      description:
        "Inspect every target and readiness contract together. This is authoring activity, not a Run.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        environmentId: uuid,
        draftVersion: z.number().int().positive(),
        mode: z.enum(["queued", "interactive"]).default("queued"),
        level: z.enum(["inspection", "reversible", "calibration_transaction"]),
        disposableDataConfirmed: z.boolean().default(false),
        authorizationId: uuid.optional(),
        authenticationContractRevisionId: uuid.optional(),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ draftId, idempotencyKey, ...body }) =>
      result(
        {
          probe: await client.post(`/flow-drafts/${draftId}/probes`, {
            ...body,
            idempotencyKey: idempotencyKey ?? stableKey("probe", { draftId, ...body }),
          }),
        },
        body.mode === "interactive"
          ? "Interactive Probe Session starting."
          : "Probe Session queued.",
      ),
  );
}
