import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { CommandLane } from "../src/command-lane.js";
const block = (milliseconds: number) => {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    /* Isolated controller stall. */
  }
};
describe("monotonic deadline on failed work", () => {
  it("cancels and drains bound resources when work throws after a timer-delaying stall", async () => {
    const lane = new CommandLane(),
      stop = vi.fn(async () => undefined);
    let signal!: AbortSignal;
    await expect(
      lane.run({ remainingMs: 10 }, async (scope) => {
        signal = scope.signal;
        scope.bind({ stop });
        block(30);
        throw new Error("fixture_work_failed");
      }),
    ).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
    expect(signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await lane.run({ remainingMs: 1000 }, async () => "drained")).toBe("drained");
  });
  it("also checks lifetime after ordinary-failure acquisition cleanup delays the timer", async () => {
    const lane = new CommandLane(),
      stopExisting = vi.fn(async () => undefined),
      stopNew = vi.fn(async () => {
        block(30);
      });
    await expect(
      lane.run({ remainingMs: 10 }, async (scope) => {
        scope.bind({ stop: stopExisting });
        await scope.acquire(async () => ({ stop: stopNew }));
        throw new Error("fixture_work_failed");
      }),
    ).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
    expect(stopExisting).toHaveBeenCalledTimes(1);
    expect(stopNew).toHaveBeenCalledTimes(1);
  });
});
