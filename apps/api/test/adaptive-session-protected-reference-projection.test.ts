import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";

describe("adaptive protected-output reference projection", () => {
  it("admits a completed protected output into the owning Mission session", async () => {
    const sessionId = randomUUID();
    const operationId = "protected-list-orders";
    const credentialId = randomUUID();
    const inputCredentialId = randomUUID();
    const protectedOperationId = randomUUID();
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes("SELECT operation.state")) {
          return {
            rowCount: 1,
            rows: [
              {
                state: "running",
                flowDraftId: randomUUID(),
                missionId: randomUUID(),
                objectiveId: randomUUID(),
                environmentId: randomUUID(),
                authorizationId: randomUUID(),
                intent: {
                  intentId: "list-orders",
                  action: { kind: "acquire_protected_outputs" },
                  protectedInputReferences: [inputCredentialId],
                },
                action: { type: "protectedTransaction" },
                outcome: null,
                decisionBoundary: null,
                dispatchBoundary: "dispatching",
              },
            ],
          };
        }
        if (text.includes("SELECT protected.id")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: protectedOperationId,
                state: "completed",
                leaseActive: false,
                dispatchState: "acknowledged",
                mutationOutcome: "applied",
                persistenceState: "committed",
                failureCode: null,
                persistedReferences: {
                  canonicalOrderId: {
                    classification: "protected",
                    credentialId,
                    scope: "project",
                  },
                },
              },
            ],
          };
        }
        if (text.includes("SELECT credential.id::text")) {
          return { rowCount: 1, rows: [{ id: credentialId }] };
        }
        if (text.includes("SELECT version,state,created_by_agent_session_id")) {
          return {
            rowCount: 1,
            rows: [
              {
                version: 1,
                state: "editing",
                createdByAgentSessionId: randomUUID(),
                stepExists: true,
              },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (value: typeof client) => unknown) => work(client)),
    };
    const repository = new AdaptiveSessionRepository(database as never);

    await repository.projectProtectedOperationForAuthoring({ sessionId, operationId });

    const admission = queries.find(({ text }) => text.includes("protected_reference_allowlist=("));
    expect(admission?.values.at(-1)).toEqual(JSON.stringify([credentialId]));
    expect(admission?.values.at(-1)).not.toContain(inputCredentialId);
    const provenance = queries.find(({ text }) => text.includes("SELECT credential.id::text"));
    expect(provenance?.values).toEqual([sessionId, [credentialId], protectedOperationId]);
  });
});
