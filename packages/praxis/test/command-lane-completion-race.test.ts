import { describe, expect, it, vi } from "vitest";
import { CommandLane } from "../src/command-lane.js";
describe("accepted cancellation at command completion", () => {
  it("never reports success when cancellation already stopped its bound resource", async () => {
    let accepted = 0,
      completed = 0;
    for (let depth = 0; depth < 32; depth += 1) {
      const signal = new AbortController(),
        stop = vi.fn(async () => undefined);
      const schedule = (remaining: number) =>
        queueMicrotask(() => {
          if (remaining) schedule(remaining - 1);
          else signal.abort();
        });
      let outcome: "success" | "cancelled";
      try {
        await new CommandLane().run({ remainingMs: 1000, signal: signal.signal }, async (scope) => {
          scope.bind({ stop });
          schedule(depth);
          return "completed-value";
        });
        outcome = "success";
      } catch (error) {
        expect(error).toMatchObject({ message: "SCRY_BROWSER_COMMAND_CANCELLED" });
        outcome = "cancelled";
      }
      if (stop.mock.calls.length) {
        accepted += 1;
        expect(outcome, `accepted cancellation at microtask depth ${depth}`).toBe("cancelled");
      } else {
        completed += 1;
        expect(outcome).toBe("success");
      }
    }
    // Both accepted cancellation and detached-after-success controls must run.
    expect(accepted).toBeGreaterThan(0);
    expect(completed).toBeGreaterThan(0);
  });
});
