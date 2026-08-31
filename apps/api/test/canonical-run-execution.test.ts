import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectedRunService } from "../src/runs/services/agent-directed-run.service.js";

describe("canonical prepared Run execution", () => {
  it.each(["business_effect", "authentication", "read"])(
    "binds durable evidence and consumes only the canonical %s authority",
    async (effect) => {
      const runId = randomUUID(),
        sessionId = randomUUID(),
        capabilityId = randomUUID(),
        mutationIdentity = randomUUID();
      const input = {
        praxisSessionId: sessionId,
        preparedExecutionCapabilityId: capabilityId,
        protectedOperationId: randomUUID(),
        publicOperationId: "opaque-operation",
      };
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("FROM runs r"))
          return {
            rowCount: 1,
            rows: [
              {
                projectId: randomUUID(),
                missionId: randomUUID(),
                objectiveId: randomUUID(),
                agentSessionId: randomUUID(),
                attemptId: randomUUID(),
                claimToken: randomUUID(),
                veilPolicySnapshot: {},
              },
            ],
          };
        if (sql.includes('AS "mutationIdentity"'))
          return { rowCount: 1, rows: [{ mutationIdentity, effectSemantics: [effect] }] };
        return { rowCount: 1, rows: [{}] };
      });
      const database = { query, transaction: async (fn: any) => fn({ query }) };
      const campaign = {
        consumeBusinessMutation: vi.fn(async () => ({ replayed: false })),
        settleMutation: vi.fn(),
      };
      const sessions = {
        dispatchPreparedOperation: vi.fn(
          async (_principal: any, id: string, exact: any, evidence: any) => {
            expect(id).toBe(sessionId);
            expect(exact).toEqual({
              protectedOperationId: input.protectedOperationId,
              preparedExecutionCapabilityId: capabilityId,
              publicOperationId: input.publicOperationId,
            });
            const operation = {
              operationId: input.publicOperationId,
              idempotencyKey: "must-not-become-mutation-identity",
              action: { type: "protectedTransaction" },
            };
            await evidence.preparedOperationAdmitted(operation, capabilityId);
            await evidence.beforeBusinessMutationDispatch(operation);
            return { protectedOperationId: input.protectedOperationId, state: "completed" };
          },
        ),
      };
      const service = new AgentDirectedRunService(
        database as never,
        { getRun: vi.fn(), requireWriteAccess: vi.fn() } as never,
        sessions as never,
        {} as never,
        { getMutationReceiptByAuthoringOperation: vi.fn(async () => null) } as never,
        { assertAcceptingWork: vi.fn() } as never,
        campaign as never,
      );
      await service.dispatchPrepared({ kind: "service", subject: "scry-service" }, runId, input);
      expect(
        query.mock.calls.some(
          ([sql]) =>
            sql.includes("prepared_execution_capability_id") &&
            sql.includes("INSERT INTO run_operation_links"),
        ),
      ).toBe(true);
      if (effect === "business_effect")
        expect(campaign.consumeBusinessMutation).toHaveBeenCalledWith({
          runId,
          operationId: input.publicOperationId,
          mutationIdentity,
        });
      else expect(campaign.consumeBusinessMutation).not.toHaveBeenCalled();
    },
  );
});
