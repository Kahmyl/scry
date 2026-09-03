import {
  composeMissionRecording,
  type MissionRecordingSelectedRun,
  type MissionRecordingTimelineFact,
} from "../src/index.js";

import { describe, expect, it } from "vitest";

function videoEntry(
  attemptId: string,
  sequence: number,
  checksum = "a".repeat(64),
): MissionRecordingTimelineFact {
  return {
    sequence,
    entryType: "video_segment",

    operationId: null,
    channel: "video",

    startedAt: "2026-08-16T22:33:49.738Z",
    endedAt: "2026-08-16T22:33:49.798Z",

    reason: "run_started",
    status: "available",
    privacyStatus: "verified_safe",

    contextId: "context-a",
    captureEpoch: 1,

    checkpointId: null,
    checkpointBoundary: null,

    artifactId: `artifact-${attemptId}-${sequence}`,

    artifact: {
      id: `artifact-${attemptId}-${sequence}`,
      attemptId,
      kind: "video",
      availability: "available",
      privacyClassification: "safe",
      contentType: "video/webm",
      sizeBytes: "1983",
      checksumSha256: checksum,
      contextId: "context-a",
      captureEpoch: 1,
      createdAt: "2026-08-16T22:33:55.348Z",
    },
  };
}

function gap(sequence: number): MissionRecordingTimelineFact {
  return {
    sequence,
    entryType: "document_transition_gap",

    operationId: "operation-a",
    channel: null,

    startedAt: "2026-08-16T22:33:49.807Z",
    endedAt: "2026-08-16T22:33:50.504Z",

    reason: "navigation_boundary",
    status: null,
    privacyStatus: null,

    contextId: "context-a",
    captureEpoch: 1,

    checkpointId: null,
    checkpointBoundary: null,

    artifactId: null,
    artifact: null,
  };
}

function selectedRun(
  order: number,
  runId: string,
  attemptId: string,
  timeline: readonly MissionRecordingTimelineFact[],
): MissionRecordingSelectedRun {
  return {
    order,

    run: {
      id: runId,
      objectiveId: "objective-a",
      state: "passed",
      outcomeClassification: "passed",
      resultClassification: "application_pass",
      createdAt: "2026-08-16T22:33:49.335Z",
      completedAt: "2026-08-16T22:34:03.053Z",
    },

    canonicalAttempt: {
      id: attemptId,
      runId,
      attemptNumber: 1,
      state: "passed",
      startedAt: "2026-08-16T22:33:49.335Z",
      completedAt: "2026-08-16T22:34:03.053Z",
    },

    continuityFromPrevious: null,

    timeline,
  };
}

function quarantinedTraceEntry(attemptId: string, sequence: number): MissionRecordingTimelineFact {
  return {
    sequence,
    entryType: "trace_segment",

    operationId: null,
    channel: "trace",

    startedAt: "2026-08-16T22:33:49.753Z",
    endedAt: "2026-08-16T22:33:53.607Z",

    reason: "run_started",
    status: "quarantined",
    privacyStatus: "quarantined",

    contextId: "context-a",
    captureEpoch: 1,

    checkpointId: null,
    checkpointBoundary: null,

    artifactId: `trace-${attemptId}-${sequence}`,

    artifact: {
      id: `trace-${attemptId}-${sequence}`,
      attemptId,

      kind: "trace",

      availability: "destroyed",

      privacyClassification: "uncertain",

      contentType: "application/zip",

      sizeBytes: null,
      checksumSha256: null,

      contextId: "context-a",
      captureEpoch: 1,

      createdAt: "2026-08-16T22:33:55.348Z",
    },
  };
}

describe("Mission recording composition", () => {
  it("uses explicit Run order and Attempt-local sequence deterministically", () => {
    const first = selectedRun(0, "run-a", "attempt-a", [gap(3), videoEntry("attempt-a", 1)]);

    const second: MissionRecordingSelectedRun = {
      ...selectedRun(1, "run-b", "attempt-b", [videoEntry("attempt-b", 1)]),

      continuityFromPrevious: {
        kind: "successor_checkpoint",
        predecessorRunId: "run-a",
        checkpointId: "checkpoint-a",
        restoredByPraxisSessionId: "praxis-b",
      },
    };

    const left = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      runs: [second, first],
    });

    const right = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      runs: [first, second],
    });

    expect(left).toEqual(right);

    expect(left.runs.map((entry) => entry.run.id)).toEqual(["run-a", "run-b"]);

    expect(left.runs[0]!.timeline.map((entry) => entry.sequence)).toEqual([1, 3]);

    // Sequence 1 is valid in both
    // Attempts because sequence authority
    // is Attempt-local.
    expect(left.runs[1]!.timeline[0]!.sequence).toBe(1);

    expect(left.boundaries).toEqual([
      {
        order: 0,
        kind: "verified_checkpoint",
        predecessorRunId: "run-a",
        successorRunId: "run-b",
        checkpointId: "checkpoint-a",
        restoredByPraxisSessionId: "praxis-b",
      },
    ]);

    expect(left.recordingDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(Object.isFrozen(left)).toBe(true);
  });

  it("records an explicit cross-Run gap when no verified continuity fact exists", () => {
    const manifest = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      runs: [
        selectedRun(0, "run-a", "attempt-a", [videoEntry("attempt-a", 1)]),
        selectedRun(1, "run-b", "attempt-b", [videoEntry("attempt-b", 1)]),
      ],
    });

    expect(manifest.boundaries).toEqual([
      expect.objectContaining({
        order: 0,
        kind: "recording_gap",
        predecessorRunId: "run-a",
        successorRunId: "run-b",
        reason: "browser_authority_changed_without_verified_continuity",
      }),
    ]);
  });

  it("preserves intentional gaps rather than fabricating continuous media", () => {
    const manifest = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,

      runs: [
        selectedRun(0, "run-a", "attempt-a", [
          videoEntry("attempt-a", 1),
          gap(3),
          videoEntry("attempt-a", 4),
        ]),
      ],
    });

    expect(manifest.runs[0]!.timeline.map((entry) => entry.entryType)).toEqual([
      "video_segment",
      "document_transition_gap",
      "video_segment",
    ]);
  });

  it("binds the digest to media checksum and gap provenance", () => {
    const base = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      runs: [selectedRun(0, "run-a", "attempt-a", [videoEntry("attempt-a", 1), gap(3)])],
    });

    const changedChecksum = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      runs: [
        selectedRun(0, "run-a", "attempt-a", [videoEntry("attempt-a", 1, "b".repeat(64)), gap(3)]),
      ],
    });

    const changedGap = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      runs: [
        selectedRun(0, "run-a", "attempt-a", [
          videoEntry("attempt-a", 1),
          {
            ...gap(3),
            reason: "different_boundary",
          },
        ]),
      ],
    });

    expect(changedChecksum.recordingDigest).not.toBe(base.recordingDigest);

    expect(changedGap.recordingDigest).not.toBe(base.recordingDigest);
  });

  it("rejects an Artifact from a different Attempt", () => {
    const entry = videoEntry("attempt-old", 1);

    expect(() =>
      composeMissionRecording({
        missionId: "mission-a",
        sourceMissionRevision: 11,

        runs: [selectedRun(0, "run-a", "attempt-current", [entry])],
      }),
    ).toThrow("CHRONICLE_RECORDING_ARTIFACT_ATTEMPT_MISMATCH");
  });

  it("rejects unsafe or unavailable playable segments", () => {
    const unsafe = videoEntry("attempt-a", 1);

    expect(() =>
      composeMissionRecording({
        missionId: "mission-a",
        sourceMissionRevision: 11,

        runs: [
          selectedRun(0, "run-a", "attempt-a", [
            {
              ...unsafe,
              artifact: {
                ...unsafe.artifact!,
                privacyClassification: "uncertain",
              },
            },
          ]),
        ],
      }),
    ).toThrow("CHRONICLE_RECORDING_SEGMENT_PRIVACY_UNSAFE");
  });

  it("requires checkpoint continuity to name the immediately preceding selected Run", () => {
    const first = selectedRun(0, "run-a", "attempt-a", []);

    const second: MissionRecordingSelectedRun = {
      ...selectedRun(1, "run-b", "attempt-b", []),

      continuityFromPrevious: {
        kind: "successor_checkpoint",
        predecessorRunId: "some-other-run",
        checkpointId: "checkpoint-a",
        restoredByPraxisSessionId: "praxis-b",
      },
    };

    expect(() =>
      composeMissionRecording({
        missionId: "mission-a",
        sourceMissionRevision: 11,
        runs: [first, second],
      }),
    ).toThrow("CHRONICLE_RECORDING_PREDECESSOR_MISMATCH");
  });

  it("does not infer continuity when the caller supplies none", () => {
    const manifest = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,

      runs: [selectedRun(0, "run-a", "attempt-a", []), selectedRun(1, "run-b", "attempt-b", [])],
    });

    expect(manifest.runs[1]!.continuityFromPrevious).toBeNull();
  });
  it("preserves explicitly quarantined destroyed media as an omitted timeline fact", () => {
    const manifest = composeMissionRecording({
      missionId: "mission-a",
      sourceMissionRevision: 11,

      runs: [
        selectedRun(0, "run-a", "attempt-a", [
          videoEntry("attempt-a", 1),

          quarantinedTraceEntry("attempt-a", 2),

          gap(3),
        ]),
      ],
    });

    expect(
      manifest.runs[0]!.timeline.map((entry) => ({
        type: entry.entryType,
        disposition: entry.mediaDisposition,
      })),
    ).toEqual([
      {
        type: "video_segment",
        disposition: "playable",
      },
      {
        type: "trace_segment",
        disposition: "omitted",
      },
      {
        type: "document_transition_gap",
        disposition: null,
      },
    ]);

    const omitted = manifest.runs[0]!.timeline[1]!;

    expect(omitted.artifact?.availability).toBe("destroyed");

    expect(omitted.artifact?.privacyClassification).toBe("uncertain");

    expect(omitted.artifact?.checksumSha256).toBeNull();
  });

  it("rejects destroyed media unless quarantine omission is explicit", () => {
    const ambiguous = quarantinedTraceEntry("attempt-a", 2);

    expect(() =>
      composeMissionRecording({
        missionId: "mission-a",
        sourceMissionRevision: 11,

        runs: [
          selectedRun(0, "run-a", "attempt-a", [
            {
              ...ambiguous,
              status: "available",
              privacyStatus: "verified_safe",
            },
          ]),
        ],
      }),
    ).toThrow("CHRONICLE_RECORDING_SEGMENT_OMISSION_UNPROVEN");
  });

  it("rejects contradictory available plus quarantined media state", () => {
    const playable = videoEntry("attempt-a", 1);

    expect(() =>
      composeMissionRecording({
        missionId: "mission-a",
        sourceMissionRevision: 11,

        runs: [
          selectedRun(0, "run-a", "attempt-a", [
            {
              ...playable,
              status: "quarantined",
              privacyStatus: "quarantined",
            },
          ]),
        ],
      }),
    ).toThrow("CHRONICLE_RECORDING_SEGMENT_STATE_INCONSISTENT");
  });
});
