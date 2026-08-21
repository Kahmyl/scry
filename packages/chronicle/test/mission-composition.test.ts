import { composeMissionEvidence, type MissionAcceptedEvidenceFact } from "../src/index.js";
import { describe, expect, it } from "vitest";

function accepted(
  overrides: Partial<MissionAcceptedEvidenceFact> = {},
): MissionAcceptedEvidenceFact {
  const runId = overrides.runId ?? "run-a";
  const attemptId = overrides.canonicalAttempt?.id ?? "attempt-a";

  return {
    id: "acceptance-a",
    objectiveId: "objective-a",
    runId,
    artifactId: "artifact-a",
    acceptanceConclusion: "Agent accepted this evidence.",
    acceptedByAgentSessionId: "agent-a",
    acceptedAt: "2026-08-16T22:34:01.000Z",
    run: {
      id: runId,
      state: "passed",
      outcomeClassification: "application_pass",
      resultClassification: "passed",
      reliabilityEligible: true,
      flowRevisionId: "flow-revision-a",
      environmentId: "environment-a",
      executionModel: "agent_directed_v1",
      createdAt: "2026-08-16T22:33:49.000Z",
      updatedAt: "2026-08-16T22:34:03.000Z",
      ...overrides.run,
    },
    canonicalAttempt: {
      id: attemptId,
      runId,
      attemptNumber: 1,
      state: "passed",
      startedAt: "2026-08-16T22:33:49.000Z",
      completedAt: "2026-08-16T22:34:03.000Z",
      ...overrides.canonicalAttempt,
    },
    artifact: {
      id: "artifact-a",
      attemptId,
      kind: "screenshot",
      availability: "available",
      privacyClassification: "safe",
      contentType: "image/png",
      sizeBytes: "4257",
      checksumSha256: "a".repeat(64),
      contextId: "context-a",
      captureEpoch: 1,
      retentionUntil: "2026-09-15T22:34:03.000Z",
      createdAt: "2026-08-16T22:34:01.000Z",
      ...overrides.artifact,
    },
    ...overrides,
  };
}

describe("Mission evidence composition", () => {
  it("is deterministic regardless of input ordering", () => {
    const first = accepted();

    const second = accepted({
      id: "acceptance-b",
      artifactId: null,
      artifact: null,
      acceptedAt: "2026-08-16T22:34:02.000Z",
    });

    const left = composeMissionEvidence({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      objectives: [
        {
          objectiveId: "objective-b",
          order: 1,
        },
        {
          objectiveId: "objective-a",
          order: 0,
        },
      ],
      acceptedEvidence: [second, first],
      supersededAttemptCount: 2,
    });

    const right = composeMissionEvidence({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      objectives: [
        {
          objectiveId: "objective-a",
          order: 0,
        },
        {
          objectiveId: "objective-b",
          order: 1,
        },
      ],
      acceptedEvidence: [first, second],
      supersededAttemptCount: 2,
    });

    expect(left).toEqual(right);
    expect(left.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(left.objectives[0]!.acceptedRunIds).toEqual(["run-a"]);

    expect(left.objectives[0]!.acceptedArtifactIds).toEqual(["artifact-a"]);

    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.objectives[0]!.acceptedEvidence[0]!)).toBe(true);
  });

  it("changes the digest when immutable evidence facts change", () => {
    const left = composeMissionEvidence({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      objectives: [
        {
          objectiveId: "objective-a",
          order: 0,
        },
      ],
      acceptedEvidence: [accepted()],
      supersededAttemptCount: 0,
    });

    const right = composeMissionEvidence({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      objectives: [
        {
          objectiveId: "objective-a",
          order: 0,
        },
      ],
      acceptedEvidence: [
        accepted({
          artifact: {
            ...accepted().artifact!,
            checksumSha256: "b".repeat(64),
          },
        }),
      ],
      supersededAttemptCount: 0,
    });

    expect(left.evidenceDigest).not.toBe(right.evidenceDigest);
  });

  it("fails closed when an accepted Artifact is not from the canonical Attempt", () => {
    expect(() =>
      composeMissionEvidence({
        missionId: "mission-a",
        sourceMissionRevision: 11,
        objectives: [
          {
            objectiveId: "objective-a",
            order: 0,
          },
        ],
        acceptedEvidence: [
          accepted({
            artifact: {
              ...accepted().artifact!,
              attemptId: "older-attempt",
            },
          }),
        ],
        supersededAttemptCount: 1,
      }),
    ).toThrow("CHRONICLE_EVIDENCE_ARTIFACT_ATTEMPT_MISMATCH");
  });

  it("supports explicit Run-level acceptance independently of Artifact acceptance", () => {
    const composition = composeMissionEvidence({
      missionId: "mission-a",
      sourceMissionRevision: 11,
      objectives: [
        {
          objectiveId: "objective-a",
          order: 0,
        },
      ],
      acceptedEvidence: [
        accepted({
          artifactId: null,
          artifact: null,
        }),
      ],
      supersededAttemptCount: 0,
    });

    expect(composition.objectives[0]!.acceptedRunIds).toEqual(["run-a"]);

    expect(composition.objectives[0]!.acceptedArtifactIds).toEqual([]);
  });
});
