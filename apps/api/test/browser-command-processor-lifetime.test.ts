import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PraxisCommandOptions, PraxisExecutionPort } from "@scry/contracts";
import { processBrowserCommand } from "../src/browser-execution/browser-command-processor.js";
import type { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
beforeEach(() => {
  vi.useFakeTimers();
  const origin = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(executionRemainingMs = 120000) {
  const sample = {
    executionRemainingMs,
    claimRemainingMs: 60000,
    sampleStartedAt: performance.now(),
  };
  const commands = {
    claim: vi.fn(async () => ({
      id: "command",
      session_id: "session",
      claim_token: "claim",
      safe_input: { kind: "observe" },
      ...sample,
    })),
    assertClaim: vi.fn(async () => sample),
    heartbeatClaim: vi.fn(async () => sample),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    noteRecoveryRequired: vi.fn(async (): Promise<void> => undefined),
  };
  let entered!: () => void, finish!: () => void, options: PraxisCommandOptions | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const praxis = {
    executeCommand: vi.fn(
      async (_session: string, _command: unknown, control?: PraxisCommandOptions) => {
        options = control;
        entered();
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          finish = () => resolve({ observed: true });
          control?.signal?.addEventListener(
            "abort",
            () => reject(new Error("fixture_runtime_interrupted")),
            { once: true },
          );
        });
      },
    ),
  };
  const onUnconfirmedDrain = vi.fn();
  const run = () =>
    processBrowserCommand(
      commands as unknown as BrowserCommandRepository,
      praxis as unknown as PraxisExecutionPort,
      { data: { commandId: "command" }, moveToDelayed: vi.fn() },
      "queue-lock",
      { onUnconfirmedDrain },
    );
  return {
    commands,
    praxis,
    run,
    started,
    finish: () => finish?.(),
    options: () => options,
    onUnconfirmedDrain,
    sample,
  };
}
describe("carried command processor lifetime", () => {
  it("requests host containment before waiting for best-effort recovery diagnostics", async () => {
    const f = fixture();
    let finish!: () => void;
    f.praxis.executeCommand.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED"),
    );
    f.commands.noteRecoveryRequired.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const running = f.run(),
      observed = running.catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onUnconfirmedDrain).toHaveBeenCalledTimes(1);
      expect(f.commands.fail).not.toHaveBeenCalled();
    } finally {
      finish?.();
      await observed;
    }
  });
  it("cancels native execution when the immutable command budget expires", async () => {
    const f = fixture(100),
      running = f.run();
    const observed = running.catch((error: unknown) => error);
    try {
      await f.started;
      await vi.advanceTimersByTimeAsync(100);
      expect(f.options()?.signal?.aborted).toBe(true);
      expect(await observed).toEqual({ failed: true });
      expect(f.commands.fail).toHaveBeenCalledWith(
        "command",
        "claim",
        expect.objectContaining({ message: "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED" }),
      );
    } finally {
      f.finish();
      await observed;
    }
  });
  it("does not swallow a rejected heartbeat while native execution is waiting", async () => {
    const f = fixture();
    f.commands.heartbeatClaim.mockRejectedValueOnce(new Error("SCRY_BROWSER_COMMAND_CLAIM_FENCED"));
    const running = f.run(),
      observed = running.catch((error: unknown) => error);
    try {
      await f.started;
      await vi.advanceTimersByTimeAsync(20000);
      expect(f.options()?.signal?.aborted).toBe(true);
      expect(await observed).toEqual({ failed: true });
      expect(f.commands.complete).not.toHaveBeenCalled();
    } finally {
      f.finish();
      await observed;
    }
  });
  it("locally expires a claim even if its heartbeat query never returns and does not overlap renewals", async () => {
    const f = fixture();
    let release!: (value: typeof f.sample) => void;
    f.commands.heartbeatClaim.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = f.run(),
      observed = running.catch((error: unknown) => error);
    try {
      await f.started;
      await vi.advanceTimersByTimeAsync(20000);
      await vi.advanceTimersByTimeAsync(40000);
      expect(f.options()?.signal?.aborted).toBe(true);
      expect(f.commands.heartbeatClaim).toHaveBeenCalledTimes(1);
      expect(await observed).toEqual({ failed: true });
    } finally {
      release?.(f.sample);
      f.finish();
      await observed;
    }
  });
  it("does not dispatch an already-expired carried command", async () => {
    const f = fixture(0),
      running = f.run(),
      observed = running.catch((error: unknown) => error);
    try {
      // No native startup is needed to report an expired, still-owned command.
      await vi.advanceTimersByTimeAsync(0);
      expect(f.praxis.executeCommand).not.toHaveBeenCalled();
      expect(await observed).toEqual({ failed: true });
    } finally {
      f.finish();
      await observed;
    }
  });
  it("keeps unconfirmed runtime work nonterminal and requests host recovery", async () => {
    const f = fixture();
    f.praxis.executeCommand.mockRejectedValueOnce(
      new Error("SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED"),
    );
    await expect(f.run()).rejects.toThrow("COMMAND_DRAIN_UNCONFIRMED");
    expect(f.commands.fail).not.toHaveBeenCalled();
    expect(f.commands.complete).not.toHaveBeenCalled();
    expect(f.commands.noteRecoveryRequired).toHaveBeenCalledWith("command", "claim");
    expect(f.onUnconfirmedDrain).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
