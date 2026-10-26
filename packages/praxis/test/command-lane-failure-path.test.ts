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
  it("also checks lifetime when the owner's ordinary-failure cleanup delays the timer", async () => {
    const lane = new CommandLane(),
      stopExisting = vi.fn(async () => undefined),
      cleanup = vi.fn(async () => {
        block(30);
      });
    await expect(
      lane.run({ remainingMs: 10 }, async (scope) => {
        scope.bind({ stop: stopExisting });
        try {
          throw new Error("fixture_work_failed");
        } finally {
          await cleanup();
        }
      }),
    ).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
    expect(stopExisting).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
