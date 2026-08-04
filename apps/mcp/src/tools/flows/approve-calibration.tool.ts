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

export function registerApproveCalibrationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "approve_calibration",
    {
      title: "Approve exact calibration attestation",
      description:
        "Approve one immutable privacy attestation only when the user explicitly authorized it and the MCP identity is an owner or admin. Approval cannot edit the operation, bypass attestation, or approve another result.",
      inputSchema: {
        ...objectiveContext,
        calibrationId: uuid,
        attestationId: uuid,
        confirmedUserAuthorized: z.literal(true),
        reasonCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .default("USER_AUTHORIZED_AGENT_CALIBRATION"),
      },
      annotations: writes,
    },
    async ({ calibrationId, attestationId, reasonCode, missionId, objectiveId, agentSessionId }) =>
      result(
        {
          calibration: await client.post(
            `/calibrations/${calibrationId}/attestations/${attestationId}/approve`,
            {
              missionId,
              objectiveId,
              agentSessionId,
              reasonCode,
              confirmedUserAuthorized: true,
            },
          ),
        },
        "Exact immutable calibration attestation approved.",
      ),
  );
}
