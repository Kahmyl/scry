import { expect, it, vi } from "vitest";
import SafeQualificationReporter from "../scripts/safe-reporter.js";
import { parseTestCounts } from "../src/qualification.js";

it("reports every terminal test state without copying names, logs or errors", () => {
  const reporter = new SafeQualificationReporter();
  const modules = [
    {
      name: "private-module",
      state: () => "failed",
      children: {
        allTests: () =>
          ["passed", "failed", "skipped", "pending"].map((state) => ({
            name: "private-test",
            result: () => ({ state, errors: [new Error("private-value")] }),
          })),
      },
    },
  ] as unknown as Parameters<typeof reporter.onTestRunEnd>[0];
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    reporter.onTestRunEnd(
      modules,
      [{ message: "private-exception" }] as Parameters<typeof reporter.onTestRunEnd>[1],
      "failed",
    );
    const text = String(output.mock.calls[0]?.[0]);
    expect(text).not.toContain("private-");
    expect(parseTestCounts(text)).toEqual({
      total: 4,
      passed: 1,
      failed: 1,
      skipped: 1,
      pending: 1,
      errors: 3,
    });
    output.mockClear();
    reporter.onTestRunEnd([], [], "interrupted");
    expect(parseTestCounts(String(output.mock.calls[0]?.[0]))?.errors).toBe(1);
  } finally {
    output.mockRestore();
  }
});
