import { describe, expect, it } from "vitest";

import { buildExecutionReport } from "../src/execution-report.js";
import type { StepExecutionResult } from "../src/types.js";

function step(status: StepExecutionResult["status"]): StepExecutionResult {
  return {
    id: `step-${status}`,
    title: status,
    status,
    assertions: [
      {
        index: 0,
        type: "visible",
        status: status === "passed" ? "passed" : status === "failed" ? "failed" : "unevaluated",
      },
    ],
    artifacts: [],
    action: { status },
    evidence: [],
  };
}

describe("buildExecutionReport", () => {
  it("projects assertion totals and terminal outcome from execution state", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const completedAt = new Date("2026-01-01T00:00:01.250Z");
    const report = buildExecutionReport({
      planName: "report projection",
      runId: "run-1",
      attemptId: "attempt-1",
      state: "failed",
      startedAt,
      completedAt,
      steps: [step("passed"), step("failed"), step("unevaluated")],
      diagnostics: [],
      policyViolations: [],
      retiredArtifacts: [],
      runArtifacts: [],
      retiredTimeline: [],
      lifecycleTimeline: [],
      recordingTimeline: [],
      traceTimeline: [],
      error: "failure",
    });

    expect(report.durationMs).toBe(1_250);
    expect(report.requiredAssertions).toEqual({ passed: 1, failed: 1, unevaluated: 1 });
    expect(report.state).toBe("failed");
    expect(report.error).toBe("failure");
  });
});
