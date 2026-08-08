import { currentPlanSchema, interactionTargetIntentSchema } from "@scry/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { objectiveContext, toolResult as result, uuid, writes } from "../../tool-registry.js";

export function registerBindCredentialFillStepTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "bind_credential_fill_step",
    {
      title: "Bind encrypted credential to fill step",
      description:
        "Replace one draft step with a vault-backed fill action. Supply only an authorized credential ID and semantic target intent; plaintext credential values are never accepted.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        expectedVersion: z.number().int().positive(),
        stepId: z.string().trim().min(1).max(100),
        credentialId: uuid,
        target: interactionTargetIntentSchema,
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
        reason: z.string().trim().min(1).max(2_000),
      },
      annotations: writes,
    },
    async ({ draftId, expectedVersion, stepId, credentialId, target, timeoutMs, ...context }) => {
      const draft = await client.get<{ version: number; plan: unknown }>(`/flow-drafts/${draftId}`);
      const plan = currentPlanSchema.parse(draft.plan);
      const stepIndex = plan.steps.findIndex((step) => step.id === stepId);
      if (stepIndex < 0) throw new Error("FLOW_DRAFT_STEP_NOT_FOUND");

      const steps = plan.steps.map((step, index) =>
        index === stepIndex
          ? {
              ...step,
              action: {
                type: "fill" as const,
                target,
                secretRef: credentialId,
                timeoutMs,
              },
            }
          : step,
      );
      const updatedPlan = currentPlanSchema.parse({ ...plan, steps });
      const updated = await client.patch(`/flow-drafts/${draftId}`, {
        missionId: context.missionId,
        objectiveId: context.objectiveId,
        agentSessionId: context.agentSessionId,
        expectedVersion,
        plan: updatedPlan,
        reason: context.reason,
      });

      return result(
        { draft: updated, boundStepId: stepId, credentialId },
        "Encrypted credential bound to the semantic fill step.",
      );
    },
  );
}
