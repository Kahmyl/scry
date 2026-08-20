import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const reportCommit = readFileSync(
  new URL("../src/runtime/report-commit.ts", import.meta.url),
  "utf8",
);

const observationRepository = readFileSync(
  new URL("../src/runtime/repositories/execution-observation.repository.ts", import.meta.url),
  "utf8",
);

const executionRepository = readFileSync(
  new URL("../src/runtime/repositories/execution.repository.ts", import.meta.url),
  "utf8",
);

const worker = readFileSync(
  new URL("../src/workers/processors/run.processor.ts", import.meta.url),
  "utf8",
);

const agentDirected = readFileSync(
  new URL("../src/runs/services/agent-directed-run.service.ts", import.meta.url),
  "utf8",
);

const runAttempt = readFileSync(
  new URL("../src/runtime/repositories/run-attempt.repository.ts", import.meta.url),
  "utf8",
);

const authoring = readFileSync(
  new URL("../src/authoring/services/authoring.service.ts", import.meta.url),
  "utf8",
);

describe("canonical report commit atomicity", () => {
  it("persists report observations through one transaction-scoped writer", () => {
    expect(executionRepository).toContain("observationTransaction");
    expect(observationRepository).toContain("withClient(client: PoolClient)");

    expect(reportCommit).toMatch(
      /observationTransaction[\s\S]*recordStepResult[\s\S]*recordCaptureEpochs[\s\S]*recordArtifact[\s\S]*recordArtifactTimeline/,
    );
  });

  it("keeps artifact-store compensation outside the canonical metadata transaction failure", () => {
    expect(reportCommit).toMatch(
      /catch \(error\)[\s\S]*artifactStore\.delete[\s\S]*artifactStore\.exists/,
    );
    expect(reportCommit).toContain("ARTIFACT_COMMIT_COMPENSATION_FAILED");
  });

  it("routes the worker through the canonical report commit", () => {
    expect(worker).toContain("commitExecutionReport");
    expect(worker).not.toContain("options.executions.recordStepResult");
    expect(worker).not.toContain("options.executions.recordArtifactTimeline");
  });
});

describe("failed recording timeline closure", () => {
  const failedSegmentPattern =
    /(?:timeline\.)?entry_type IN \(\s*'video_segment',\s*'trace_segment'\s*\)[\s\S]{0,180}?(?:timeline\.)?reason_code IS NOT NULL/;

  it("blocks failed media/trace segments in agent-directed pass closure", () => {
    expect(agentDirected).toMatch(failedSegmentPattern);
  });

  it("keeps canonical Run completion/certification fail-closed", () => {
    expect(runAttempt).toMatch(failedSegmentPattern);
    expect(authoring).toMatch(failedSegmentPattern);
  });
});
