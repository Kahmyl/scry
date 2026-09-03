import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";

const sessionId = randomUUID();
const operation = {
  operationId: "prepared-supervisor-operation",
  idempotencyKey: "prepared:supervisor",
  mode: "transact",
  action: { type: "waitFor", timeoutMs: 1_000 },
  expectedEffect: { type: "none" },
  protectedInputReferences: [],
} as const;

describe("prepared execution supervisor", () => {
  afterEach(() => vi.useRealTimers());

  it("retains request ownership until canonical protected settlement", async () => {
    let finish!: () => void;
    const execution = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const repository = {
      recordPreparedExecutionStage: vi.fn().mockResolvedValue(undefined),
      projectProtectedOperationForAuthoring: vi.fn().mockResolvedValue({
        status: "settled",
        state: "completed",
      }),
    };
    const runner = { execute: vi.fn(() => execution), cancelActiveOperation: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    let returned = false;
    const supervised = (
      service as unknown as {
        supervisePreparedExecution(
          session: string,
          input: typeof operation,
          timeoutMs: number,
        ): Promise<{ status: string; state: string }>;
      }
    )
      .supervisePreparedExecution(sessionId, operation, 10_000)
      .then((value) => {
        returned = true;
        return value;
      });

    await vi.waitFor(() => expect(runner.execute).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    finish();

    await expect(supervised).resolves.toEqual({ status: "settled", state: "completed" });
    expect(
      repository.recordPreparedExecutionStage.mock.calls.map(([value]) => value.stage),
    ).toEqual([
      "supervisor_launched",
      "protected_admission_requested",
      "protected_admission_acknowledged",
      "terminal_observed",
    ]);
  });

  it("cancels and establishes not-applied truth when the deadline expires before dispatch", async () => {
    vi.useFakeTimers();
    const repository = {
      recordPreparedExecutionStage: vi.fn().mockResolvedValue(undefined),
      settlePreparedExecutionDeadline: vi.fn().mockResolvedValue({
        state: "failed_not_applied",
        mutationOutcome: "not_applied",
      }),
      projectProtectedOperationForAuthoring: vi.fn().mockResolvedValue({
        status: "settled",
        state: "failed_not_applied",
      }),
    };
    const runner = {
      execute: vi.fn(
        (_session: string, _operation: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      ),
      cancelActiveOperation: vi.fn().mockResolvedValue(undefined),
    };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const supervised = (
      service as unknown as {
        supervisePreparedExecution(
          session: string,
          input: typeof operation,
          timeoutMs: number,
        ): Promise<{ status: string; state: string }>;
      }
    ).supervisePreparedExecution(sessionId, operation, 1_000);

    await vi.advanceTimersByTimeAsync(1_001);

    await expect(supervised).resolves.toEqual({
      status: "settled",
      state: "failed_not_applied",
    });
    expect(runner.cancelActiveOperation).toHaveBeenCalledWith(sessionId);
    expect(repository.settlePreparedExecutionDeadline).toHaveBeenCalledWith({
      sessionId,
      operationId: operation.operationId,
      reasonCode: "PREPARED_EXECUTION_DEADLINE_EXCEEDED",
    });
  });

  it("coalesces concurrent resume requests onto one supervised execution", async () => {
    let finish!: () => void;
    const execution = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const repository = {
      recordPreparedExecutionStage: vi.fn().mockResolvedValue(undefined),
      projectProtectedOperationForAuthoring: vi.fn().mockResolvedValue({
        status: "settled",
        state: "completed",
      }),
    };
    const runner = { execute: vi.fn(() => execution), cancelActiveOperation: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const supervisor = service as unknown as {
      supervisePreparedExecution(
        session: string,
        input: typeof operation,
        timeoutMs: number,
      ): Promise<{ status: string; state: string }>;
    };
    const first = supervisor.supervisePreparedExecution(sessionId, operation, 10_000);
    const second = supervisor.supervisePreparedExecution(sessionId, operation, 10_000);

    await vi.waitFor(() => expect(runner.execute).toHaveBeenCalledOnce());
    finish();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "settled", state: "completed" },
      { status: "settled", state: "completed" },
    ]);
    expect(runner.execute).toHaveBeenCalledOnce();
  });
});
