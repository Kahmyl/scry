import { describe, expect, it, vi } from "vitest";

import { commitExecutionReport } from "../src/runtime/report-commit.js";

describe("agent-directed ExecutionReport scoping", () => {
  it("namespaces repeated kernel steps and appends per-operation chronology", async () => {
    const observations = {
      recordStepResult: vi.fn(),
      recordAssertion: vi.fn(),
      recordCaptureEpochs: vi.fn(),
      recordArtifact: vi.fn(),
      recordArtifactTimeline: vi.fn(),
    };

    const executions = {
      ...observations,
      observationTransaction: vi.fn(
        async (work: (writer: typeof observations) => Promise<unknown>) => work(observations),
      ),
    };

    const report = {
      state: "passed",
      outcomeClassification: "passed",
      artifacts: [],
      steps: [
        {
          id: "kernel-interaction",
          action: { status: "passed" },
          assertions: [],
          artifacts: [],
          evidence: [],
        },
      ],
      artifactTimeline: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          sequence: 1,
          type: "checkpoint_boundary",
          checkpointId: "operation-finished",
          occurredAt: new Date().toISOString(),
          metadata: {},
        },
      ],
    };

    await commitExecutionReport(
      {
        executions: executions as never,
        artifactRoot: "/tmp/scry-artifacts",
        artifactRetentionMs: 60_000,
        artifactStore: {} as never,
        artifactStoreRemote: false,
      },
      report as never,
      "/tmp/scry-artifacts/run/op",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      {
        stepIdPrefix: "operation-a",
        ordinalOffset: 7,
        timelineSequenceOffset: 11,
      },
    );

    expect(executions.observationTransaction).toHaveBeenCalledTimes(1);

    expect(executions.recordStepResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ordinal: 7,
        step: expect.objectContaining({
          id: "operation-a::kernel-interaction",
        }),
      }),
    );

    expect(executions.recordArtifactTimeline).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [
        expect.objectContaining({
          sequence: 12,
        }),
      ],
    );
  });
});
