import { describe, expect, it, vi } from "vitest";

import { MissionService } from "../src/missions/mission.service.js";
import { resolveMissionRecording } from "../src/missions/mission-recording-resolver.js";

type QueryResult = {
  rowCount: number;
  rows: Array<Record<string, unknown>>;
};

const rows = (values: Array<Record<string, unknown>> = []): QueryResult => ({
  rowCount: values.length,
  rows: values,
});

const missionId = "11111111-1111-4111-8111-111111111111";

const objectiveId = "22222222-2222-4222-8222-222222222222";

const agentSessionId = "33333333-3333-4333-8333-333333333333";

const selectionId = "44444444-4444-4444-8444-444444444444";

const runA = "55555555-5555-4555-8555-555555555555";

const runB = "66666666-6666-4666-8666-666666666666";

const attemptA = "77777777-7777-4777-8777-777777777777";

const attemptB = "88888888-8888-4888-8888-888888888888";

const checkpointId = "99999999-9999-4999-8999-999999999999";

const praxisB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const contextA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const contextB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const videoArtifact = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const traceArtifact = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const selectedRunRows = [
  {
    runOrder: 0,

    runId: runA,
    objectiveId,
    runState: "passed",
    runOutcomeClassification: "passed",
    runResultClassification: "application_pass",
    runCreatedAt: "2026-08-16 22:00:00+00",

    canonicalAttemptId: attemptA,
    canonicalAttemptRunId: runA,
    canonicalAttemptNumber: 2,
    canonicalAttemptState: "passed",
    canonicalAttemptStartedAt: "2026-08-16 22:00:00+00",
    canonicalAttemptCompletedAt: "2026-08-16 22:01:00+00",
  },

  {
    runOrder: 1,

    runId: runB,
    objectiveId,
    runState: "passed",
    runOutcomeClassification: "passed",
    runResultClassification: "application_pass",
    runCreatedAt: "2026-08-16 22:02:00+00",

    canonicalAttemptId: attemptB,
    canonicalAttemptRunId: runB,
    canonicalAttemptNumber: 1,
    canonicalAttemptState: "passed",
    canonicalAttemptStartedAt: "2026-08-16 22:02:00+00",
    canonicalAttemptCompletedAt: "2026-08-16 22:03:00+00",
  },
];

const timelineRows = [
  {
    attemptId: attemptA,

    sequence: 1,
    entryType: "video_segment",

    operationId: null,
    channel: "video",

    startedAt: "2026-08-16 22:00:01+00",
    endedAt: "2026-08-16 22:00:20+00",

    reasonCode: null,

    // Intentionally false producer-local
    // sequence. Resolver MUST use the
    // persisted DB sequence above.
    metadata: {
      type: "video_segment",
      sequence: 999,
      reason: "run_started",
      status: "available",
      privacyStatus: "verified_safe",
    },

    contextId: contextA,
    captureEpoch: 1,

    artifactId: videoArtifact,
    artifactAttemptId: attemptA,
    artifactKind: "video",
    artifactAvailability: "available",
    artifactPrivacyClassification: "safe",
    artifactContentType: "video/webm",
    artifactSizeBytes: "1234",
    artifactChecksumSha256: "a".repeat(64),
    artifactContextId: contextA,
    artifactCaptureEpoch: 1,
    artifactCreatedAt: "2026-08-16 22:00:21+00",
  },

  {
    attemptId: attemptA,

    sequence: 3,
    entryType: "document_transition_gap",

    operationId: "navigate-a",
    channel: null,

    startedAt: "2026-08-16 22:00:20+00",
    endedAt: "2026-08-16 22:00:21+00",

    reasonCode: null,

    metadata: {
      type: "document_transition_gap",
      sequence: 1000,
      reason: "navigation_boundary",
    },

    contextId: contextA,
    captureEpoch: 1,

    artifactId: null,
    artifactAttemptId: null,
    artifactKind: null,
    artifactAvailability: null,
    artifactPrivacyClassification: null,
    artifactContentType: null,
    artifactSizeBytes: null,
    artifactChecksumSha256: null,
    artifactContextId: null,
    artifactCaptureEpoch: null,
    artifactCreatedAt: null,
  },

  {
    attemptId: attemptB,

    // Same sequence value as Attempt A is
    // valid because timeline authority is
    // Attempt-local.
    sequence: 1,
    entryType: "trace_segment",

    operationId: null,
    channel: "trace",

    startedAt: "2026-08-16 22:02:01+00",
    endedAt: "2026-08-16 22:02:20+00",

    reasonCode: "TRACE_QUARANTINED",

    metadata: {
      type: "trace_segment",
      sequence: 1,
      reason: "run_started",
      status: "quarantined",
      privacyStatus: "quarantined",
    },

    contextId: contextB,
    captureEpoch: 1,

    artifactId: traceArtifact,
    artifactAttemptId: attemptB,
    artifactKind: "trace",
    artifactAvailability: "destroyed",
    artifactPrivacyClassification: "uncertain",
    artifactContentType: "application/zip",
    artifactSizeBytes: null,
    artifactChecksumSha256: null,
    artifactContextId: contextB,
    artifactCaptureEpoch: 1,
    artifactCreatedAt: "2026-08-16 22:02:21+00",
  },
];

function recordingQuery(options?: {
  selection?: boolean;
  runCount?: number;

  selectedRuns?: Array<Record<string, unknown>>;

  timeline?: Array<Record<string, unknown>>;

  continuity?: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown>>;
}) {
  const config = {
    selection: true,
    runCount: 2,
    selectedRuns: selectedRunRows,
    timeline: timelineRows,
    continuity: [
      {
        predecessorRunId: runA,
        successorRunId: runB,
        checkpointId,
        restoredByPraxisSessionId: praxisB,
      },
    ],
    ...options,
  };

  return vi.fn(async (text: string, _values?: unknown[]): Promise<QueryResult> => {
    if (text.includes("FROM mission_recording_selections"))
      return config.selection
        ? rows([
            {
              id: selectionId,
              revision: 1,
              sourceMissionRevision: 11,
              selectedByAgentSessionId: agentSessionId,
              createdAt: "2026-08-16 22:04:00+00",
              sources: config.sources,
            },
          ])
        : rows();

    if (text.includes("FROM mission_recording_selection_runs")) return rows(config.selectedRuns);

    if (text.includes("FROM artifact_timeline_entries")) return rows(config.timeline);

    if (text.includes("FROM run_successor_checkpoints")) return rows(config.continuity);

    if (text.includes("count(*)::integer") && text.includes("FROM runs"))
      return rows([
        {
          count: config.runCount,
        },
      ]);

    throw new Error(`UNEXPECTED_QUERY: ${text}`);
  });
}

describe("Mission recording report resolution", () => {
  it("preserves external Run order, canonical Attempt-local timeline and exact checkpoint continuity", async () => {
    const query = recordingQuery();

    const resolved = await resolveMissionRecording(query as never, missionId);

    expect(resolved.selection).toMatchObject({
      id: selectionId,
      revision: 1,
      sourceMissionRevision: 11,
      selectedByAgentSessionId: agentSessionId,
    });

    expect(resolved.recording?.runs.map((run) => run.run.id)).toEqual([runA, runB]);

    expect(resolved.recording?.runs[0]!.timeline.map((entry) => entry.sequence)).toEqual([1, 3]);

    expect(resolved.recording?.runs[0]!.timeline[0]!.mediaDisposition).toBe("playable");

    expect(resolved.recording?.runs[0]!.timeline[1]!.entryType).toBe("document_transition_gap");

    expect(resolved.recording?.runs[1]!.timeline[0]!.sequence).toBe(1);

    expect(resolved.recording?.runs[1]!.timeline[0]!.mediaDisposition).toBe("omitted");

    expect(resolved.recording?.runs[1]!.continuityFromPrevious).toEqual({
      kind: "successor_checkpoint",
      predecessorRunId: runA,
      checkpointId,
      restoredByPraxisSessionId: praxisB,
    });

    expect(resolved.recording?.recordingDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when a Mission has Runs but no explicit recording selection", async () => {
    const query = recordingQuery({
      selection: false,
      runCount: 1,
    });

    await expect(resolveMissionRecording(query as never, missionId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_RECORDING_SELECTION_REQUIRED",
      }),
    });
  });

  it("allows a genuinely Run-free Mission to have no browser recording", async () => {
    const query = recordingQuery({
      selection: false,
      runCount: 0,
    });

    await expect(resolveMissionRecording(query as never, missionId)).resolves.toEqual({
      selection: null,
      recording: null,
    });
  });

  it("fails closed when a selected Run has no canonical latest Attempt", async () => {
    const query = recordingQuery({
      selectedRuns: [
        {
          ...selectedRunRows[0],
          canonicalAttemptId: null,
          canonicalAttemptRunId: null,
          canonicalAttemptNumber: null,
          canonicalAttemptState: null,
          canonicalAttemptStartedAt: null,
          canonicalAttemptCompletedAt: null,
        },
      ],
      timeline: [],
      continuity: [],
    });

    await expect(resolveMissionRecording(query as never, missionId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_RECORDING_CANONICAL_ATTEMPT_UNAVAILABLE",
      }),
    });
  });

  it("fails closed rather than silently pivoting a selected Run to a newer Attempt", async () => {
    const query = recordingQuery({
      selectedRuns: [selectedRunRows[0]!],
      timeline: timelineRows.filter((row) => row.attemptId === attemptA),
      continuity: [],
      sources: [{ order: 0, runId: runA, canonicalAttemptId: attemptB }],
    });

    await expect(resolveMissionRecording(query as never, missionId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_RECORDING_SELECTED_SOURCE_INADMISSIBLE",
      }),
    });
  });

  it("fails closed when more than one factual restore relation claims the same adjacent Run pair", async () => {
    const query = recordingQuery({
      continuity: [
        {
          predecessorRunId: runA,
          successorRunId: runB,
          checkpointId,
          restoredByPraxisSessionId: praxisB,
        },
        {
          predecessorRunId: runA,
          successorRunId: runB,
          checkpointId,
          restoredByPraxisSessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        },
      ],
    });

    await expect(resolveMissionRecording(query as never, missionId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_RECORDING_CONTINUITY_AMBIGUOUS",
      }),
    });
  });

  it("freezes the exact same factual recording surface through the shared report snapshot builder", async () => {
    const recording = recordingQuery({
      selectedRuns: [selectedRunRows[0]!],
      timeline: timelineRows.filter((row) => row.attemptId === attemptA),
      continuity: [],
    });

    const query = vi.fn(async (text: string, values?: unknown[]): Promise<QueryResult> => {
      if (
        text.includes("original_instruction") &&
        text.includes("FROM missions") &&
        !text.includes("JOIN projects")
      )
        return rows([
          {
            id: missionId,
            revision: 12,
            title: "Recording Mission",
            originalInstruction: "Navigate safely",
            status: "running",
          },
        ]);

      if (
        text.includes("FROM mission_objectives o") &&
        text.includes('o.objective_order AS "order"')
      )
        return rows([
          {
            id: objectiveId,
            title: "Navigate",
            status: "passed",
            conclusion: "Passed",
            order: 0,
          },
        ]);

      if (text.includes("FROM accepted_evidence e") && text.includes("JOIN LATERAL")) return rows();

      if (text.includes("FROM attempts a") && text.includes("FROM attempts newer"))
        return rows([
          {
            count: 0,
          },
        ]);

      if (text.includes("FROM mission_relations relation")) return rows();

      return recording(text, values);
    });

    const service = new MissionService({} as never);

    const builder = service as unknown as {
      buildReportSnapshot(
        q: typeof query,
        missionId: string,
        overallConclusion: string,
        journeySummary: string[],
        remainingActions: string[],
        finalStatus?: string,
      ): Promise<{
        recordingSelection: {
          id: string;
          sourceMissionRevision: number;
        } | null;

        recording: {
          recordingDigest: string;
          runs: Array<{
            run: {
              id: string;
            };
          }>;
        } | null;

        recordingDigest: string | null;
      }>;
    };

    const first = await builder.buildReportSnapshot(
      query,
      missionId,
      "Complete",
      ["Navigated"],
      [],
      "completed",
    );

    const second = await builder.buildReportSnapshot(
      query,
      missionId,
      "Complete",
      ["Navigated"],
      [],
      "completed",
    );

    expect(first.recordingSelection).toMatchObject({
      id: selectionId,
      sourceMissionRevision: 11,
    });

    expect(first.recording?.runs.map((run) => run.run.id)).toEqual([runA]);

    expect(first.recordingDigest).toBe(first.recording?.recordingDigest);

    expect(second.recordingDigest).toBe(first.recordingDigest);

    expect(second.recording).toEqual(first.recording);
  });
});
