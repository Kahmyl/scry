import { describe, expect, it } from "vitest";
import { commandExecutionBudgetMs } from "../src/browser-execution/command-budget.js";
describe("command operational budget policy", () => {
  it.each([
    "navigate",
    "observe",
    "fill",
    "click",
    "press",
    "capture_dom",
    "commit",
    "publish_capture",
    "discard_capture",
    "determine",
  ] as const)("bounds %s independently of phase timeouts", (kind) => {
    expect(commandExecutionBudgetMs(kind)).toBe(120000);
  });
  it.each(["close", "close_for_failure"] as const)(
    "bounds legacy synchronous %s separately",
    (kind) => {
      expect(commandExecutionBudgetMs(kind)).toBe(900000);
    },
  );
});
