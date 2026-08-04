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

export function registerValidateTestPlanTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "validate_test_plan",
    {
      title: "Validate plan",
      description: "Run authoritative API validation without mutating state.",
      inputSchema: {
        projectId: uuid,
        environmentId: uuid,
        plan: currentPlanSchema,
      },
      annotations: readOnly,
    },
    async (body) => {
      await client.requireCurrentRelease();
      const validation = await client.post<{
        valid: boolean;
        errors: unknown[];
        warnings: unknown[];
      }>("/plan-validations", body);
      return result(
        validation,
        validation.valid ? "Plan is valid." : `Plan has ${validation.errors.length} error(s).`,
      );
    },
  );
}
