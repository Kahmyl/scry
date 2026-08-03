import { describe, expect, it, vi } from "vitest";

import { CalibrationRuntimeRepository, type CalibrationRuntime } from "../src/calibration/index.js";

const runtime = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  claimToken: "33333333-3333-4333-8333-333333333333",
} as CalibrationRuntime;

function harness(responses: Array<{ rowCount: number; rows: unknown[] }>) {
  const client = {
    query: vi.fn(
      async (_text: string, _values?: unknown[]) => responses.shift() ?? { rowCount: 1, rows: [] },
    ),
  };
  const database = {
    query: vi.fn(),
    transaction: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
  };
  return { repository: new CalibrationRuntimeRepository(database as never), database, client };
}

describe("calibration runtime lifecycle", () => {
  it("atomically enters running with an explicitly typed JSON phase", async () => {
    const { repository, database, client } = harness([
      { rowCount: 1, rows: [{ id: runtime.attemptId }] },
      { rowCount: 1, rows: [{ id: runtime.sessionId }] },
      { rowCount: 1, rows: [] },
    ]);

    await expect(repository.markRunning(runtime, "executing_preflight")).resolves.toBe(true);
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(database.query).not.toHaveBeenCalled();
    expect(String(client.query.mock.calls[0]![0])).toContain(
      "jsonb_build_object('phase',$3::text)",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain("current_attempt_id=$3");
  });

  it("terminalizes a claimed setup failure without permitting a retry after mutation", async () => {
    const { repository, client } = harness([
      { rowCount: 1, rows: [{ mutationCount: 0 }] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
    ]);

    await expect(
      repository.failClaim(runtime, "CALIBRATION_WORKER_EXECUTION_FAILED", "42P18"),
    ).resolves.toBe(true);
    expect(client.query.mock.calls[1]![1]).toContain("failed");
    expect(client.query.mock.calls[1]![1]).toContain("CALIBRATION_WORKER_EXECUTION_FAILED");
  });

  it("uses the same typed, transactional transition for later phases", async () => {
    const { repository, client } = harness([
      { rowCount: 1, rows: [{ id: runtime.attemptId }] },
      { rowCount: 1, rows: [{ id: runtime.sessionId }] },
      { rowCount: 1, rows: [] },
    ]);
    await expect(repository.markPhase(runtime, "boundary_reached")).resolves.toBe(true);
    expect(String(client.query.mock.calls[0]![0])).toContain(
      "jsonb_build_object('phase',$3::text)",
    );
  });

  it("recovers stale claims with retained attempt diagnostics and an append-only event", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [{ sessionId: runtime.sessionId, attemptId: runtime.attemptId, mutationCount: 0 }],
      },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
    ]);

    await repository.recoverStale(new Date(0));
    expect(String(client.query.mock.calls[0]![0])).toContain("CALIBRATION_WORKER_LOST");
    expect(String(client.query.mock.calls[1]![0])).not.toContain("current_attempt_id=NULL");
    expect(String(client.query.mock.calls[2]![0])).toContain("calibration_events");
  });
});
