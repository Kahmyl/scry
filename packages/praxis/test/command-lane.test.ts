import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandAttempt, CommandLane } from "../src/command-lane.js";
const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("attempt-bound monotonic command lane", () => {
  it("does not allow the same attempt object to run twice", async () => {
    const scope = new CommandAttempt({ remainingMs: 1000 });
    expect(await scope.run(async () => "first")).toBe("first");
    await expect(scope.run(async () => "second")).rejects.toThrow("COMMAND_ATTEMPT_ENDED");
  });
  it("keeps the session-owned binding with its owner after ordinary settled failure", async () => {
    const existing = vi.fn(async () => undefined);
    await expect(
      new CommandLane().run({ remainingMs: 1000 }, async (scope) => {
        scope.bind({ stop: existing });
        throw new Error("fixture_failure");
      }),
    ).rejects.toThrow("fixture_failure");
    expect(existing).not.toHaveBeenCalled();
  });
  it("does not expose a competing resource-factory authority or accept bindings after completion", async () => {
    let previous!: CommandAttempt;
    await new CommandLane().run({ remainingMs: 1000 }, async (scope) => {
      previous = scope;
      expect("acquire" in scope).toBe(false);
    });
    const stop = vi.fn(async () => undefined);
    expect(() => previous.bind({ stop })).toThrow("COMMAND_ATTEMPT_ENDED");
    expect(stop).not.toHaveBeenCalled();
  });
  it("does not overlap commands and admits the next only after the first settles", async () => {
    const lane = new CommandLane(),
      held = gate();
    const first = lane.run({ remainingMs: 1000 }, () => held.promise);
    await expect(lane.run({ remainingMs: 1000 }, async () => undefined)).rejects.toThrow(
      "COMMAND_CONCURRENT",
    );
    held.resolve();
    await first;
    expect(await lane.run({ remainingMs: 1000 }, async () => "next")).toBe("next");
  });
  it("releases a normally failed operation without disguising its error", async () => {
    const lane = new CommandLane();
    await expect(
      lane.run({ remainingMs: 1000 }, async () => {
        throw new Error("fixture_failure");
      }),
    ).rejects.toThrow("fixture_failure");
    expect(await lane.run({ remainingMs: 1000 }, async () => 2)).toBe(2);
  });
  it("does not dispatch for an expired budget or already-aborted signal", async () => {
    const work = vi.fn(),
      cancelled = new AbortController();
    cancelled.abort("private-fixture-reason");
    await expect(new CommandLane().run({ remainingMs: 0 }, work)).rejects.toThrow(
      "COMMAND_DEADLINE_EXCEEDED",
    );
    await expect(
      new CommandLane().run({ remainingMs: 1000, signal: cancelled.signal }, work),
    ).rejects.toThrow("COMMAND_CANCELLED");
    expect(work).not.toHaveBeenCalled();
  });
  it("stops exact resources once and waits for physical exit and action settlement", async () => {
    const lane = new CommandLane(),
      signal = new AbortController(),
      exit = gate(),
      work = gate();
    const stop = vi.fn(async () => {
      await exit.promise;
      work.resolve();
    });
    const running = lane.run({ remainingMs: 1000, signal: signal.signal }, async (scope) => {
      scope.bind({ stop });
      await work.promise;
    });
    await Promise.resolve();
    signal.abort();
    let finished = false;
    const observed = running.catch((error) => {
      finished = true;
      throw error;
    });
    const rejection = expect(observed).rejects.toThrow("COMMAND_CANCELLED");
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(lane.run({ remainingMs: 1000 }, async () => undefined)).rejects.toThrow(
      "COMMAND_CONCURRENT",
    );
    exit.resolve();
    await rejection;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await lane.run({ remainingMs: 1000 }, async () => "drained")).toBe("drained");
  });
  it("terminates a late acquisition before it can dispatch an action", async () => {
    const lane = new CommandLane(),
      signal = new AbortController(),
      acquisition = gate<{ stop(): Promise<void> }>();
    const stop = vi.fn(async () => undefined),
      dispatch = vi.fn();
    const running = lane.run({ remainingMs: 1000, signal: signal.signal }, async (scope) => {
      scope.bind({
        stop: async () => {
          await (await acquisition.promise).stop();
        },
      });
      await acquisition.promise;
      scope.assertActive();
      dispatch();
    });
    const rejection = expect(running).rejects.toThrow("COMMAND_CANCELLED");
    await Promise.resolve();
    await Promise.resolve();
    signal.abort();
    acquisition.resolve({ stop });
    await rejection;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not kill a later attempt when the old external signal aborts after success", async () => {
    const lane = new CommandLane(),
      oldSignal = new AbortController(),
      oldStop = vi.fn(async () => undefined),
      newStop = vi.fn(async () => undefined),
      held = gate();
    let previous!: CommandAttempt;
    await lane.run({ remainingMs: 1000, signal: oldSignal.signal }, async (scope) => {
      previous = scope;
      scope.bind({ stop: oldStop });
    });
    const running = lane.run({ remainingMs: 1000 }, async (scope) => {
      scope.bind({ stop: newStop });
      await held.promise;
    });
    await Promise.resolve();
    oldSignal.abort();
    expect(() => previous.assertActive()).toThrow("COMMAND_ATTEMPT_ENDED");
    expect(oldStop).not.toHaveBeenCalled();
    expect(newStop).not.toHaveBeenCalled();
    held.resolve();
    await running;
  });
  it("poisons the lane if physical stop cannot be confirmed", async () => {
    const lane = new CommandLane(),
      signal = new AbortController(),
      action = gate();
    const running = lane.run({ remainingMs: 1000, signal: signal.signal }, async (scope) => {
      scope.bind({
        stop: async () => {
          action.resolve();
          throw new Error("private-driver-message");
        },
      });
      await action.promise;
    });
    const rejection = expect(running).rejects.toThrow("COMMAND_DRAIN_UNCONFIRMED");
    await Promise.resolve();
    signal.abort();
    await rejection;
    await expect(lane.run({ remainingMs: 1000 }, async () => undefined)).rejects.toThrow(
      "COMMAND_DRAIN_UNCONFIRMED",
    );
  });
  it("does not release an action that ignores cancellation when drain time expires", async () => {
    vi.useFakeTimers();
    const lane = new CommandLane(),
      signal = new AbortController(),
      held = gate();
    const running = lane.run(
      { remainingMs: 1000, drainTimeoutMs: 25, signal: signal.signal },
      async () => held.promise,
    );
    const rejection = expect(running).rejects.toThrow("COMMAND_DRAIN_UNCONFIRMED");
    await Promise.resolve();
    signal.abort();
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    held.resolve();
    await Promise.resolve();
    await expect(lane.run({ remainingMs: 1000 }, async () => undefined)).rejects.toThrow(
      "COMMAND_DRAIN_UNCONFIRMED",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("continues owning a late resource even after reporting an unconfirmed drain", async () => {
    vi.useFakeTimers();
    const lane = new CommandLane(),
      signal = new AbortController(),
      acquisition = gate<{ stop(): Promise<void> }>(),
      stop = vi.fn(async () => undefined);
    const running = lane.run(
      { remainingMs: 1000, drainTimeoutMs: 25, signal: signal.signal },
      async (scope) => {
        scope.bind({
          stop: async () => {
            await (await acquisition.promise).stop();
          },
        });
        await acquisition.promise;
        scope.assertActive();
      },
    );
    const rejection = expect(running).rejects.toThrow("COMMAND_DRAIN_UNCONFIRMED");
    await Promise.resolve();
    await Promise.resolve();
    signal.abort();
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    acquisition.resolve({ stop });
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(lane.run({ remainingMs: 1000 }, async () => undefined)).rejects.toThrow(
      "COMMAND_DRAIN_UNCONFIRMED",
    );
  });
  it("is independent of wall-clock jumps and reuses one budget across phases", async () => {
    const original = Date.now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => original() + 86400000);
    await new CommandLane().run({ remainingMs: 1000 }, async (scope) => {
      const initial = scope.remainingMs();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scope.remainingMs()).toBeLessThan(initial);
      expect(scope.remainingMs(5)).toBeLessThanOrEqual(5);
    });
    clock.mockRestore();
  });
  it("prevents dispatch after a stalled event loop before the timer callback can run", async () => {
    let dispatched = false;
    await expect(
      new CommandLane().run({ remainingMs: 10 }, async (scope) => {
        const end = performance.now() + 20;
        while (performance.now() < end) {
          /* Isolated controller stall. */
        }
        scope.assertActive();
        dispatched = true;
      }),
    ).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
    expect(dispatched).toBe(false);
  });
  it("never passes the driver's zero-timeout sentinel and rejects invalid limits", async () => {
    await new CommandLane().run({ remainingMs: 1000 }, async (scope) => {
      expect(scope.remainingMs(1)).toBe(1);
      expect(() => scope.remainingMs(0)).toThrow("COMMAND_PHASE_BUDGET_INVALID");
    });
    for (const remainingMs of [-1, NaN, Infinity, 1.5, 900001])
      await expect(new CommandLane().run({ remainingMs }, async () => undefined)).rejects.toThrow(
        "COMMAND_BUDGET_INVALID",
      );
    for (const drainTimeoutMs of [0, NaN, 60001])
      await expect(
        new CommandLane().run({ remainingMs: 1000, drainTimeoutMs }, async () => undefined),
      ).rejects.toThrow("COMMAND_DRAIN_BUDGET_INVALID");
  });
  it("does not cancel an independent session lane", async () => {
    const signal = new AbortController(),
      held = gate();
    const first = new CommandLane().run(
      { remainingMs: 1000, signal: signal.signal },
      async (scope) => {
        scope.bind({
          stop: async () => {
            held.resolve();
          },
        });
        await held.promise;
      },
    );
    const rejection = expect(first).rejects.toThrow("COMMAND_CANCELLED");
    await Promise.resolve();
    signal.abort();
    expect(await new CommandLane().run({ remainingMs: 1000 }, async () => "independent")).toBe(
      "independent",
    );
    await rejection;
  });
});
