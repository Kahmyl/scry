import { describe, expect, it } from "vitest";

import type { MissionReport } from "../../infrastructure/api/client.js";
import { recordingPlayback, selectedEvidenceByRun } from "./mission-report-view.js";

const baseSnapshot = {
  mission: { title: "Mission", originalInstruction: "Verify", status: "completed" },
  overallConclusion: "Complete",
  journeySummary: ["Verified"],
  remainingActions: [],
  objectiveResults: [
    {
      id: "objective-a",
      title: "Objective",
      status: "passed",
      acceptedRunIds: ["run-a"],
      acceptedArtifactIds: ["artifact-z", "artifact-a"],
    },
  ],
  evidence: {
    objectives: [
      {
        objectiveId: "objective-a",
        acceptedEvidence: [accepted("artifact-z", 0), accepted("artifact-a", 1)],
      },
    ],
  },
  recording: null,
  supersededAttemptCount: 0,
  generatedAt: "2026-08-23T16:00:00.000Z",
} satisfies MissionReport["snapshot"];

describe("Mission report composition projection", () => {
  it("renders only the immutable accepted Artifact selection in caller order", () => {
    const runs = selectedEvidenceByRun(baseSnapshot, "objective-a");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.artifacts.map(({ id }) => id)).toEqual(["artifact-z", "artifact-a"]);
  });

  it("keeps original segment IDs and inserts the manifest's explicit cross-Run boundary", () => {
    const recording: NonNullable<MissionReport["snapshot"]["recording"]> = {
      schemaVersion: 1,
      missionId: "mission-a",
      sourceMissionRevision: 4,
      runs: [
        selectedRun(0, "run-a", "attempt-a", "video-a"),
        selectedRun(1, "run-b", "attempt-b", "video-b"),
      ],
      boundaries: [
        {
          order: 0,
          kind: "recording_gap",
          predecessorRunId: "run-a",
          successorRunId: "run-b",
          startedAt: "2026-08-23T16:01:00.000Z",
          endedAt: "2026-08-23T16:02:00.000Z",
          reason: "browser_authority_changed_without_verified_continuity",
        },
      ],
      recordingDigest: "a".repeat(64),
    };

    const playback = recordingPlayback(recording);
    expect(playback.entries.map(({ type }) => type)).toEqual([
      "video_segment",
      "recording_boundary",
      "video_segment",
    ]);
    expect(playback.entries.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(playback.artifacts.map(({ id }) => id)).toEqual(["video-a", "video-b"]);
  });
});

function accepted(artifactId: string, selectionOrder: number) {
  return {
    id: `accepted-${artifactId}`,
    runId: "run-a",
    artifactId,
    selectionOrder,
    acceptanceConclusion: "Accepted",
    run: { id: "run-a", state: "passed", environmentId: "environment-a" },
    canonicalAttempt: { id: "attempt-a", runId: "run-a" },
    artifact: {
      id: artifactId,
      attemptId: "attempt-a",
      stepId: `step-${selectionOrder}`,
      kind: "screenshot",
      availability: "available",
      privacyClassification: "safe",
      contentType: "image/png",
      sizeBytes: "100",
    },
  };
}

function selectedRun(order: number, runId: string, attemptId: string, artifactId: string) {
  return {
    order,
    run: {
      id: runId,
      objectiveId: "objective-a",
      createdAt: `2026-08-23T16:0${order}:00.000Z`,
      completedAt: `2026-08-23T16:0${order + 1}:00.000Z`,
    },
    canonicalAttempt: { id: attemptId, runId },
    timeline: [
      {
        sequence: 0,
        entryType: "video_segment",
        operationId: null,
        startedAt: `2026-08-23T16:0${order}:10.000Z`,
        endedAt: `2026-08-23T16:0${order}:50.000Z`,
        reason: "run_started",
        status: "available",
        privacyStatus: "verified_safe",
        artifactId,
        mediaDisposition: "playable" as const,
        artifact: {
          id: artifactId,
          attemptId,
          kind: "video",
          availability: "available",
          privacyClassification: "safe",
          contentType: "video/webm",
          sizeBytes: "1000",
        },
      },
    ],
  };
}
