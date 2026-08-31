import { describe, expect, it, vi } from "vitest";

import { RunAttemptRepository } from "../src/runtime/repositories/run-attempt.repository.js";

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const claimToken = "33333333-3333-4333-8333-333333333333";
const praxisSessionId = "44444444-4444-4444-8444-444444444444";
const protectedOperationId = "55555555-5555-4555-8555-555555555555";

function harness(terminalProof: boolean) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("UPDATE attempts") && sql.includes("RETURNING id"))
      return { rowCount: 1, rows: [{ id: attemptId }] };
    if (sql.includes('AS "executionModel"'))
      return {
        rowCount: 1,
        rows: [{ structural: false, executionModel: "agent_directed_v1" }],
      };
    if (sql.includes("JOIN canonical_completed_executions protected"))
      return terminalProof ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{}] };
  });
  const client = { query };
  const database = {
    transaction: vi.fn((work: (value: typeof client) => unknown) => work(client)),
  };
  return { repository: new RunAttemptRepository(database as never), query };
}

describe("Run attempt terminal protected completion", () => {
  it("completes a proven terminal protected Run without manufacturing a successor checkpoint", async () => {
    const { repository, query } = harness(true);

    await expect(
      repository.completeAttempt(
        runId,
        attemptId,
        claimToken,
        "passed",
        "passed",
        {
          kind: "forbidden",
          reason: "terminal_protected_operation",
          praxisSessionId,
          protectedOperationId,
        },
        undefined,
      ),
    ).resolves.toBeUndefined();

    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          sql.includes("reason_code=$2") &&
          Array.isArray(values) &&
          values[1] === "TERMINAL_PROTECTED_OPERATION",
      ),
    ).toBe(true);
    const terminalProofQuery = query.mock.calls.find(([sql]) =>
      sql.includes("JOIN canonical_completed_executions protected"),
    )?.[0];
    expect(terminalProofQuery).toContain(
      "session.decision_boundary->>'type'='objective_completed'",
    );
    expect(terminalProofQuery).toContain(
      "session.decision_boundary->>'reasonCode'='PROTECTED_OPERATION_COMPLETED'",
    );
    expect(terminalProofQuery).not.toContain(
      "session.decision_boundary='PROTECTED_OPERATION_COMPLETED'",
    );
    expect(terminalProofQuery).toContain("session.state='completed'");
    expect(terminalProofQuery).toContain(
      "protected.prepared_execution_capability_id=link.prepared_execution_capability_id",
    );
    expect(terminalProofQuery).toContain("protected.praxis_session_id=link.praxis_session_id");
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes("run_successor_checkpoints checkpoint") && sql.includes("available"),
      ),
    ).toBe(false);
  });

  it("fails closed when the exact terminal protected receipt cannot be reproved", async () => {
    const { repository, query } = harness(false);

    await expect(
      repository.completeAttempt(
        runId,
        attemptId,
        claimToken,
        "passed",
        "passed",
        {
          kind: "forbidden",
          reason: "terminal_protected_operation",
          praxisSessionId,
          protectedOperationId,
        },
        undefined,
      ),
    ).rejects.toThrow("RUN_TERMINAL_PROTECTED_COMPLETION_UNPROVEN");

    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          sql.includes("reason_code=$2") &&
          Array.isArray(values) &&
          values[1] === "TERMINAL_PROTECTED_OPERATION",
      ),
    ).toBe(false);
  });
});
