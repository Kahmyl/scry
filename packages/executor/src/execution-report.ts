import type { Artifact, RecordingTimelineEntry } from "@scry/contracts";

import { classifyOutcome } from "./execution-outcome.js";
import type {
  DiagnosticRecord,
  ExecutionReport,
  PolicyViolationRecord,
  StepExecutionResult,
} from "./types.js";

export function mergeArtifactTimeline(
  ...groups: RecordingTimelineEntry[][]
): RecordingTimelineEntry[] {
  return groups
    .flat()
    .sort((left, right) => {
      const leftTime = "startedAt" in left ? left.startedAt : left.occurredAt;
      const rightTime = "startedAt" in right ? right.startedAt : right.occurredAt;
      return Date.parse(leftTime) - Date.parse(rightTime);
    })
    .map((entry, sequence) => ({ ...entry, sequence }));
}

interface BuildExecutionReportInput {
  planName: string;
  runId: string;
  attemptId: string;
  state: ExecutionReport["state"];
  startedAt: Date;
  completedAt: Date;
  steps: StepExecutionResult[];
  diagnostics: DiagnosticRecord[];
  policyViolations: PolicyViolationRecord[];
  retiredArtifacts: Artifact[];
  runArtifacts: Artifact[];
  retiredTimeline: RecordingTimelineEntry[];
  lifecycleTimeline: RecordingTimelineEntry[];
  recordingTimeline: RecordingTimelineEntry[];
  traceTimeline: RecordingTimelineEntry[];
  error?: string;
}

export function buildExecutionReport(input: BuildExecutionReportInput): ExecutionReport {
  const assertions = input.steps.flatMap((step) => step.assertions);
  return {
    planName: input.planName,
    runId: input.runId,
    attemptId: input.attemptId,
    state: input.state,
    outcomeClassification: classifyOutcome(input.state, input.steps, input.policyViolations),
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: input.completedAt.getTime() - input.startedAt.getTime(),
    requiredAssertions: {
      passed: assertions.filter((item) => item.status === "passed").length,
      failed: assertions.filter((item) => item.status === "failed").length,
      unevaluated: assertions.filter((item) => item.status === "unevaluated").length,
    },
    artifacts: [
      ...input.retiredArtifacts,
      ...input.runArtifacts,
      ...input.steps.flatMap((step) => step.artifacts),
    ],
    ...(input.error ? { error: input.error } : {}),
    steps: input.steps,
    diagnostics: input.diagnostics,
    policyViolations: input.policyViolations,
    artifactTimeline: mergeArtifactTimeline(
      input.retiredTimeline,
      input.lifecycleTimeline,
      input.recordingTimeline,
      input.traceTimeline,
    ),
  };
}
