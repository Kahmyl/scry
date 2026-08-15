import { describe, expect, it, vi } from "vitest";

import { AgentDirectedRunService } from "../src/runs/agent-directed-run.service.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const objectiveId = "33333333-3333-4333-8333-333333333333";
const flowDraftId = "44444444-4444-4444-8444-444444444444";

const intent = {
  intentId: "activate-submit",
  objectiveId,
  flowDraftId,
  action: {
    kind: "activate" as const,
    target: {
      concept: "Submit",
      reference: `context-control-${"a".repeat(32)}`,
      role: "button" as const,
      exact: true,
    },
  },
  expectedEffect: { kind: "target_state" as const, target: { concept: "Done", reference: `context-control-${"b".repeat(32)}`, role: "text" as const, exact: true }, enabled: true },
  constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
  authorization: { kind: "ordinary" as const },
  protectedInputReferences: [],
};

function harness(associated = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM run_operation_links") && sql.includes("operation_id"))
      return { rowCount: 0, rows: [] };
    if (sql.includes("FROM runs r JOIN run_praxis_sessions"))
      return associated
        ? { rowCount: 1, rows: [{ objectiveId, flowDraftId }] }
        : { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{}] };
  });
  const client = { query: vi.fn(async (sql: string) =>
    sql.includes("max(sequence)")
      ? { rowCount: 1, rows: [{ sequence: 1 }] }
      : { rowCount: 1, rows: [{}] }) };
  const database = { query, transaction: vi.fn((work: (value: typeof client) => unknown) => work(client)) };
  const scry = { requireWriteAccess: vi.fn(), getRun: vi.fn(async () => ({ id: runId })) };
  const sessions = { advance: vi.fn(async (_principal, _sessionId, command) => ({
    completed: [{
      intentId: command.intents[0].intentId,
      functionalResult: "succeeded",
      mutationOutcome: "applied",
      privacyApplicable: false,
      privacyResult: "verified",
      evidence: { state: "available", count: 0, reasonCodes: [] },
    }],
  })) };
  const admission = { assertAcceptingWork: vi.fn() };
  return {
    service: new AgentDirectedRunService(database as never,scry as never,sessions as never,admission as never),
    sessions,
  };
}

describe("agent-directed Run live Praxis ownership", () => {
  it("dispatches one exact-reference operation through the associated session and ignores expected effects as authority", async () => {
    const { service, sessions } = harness();
    await expect(service.dispatch({ kind: "service", subject: "scry-service" },runId,{ praxisSessionId: sessionId,intent })).resolves.toMatchObject({
      runId,praxisSessionId:sessionId,operationId:"activate-submit",functionalResult:"succeeded",mutationOutcome:"applied",
    });
    expect(sessions.advance).toHaveBeenCalledWith(expect.anything(),sessionId,expect.objectContaining({
      intents: [expect.objectContaining({ expectedEffect: { kind: "none" } })],
      budgets: { maxOperations: 1, maxDurationMs: 5_000 },
    }));
  });

  it("refuses a Run/session mismatch before invoking Praxis", async () => {
    const { service, sessions } = harness(false);
    await expect(service.dispatch({ kind: "service", subject: "scry-service" },runId,{ praxisSessionId: sessionId,intent }))
      .rejects.toMatchObject({ response: { code: "RUN_PRAXIS_SESSION_MISMATCH_OR_STALE" } });
    expect(sessions.advance).not.toHaveBeenCalled();
  });
});
