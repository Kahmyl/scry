import { describe, expect, it } from "vitest";

import { ExecutionState } from "../src/execution-state.js";

describe("ExecutionState", () => {
  it("owns capture epochs and closes them conservatively", () => {
    const state = new ExecutionState();
    state.startCaptureEpoch("run_started", "safe-context");
    expect(state.captureEpoch).toBe(1);
    state.endCaptureEpoch("sealed", "sealed");
    state.startCaptureEpoch("checkpoint_restored", "restored-context");
    state.endCaptureEpoch("run_completed");

    expect(state.lifecycleTimeline).toMatchObject([
      {
        type: "capture_epoch",
        epoch: 1,
        contextId: "safe-context",
        endReason: "sealed",
        status: "sealed",
      },
      {
        type: "capture_epoch",
        epoch: 2,
        contextId: "restored-context",
        endReason: "run_completed",
        status: "completed",
      },
    ]);
  });

  it("records checkpoint boundaries against the active epoch", () => {
    const state = new ExecutionState();
    state.recordCheckpointBoundary("checkpoint-1", "established");
    expect(state.lifecycleTimeline[0]).toMatchObject({
      type: "checkpoint_boundary",
      checkpointId: "checkpoint-1",
      boundary: "established",
      captureEpoch: 1,
    });
  });
});
