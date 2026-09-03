import { createHash } from "node:crypto";

export type MissionRecordingEntryType =
  | "capture_epoch"
  | "video_segment"
  | "trace_segment"
  | "protected_gap"
  | "document_transition_gap"
  | "unavailable_interval"
  | "quarantine_record"
  | "checkpoint_boundary";

export type MissionRecordingArtifactFact = Readonly<{
  id: string;
  attemptId: string;
  kind: string;
  availability: string;
  privacyClassification: string;
  contentType: string;
  sizeBytes: string | null;
  checksumSha256: string | null;
  contextId: string | null;
  captureEpoch: number | null;
  createdAt: string;
}>;

export type MissionRecordingAttemptFact = Readonly<{
  id: string;
  runId: string;
  attemptNumber: number;
  state: string;
  startedAt: string | null;
  completedAt: string | null;
}>;

export type MissionRecordingRunFact = Readonly<{
  id: string;
  objectiveId: string;
  state: string;
  outcomeClassification: string | null;
  resultClassification: string | null;
  createdAt: string;
  completedAt: string | null;
}>;

export type MissionRecordingContinuityFact = Readonly<{
  kind: "successor_checkpoint";
  predecessorRunId: string;
  checkpointId: string;
  restoredByPraxisSessionId: string;
}>;

export type MissionRecordingTimelineFact = Readonly<{
  sequence: number;
  entryType: MissionRecordingEntryType;

  operationId: string | null;
  channel: string | null;

  startedAt: string;
  endedAt: string | null;

  reason: string | null;
  status: string | null;
  privacyStatus: string | null;

  contextId: string | null;
  captureEpoch: number | null;

  checkpointId: string | null;
  checkpointBoundary: string | null;

  artifactId: string | null;
  artifact: MissionRecordingArtifactFact | null;
}>;

export type MissionRecordingMediaDisposition = "playable" | "omitted";

export type MissionRecordingManifestTimelineEntry = Readonly<
  MissionRecordingTimelineFact & {
    /**
     * playable:
     *   safe/sanitized, available and checksummed media bytes exist.
     *
     * omitted:
     *   the runtime explicitly quarantined this media segment and
     *   destroyed its bytes. The historical omission remains factual,
     *   but the manifest grants no playable-byte authority.
     *
     * Non-media timeline facts use null.
     */
    mediaDisposition: MissionRecordingMediaDisposition | null;
  }
>;

export type MissionRecordingSelectedRun = Readonly<{
  /**
   * Explicit caller authority.
   *
   * Chronicle does not infer cross-Run ordering from timestamps.
   * The caller supplies a contiguous 0-based order.
   */
  order: number;

  run: MissionRecordingRunFact;

  /**
   * Canonical Attempt selected by the caller.
   * Chronicle verifies all timeline/artifact facts belong to it.
   */
  canonicalAttempt: MissionRecordingAttemptFact;

  /**
   * Optional factual checkpoint continuity from the immediately
   * preceding selected Run.
   *
   * Absence means Chronicle makes no continuity claim.
   */
  continuityFromPrevious: MissionRecordingContinuityFact | null;

  timeline: readonly MissionRecordingTimelineFact[];
}>;

export type MissionRecordingManifestInput = Readonly<{
  missionId: string;
  sourceMissionRevision: number;

  /**
   * Which Runs comprise the user-facing journey is caller authority.
   * Chronicle validates and freezes; it does not select Runs.
   */
  runs: readonly MissionRecordingSelectedRun[];
}>;

export type MissionRecordingManifest = Readonly<{
  schemaVersion: 1;
  missionId: string;
  sourceMissionRevision: number;

  runs: readonly Readonly<{
    order: number;
    run: MissionRecordingRunFact;
    canonicalAttempt: MissionRecordingAttemptFact;
    continuityFromPrevious: MissionRecordingContinuityFact | null;
    timeline: readonly MissionRecordingManifestTimelineEntry[];
  }>[];

  boundaries: readonly Readonly<
    | {
        order: number;
        kind: "verified_checkpoint";
        predecessorRunId: string;
        successorRunId: string;
        checkpointId: string;
        restoredByPraxisSessionId: string;
      }
    | {
        order: number;
        kind: "recording_gap";
        predecessorRunId: string;
        successorRunId: string;
        startedAt: string | null;
        endedAt: string | null;
        reason: "browser_authority_changed_without_verified_continuity";
      }
  >[];

  recordingDigest: string;
}>;

const artifactBackedEntryKinds = new Set<MissionRecordingEntryType>([
  "video_segment",
  "trace_segment",
]);

const expectedArtifactKind: Partial<Record<MissionRecordingEntryType, string>> = {
  video_segment: "video",
  trace_segment: "trace",
};

/**
 * Compose caller-selected browser recording facts into an immutable
 * deterministic manifest.
 *
 * Chronicle does NOT:
 *
 * - choose which Runs belong to the Mission journey;
 * - infer cross-Run order from timestamps;
 * - infer checkpoint continuity;
 * - concatenate or rewrite media bytes;
 * - decide whether the recorded journey proves the Objective.
 *
 * The canonical ordering hierarchy is:
 *
 *   caller Run order
 *     -> canonical Attempt
 *       -> persisted Attempt-local timeline sequence
 */
export function composeMissionRecording(
  input: MissionRecordingManifestInput,
): MissionRecordingManifest {
  if (!input.missionId) throw new Error("CHRONICLE_RECORDING_MISSION_ID_REQUIRED");

  if (!Number.isInteger(input.sourceMissionRevision) || input.sourceMissionRevision < 0)
    throw new Error("CHRONICLE_RECORDING_MISSION_REVISION_INVALID");

  const runIds = new Set<string>();

  const runs = [...input.runs]
    .sort((left, right) => left.order - right.order || left.run.id.localeCompare(right.run.id))
    .map((selected, index, ordered) => {
      if (!Number.isInteger(selected.order) || selected.order < 0)
        throw new Error("CHRONICLE_RECORDING_RUN_ORDER_INVALID");

      if (selected.order !== index) throw new Error("CHRONICLE_RECORDING_RUN_ORDER_NON_CONTIGUOUS");

      if (runIds.has(selected.run.id)) throw new Error("CHRONICLE_RECORDING_RUN_DUPLICATE");

      runIds.add(selected.run.id);

      if (selected.canonicalAttempt.runId !== selected.run.id)
        throw new Error("CHRONICLE_RECORDING_ATTEMPT_RUN_MISMATCH");

      if (
        !Number.isInteger(selected.canonicalAttempt.attemptNumber) ||
        selected.canonicalAttempt.attemptNumber < 1
      )
        throw new Error("CHRONICLE_RECORDING_ATTEMPT_NUMBER_INVALID");

      const previous = index > 0 ? ordered[index - 1] : null;

      if (index === 0 && selected.continuityFromPrevious)
        throw new Error("CHRONICLE_RECORDING_FIRST_RUN_CONTINUITY_INVALID");

      if (
        selected.continuityFromPrevious &&
        selected.continuityFromPrevious.predecessorRunId !== previous?.run.id
      )
        throw new Error("CHRONICLE_RECORDING_PREDECESSOR_MISMATCH");

      const seenSequences = new Set<number>();

      const timeline = [...selected.timeline]
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => {
          if (!Number.isInteger(entry.sequence) || entry.sequence < 0)
            throw new Error("CHRONICLE_RECORDING_SEQUENCE_INVALID");

          if (seenSequences.has(entry.sequence))
            throw new Error("CHRONICLE_RECORDING_SEQUENCE_DUPLICATE");

          seenSequences.add(entry.sequence);

          return normalizeTimelineEntry(selected.canonicalAttempt, entry);
        });

      return {
        order: selected.order,

        run: {
          ...selected.run,
          createdAt: timestamp(selected.run.createdAt, "run.createdAt"),
          completedAt: nullableTimestamp(selected.run.completedAt, "run.completedAt"),
        },

        canonicalAttempt: {
          ...selected.canonicalAttempt,
          startedAt: nullableTimestamp(
            selected.canonicalAttempt.startedAt,
            "canonicalAttempt.startedAt",
          ),
          completedAt: nullableTimestamp(
            selected.canonicalAttempt.completedAt,
            "canonicalAttempt.completedAt",
          ),
        },

        continuityFromPrevious: selected.continuityFromPrevious
          ? {
              ...selected.continuityFromPrevious,
            }
          : null,

        timeline,
      };
    });

  const factual = {
    schemaVersion: 1 as const,
    missionId: input.missionId,
    sourceMissionRevision: input.sourceMissionRevision,
    runs,
    boundaries: runs.slice(1).map((run, index) => {
      const predecessor = runs[index]!;
      return run.continuityFromPrevious
        ? {
            order: index,
            kind: "verified_checkpoint" as const,
            predecessorRunId: predecessor.run.id,
            successorRunId: run.run.id,
            checkpointId: run.continuityFromPrevious.checkpointId,
            restoredByPraxisSessionId: run.continuityFromPrevious.restoredByPraxisSessionId,
          }
        : {
            order: index,
            kind: "recording_gap" as const,
            predecessorRunId: predecessor.run.id,
            successorRunId: run.run.id,
            startedAt: predecessor.run.completedAt,
            endedAt: run.run.createdAt,
            reason: "browser_authority_changed_without_verified_continuity" as const,
          };
    }),
  };

  const recordingDigest = createHash("sha256").update(canonical(factual)).digest("hex");

  return deepFreeze({
    ...factual,
    recordingDigest,
  });
}

function normalizeTimelineEntry(
  attempt: MissionRecordingAttemptFact,
  entry: MissionRecordingTimelineFact,
): MissionRecordingManifestTimelineEntry {
  const startedAt = timestamp(entry.startedAt, "timeline.startedAt");

  const endedAt = nullableTimestamp(entry.endedAt, "timeline.endedAt");

  if (endedAt && new Date(endedAt).getTime() < new Date(startedAt).getTime())
    throw new Error("CHRONICLE_RECORDING_INTERVAL_INVALID");

  if (
    entry.captureEpoch !== null &&
    (!Number.isInteger(entry.captureEpoch) || entry.captureEpoch < 1)
  )
    throw new Error("CHRONICLE_RECORDING_CAPTURE_EPOCH_INVALID");

  let mediaDisposition: MissionRecordingMediaDisposition | null = null;

  if (artifactBackedEntryKinds.has(entry.entryType)) {
    if (!entry.artifactId || !entry.artifact)
      throw new Error("CHRONICLE_RECORDING_SEGMENT_ARTIFACT_REQUIRED");

    const expected = expectedArtifactKind[entry.entryType];

    if (expected && entry.artifact.kind !== expected)
      throw new Error("CHRONICLE_RECORDING_SEGMENT_KIND_MISMATCH");

    const playable = entry.artifact.availability === "available";

    const explicitlyQuarantinedOmission =
      entry.artifact.availability === "destroyed" &&
      entry.status === "quarantined" &&
      entry.privacyStatus === "quarantined";

    if (playable) {
      if (entry.status === "quarantined" || entry.privacyStatus === "quarantined")
        throw new Error("CHRONICLE_RECORDING_SEGMENT_STATE_INCONSISTENT");

      if (!["safe", "sanitized"].includes(entry.artifact.privacyClassification))
        throw new Error("CHRONICLE_RECORDING_SEGMENT_PRIVACY_UNSAFE");

      if (!entry.artifact.checksumSha256)
        throw new Error("CHRONICLE_RECORDING_SEGMENT_CHECKSUM_REQUIRED");

      mediaDisposition = "playable";
    } else if (explicitlyQuarantinedOmission) {
      mediaDisposition = "omitted";
    } else {
      throw new Error("CHRONICLE_RECORDING_SEGMENT_OMISSION_UNPROVEN");
    }
  }

  if (entry.artifactId === null && entry.artifact !== null)
    throw new Error("CHRONICLE_RECORDING_ARTIFACT_MISMATCH");

  if (entry.artifactId !== null && (!entry.artifact || entry.artifact.id !== entry.artifactId))
    throw new Error("CHRONICLE_RECORDING_ARTIFACT_MISMATCH");

  let artifact: MissionRecordingArtifactFact | null = null;

  if (entry.artifact) {
    if (entry.artifact.attemptId !== attempt.id)
      throw new Error("CHRONICLE_RECORDING_ARTIFACT_ATTEMPT_MISMATCH");

    if (
      entry.contextId !== null &&
      entry.artifact.contextId !== null &&
      entry.contextId !== entry.artifact.contextId
    )
      throw new Error("CHRONICLE_RECORDING_ARTIFACT_CONTEXT_MISMATCH");

    if (
      entry.captureEpoch !== null &&
      entry.artifact.captureEpoch !== null &&
      entry.captureEpoch !== entry.artifact.captureEpoch
    )
      throw new Error("CHRONICLE_RECORDING_ARTIFACT_EPOCH_MISMATCH");

    artifact = {
      ...entry.artifact,
      createdAt: timestamp(entry.artifact.createdAt, "artifact.createdAt"),
    };
  }

  return {
    sequence: entry.sequence,
    entryType: entry.entryType,

    operationId: entry.operationId,
    channel: entry.channel,

    startedAt,
    endedAt,

    reason: entry.reason,
    status: entry.status,
    privacyStatus: entry.privacyStatus,

    contextId: entry.contextId,
    captureEpoch: entry.captureEpoch,

    checkpointId: entry.checkpointId,
    checkpointBoundary: entry.checkpointBoundary,

    artifactId: entry.artifactId,
    artifact,
    mediaDisposition,
  };
}

function timestamp(value: string, field: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) throw new Error(`CHRONICLE_RECORDING_TIME_INVALID:${field}`);

  return date.toISOString();
}

function nullableTimestamp(value: string | null, field: string) {
  return value === null ? null : timestamp(value, field);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;

  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);

    Object.freeze(value);
  }

  return value;
}
