import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandExecutionLease } from "../src/browser-execution/command-execution-lease.js";
import type { CommandClaimSample } from "../src/browser-execution/repositories/browser-command.repository.js";
beforeEach(() => {
  vi.useFakeTimers();
  const origin = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const sample = (
  executionRemainingMs = 120000,
  claimRemainingMs = 60000,
  age = 0,
): CommandClaimSample => ({
  executionRemainingMs,
  claimRemainingMs,
  sampleStartedAt: performance.now() - age,
});
function fixture(initial = sample()) {
  let serverClaimExpiry = performance.now() + initial.claimRemainingMs;
  const executionExpiry = performance.now() + initial.executionRemainingMs;
  const commands = {
    assertClaim: vi.fn(async () =>
      sample(
        Math.max(0, executionExpiry - performance.now()),
        Math.max(0, serverClaimExpiry - performance.now()),
      ),
    ),
    heartbeatClaim: vi.fn(async () => {
      serverClaimExpiry = performance.now() + 60000;
      return sample(Math.max(0, executionExpiry - performance.now()), 60000);
    }),
  };
  const lease = new CommandExecutionLease(commands, "command", "claim", initial);
  return { lease, commands };
}
describe("carried command execution and claim clocks", () => {
  it("deducts query/commit/transport elapsed time from a process-local monotonic anchor", async () => {
    const { lease } = fixture(sample(1000, 60000, 200));
    try {
      expect(lease.remainingMs()).toBe(800);
      await vi.advanceTimersByTimeAsync(800);
      expect(lease.failure?.message).toBe("SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED");
    } finally {
      lease.dispose();
    }
  });
  it("never resets the execution deadline when a checkpoint reports more time", async () => {
    const { lease, commands } = fixture(sample(1000));
    try {
      await vi.advanceTimersByTimeAsync(600);
      commands.assertClaim.mockResolvedValueOnce(sample(1000));
      await lease.checkpoint();
      expect(lease.remainingMs()).toBe(400);
      await vi.advanceTimersByTimeAsync(400);
      expect(lease.signal.aborted).toBe(true);
    } finally {
      lease.dispose();
    }
  });
  it("renews claim authority without renewing the absolute command deadline", async () => {
    const { lease, commands } = fixture();
    try {
      await vi.advanceTimersByTimeAsync(120000);
      expect(commands.heartbeatClaim).toHaveBeenCalled();
      expect(lease.failure?.message).toBe("SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED");
    } finally {
      lease.dispose();
    }
  });
  it("does not let frequent successful checkpoints postpone periodic renewal", async () => {
    const { lease, commands } = fixture();
    try {
      for (let n = 0; n < 5; n += 1) {
        await vi.advanceTimersByTimeAsync(4000);
        await lease.checkpoint();
      }
      expect(commands.heartbeatClaim).toHaveBeenCalledTimes(1);
    } finally {
      lease.dispose();
    }
  });
  it("brings renewal forward when a checkpoint shortens the remaining claim", async () => {
    const { lease, commands } = fixture();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      commands.assertClaim.mockResolvedValueOnce(sample(119000, 3000));
      await lease.checkpoint();
      await vi.advanceTimersByTimeAsync(1000);
      expect(commands.heartbeatClaim).toHaveBeenCalledTimes(1);
    } finally {
      lease.dispose();
    }
  });
  it("expires a hung renewal locally, never overlaps it, and rejects its late resurrection", async () => {
    const { lease, commands } = fixture();
    let finish!: (value: CommandClaimSample) => void;
    commands.heartbeatClaim.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await vi.advanceTimersByTimeAsync(20000);
      await vi.advanceTimersByTimeAsync(40000);
      expect(commands.heartbeatClaim).toHaveBeenCalledTimes(1);
      expect(lease.failure?.message).toBe("SCRY_BROWSER_COMMAND_CLAIM_FENCED");
      finish(sample());
      await vi.advanceTimersByTimeAsync(0);
      expect(lease.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish?.(sample());
      lease.dispose();
    }
  });
  it("does not extend a claim through a read-only checkpoint", async () => {
    const { lease, commands } = fixture(sample(120000, 1000));
    let finish!: (value: CommandClaimSample) => void;
    commands.heartbeatClaim.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      await vi.advanceTimersByTimeAsync(600);
      commands.assertClaim.mockResolvedValueOnce(sample(120000, 1000));
      await lease.checkpoint();
      await vi.advanceTimersByTimeAsync(400);
      expect(lease.failure?.message).toBe("SCRY_BROWSER_COMMAND_CLAIM_FENCED");
    } finally {
      finish?.(sample());
      lease.dispose();
    }
  });
  it("does not abort completed work when an in-flight heartbeat fails after disposal", async () => {
    const { lease, commands } = fixture();
    let reject!: (reason: Error) => void;
    commands.heartbeatClaim.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(20000);
    lease.dispose();
    reject(new Error("private-fixture-database-message"));
    await vi.advanceTimersByTimeAsync(0);
    expect(lease.signal.aborted).toBe(false);
    expect(lease.failure).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => lease.assertActive()).toThrow("COMMAND_ATTEMPT_ENDED");
  });
  it("turns arbitrary heartbeat diagnostics into a finite value-free authority failure", async () => {
    const { lease, commands } = fixture();
    commands.heartbeatClaim.mockRejectedValueOnce(new Error("private-fixture-token-card-detail"));
    try {
      await vi.advanceTimersByTimeAsync(20000);
      expect(lease.failure?.message).toBe("SCRY_BROWSER_COMMAND_CLAIM_UNAVAILABLE");
      expect(lease.signal.reason.message).not.toContain("private-fixture");
    } finally {
      lease.dispose();
    }
  });
  it("watches deadline expiry while a pre-dispatch query is still pending", async () => {
    const { lease, commands } = fixture(sample(100));
    let finish!: (value: CommandClaimSample) => void;
    commands.assertClaim.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const checking = lease.checkpoint(),
      rejected = expect(checking).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(lease.signal.aborted).toBe(true);
      finish(sample());
      await rejected;
    } finally {
      finish?.(sample());
      await checking.catch(() => undefined);
      lease.dispose();
    }
  });
  it("ignores worker wall-clock jumps", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const { lease } = fixture();
    try {
      const before = lease.remainingMs();
      vi.setSystemTime(Date.now() + 86400000);
      expect(lease.remainingMs()).toBe(before);
      vi.setSystemTime(Date.now() - 172800000);
      expect(lease.remainingMs()).toBe(before);
    } finally {
      lease.dispose();
    }
  });
  it.each([
    { executionRemainingMs: -1 },
    { executionRemainingMs: Infinity },
    { executionRemainingMs: 900001 },
    { claimRemainingMs: 300001 },
    { claimRemainingMs: 1.5 },
    { sampleStartedAt: NaN },
    { sampleStartedAt: 1 },
  ])("refuses malformed authority samples before scheduling work: %j", (override) => {
    const { lease } = fixture({ ...sample(), ...override });
    try {
      expect(lease.signal.aborted).toBe(true);
      expect(lease.failure?.message).toBe("SCRY_BROWSER_COMMAND_CLAIM_UNAVAILABLE");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lease.dispose();
    }
  });
});
