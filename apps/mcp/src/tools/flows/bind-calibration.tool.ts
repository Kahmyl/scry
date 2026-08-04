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

export function registerBindCalibrationTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "bind_calibration",
    {
      title: "Bind calibration to Flow",
      description:
        "Atomically create a Flow revision binding one exact approved attestation. The API recomputes the operation digest and rejects changed behavior or structural mismatch.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        flowId: uuid,
        environmentId: uuid,
        expectedRevisionId: uuid,
        operationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
        attestationId: uuid,
        reason: z.string().trim().min(1).max(2_000),
      },
      annotations: writes,
    },
    async ({
      projectId,
      flowId,
      environmentId,
      expectedRevisionId,
      operationId,
      attestationId,
      missionId,
      objectiveId,
      agentSessionId,
      reason,
    }) => {
      const revision = await client.post(`/flows/${flowId}/calibration-bindings`, {
        environmentId,
        expectedRevisionId,
        operationId,
        attestationId,
        missionId,
        objectiveId,
        agentSessionId,
        reason,
        idempotencyKey: stableKey("bind-calibration", {
          projectId,
          flowId,
          expectedRevisionId,
          operationId,
          attestationId,
          missionId,
          objectiveId,
          agentSessionId,
        }),
      });
      return result(
        { revision },
        "Exact approved attestation bound atomically in a new immutable Flow revision.",
      );
    },
  );
}
