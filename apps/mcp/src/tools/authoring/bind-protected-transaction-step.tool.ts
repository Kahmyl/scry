import { currentPlanSchema, protectedTransactionSchema } from "@scry/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { objectiveContext, toolResult as result, uuid, writes } from "../../tool-registry.js";

export function registerBindProtectedTransactionStepTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "bind_protected_transaction_step",
    {
      title: "Bind protected transaction objective",
      description:
        "Replace one draft step with a validated protected transaction objective for an approved one-time mutation and protected acquisition. Supply semantic targets, opaque input references, reconciliation, and objective-based acquisition only; executable acquisition code and plaintext protected values are not accepted.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        expectedVersion: z.number().int().positive(),
        stepId: z.string().trim().min(1).max(100),
        transaction: protectedTransactionSchema,
        reason: z.string().trim().min(1).max(2_000),
      },
      annotations: writes,
    },
    async ({ draftId, expectedVersion, stepId, transaction, ...context }) => {
      const draft = await client.get<{ version: number; plan: unknown }>(`/flow-drafts/${draftId}`);
      const plan = currentPlanSchema.parse(draft.plan);
      if (!plan.steps.some((step) => step.id === stepId)) {
        throw new Error("FLOW_DRAFT_STEP_NOT_FOUND");
      }

      const steps = plan.steps.map((step) =>
        step.id === stepId ? { ...step, action: transaction } : step,
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
        { draft: updated, boundStepId: stepId, operationId: transaction.operationId },
        "Protected transaction objective bound to the draft step.",
      );
    },
  );
}
