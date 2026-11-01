import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { CommandLane } from "../src/command-lane.js";
const schedule = (depth: number, work: () => void) =>
  queueMicrotask(() => {
    if (depth) schedule(depth - 1, work);
    else work();
  });
const microtasksDrained = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("closed command finalization admission", () => {
  it("owns the initial cell if expiry is discovered while binding it", async () => {
    const stop = vi.fn(async () => undefined);
    await expect(
      new CommandLane().run({ remainingMs: 10 }, async (scope) => {
        const end = performance.now() + 30;
        while (performance.now() < end) {
          /* Before initial binding. */
        }
        scope.bind({ stop });
      }),
    ).rejects.toThrow("COMMAND_DEADLINE_EXCEEDED");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("refuses bindings in the finishing window before releasing the lane", async () => {
    let finishing = 0,
      active = 0,
      ended = 0;
    for (let depth = 0; depth < 16; depth += 1) {
      let rejection: unknown, state: string | undefined;
      await new CommandLane().run({ remainingMs: 1000 }, async (scope) => {
        schedule(depth, () => {
          state = scope.state;
          try {
            scope.bind({ stop: async () => undefined });
          } catch (error) {
            rejection = error;
          }
        });
      });
      await microtasksDrained();
      if (state === "active") {
        active += 1;
        expect(rejection).toBeUndefined();
      } else {
        expect(rejection).toMatchObject({ message: "SCRY_BROWSER_COMMAND_ATTEMPT_ENDED" });
        if (state === "finishing") finishing += 1;
        else ended += 1;
      }
    }
    expect(active).toBeGreaterThan(0);
    expect(finishing).toBeGreaterThan(0);
    expect(ended).toBeGreaterThan(0);
  });
  it("checks expiry at finalization but does not retroactively cancel already completed work", async () => {
    let finishing = 0,
      cancelled = 0,
      completed = 0;
    for (let depth = 0; depth < 16; depth += 1) {
      let atStall: string | undefined;
      const stop = vi.fn(async () => undefined);
      const result = await new CommandLane()
        .run({ remainingMs: 10 }, async (scope) => {
          scope.bind({ stop });
          schedule(depth, () => {
            atStall = scope.state;
            const end = performance.now() + 30;
            while (performance.now() < end) {
              /* Isolated completion-window stall. */
            }
          });
          return "success";
        })
        .catch((error: unknown) => error);
      await microtasksDrained();
      if (atStall === "active" || atStall === "finishing") {
        cancelled += 1;
        if (atStall === "finishing") finishing += 1;
        expect(result).toMatchObject({ message: "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED" });
        expect(stop).toHaveBeenCalledTimes(1);
      } else {
        completed += 1;
        expect(atStall).toBe("completed");
        expect(result).toBe("success");
        expect(stop).not.toHaveBeenCalled();
      }
    }
    expect(finishing).toBeGreaterThan(0);
    expect(cancelled).toBeGreaterThan(0);
    expect(completed).toBeGreaterThan(0);
  });
});
