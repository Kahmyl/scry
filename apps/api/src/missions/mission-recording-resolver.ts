import { ConflictException } from "@nestjs/common";
import {
  composeMissionRecording,
  type MissionRecordingEntryType,
  type MissionRecordingManifest,
  type MissionRecordingSelectedRun,
  type MissionRecordingTimelineFact,
} from "@scry/chronicle";
import type { QueryResultRow } from "pg";

export type RecordingQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{
  rowCount: number | null;
  rows: T[];
}>;

export type MissionRecordingSelectionSnapshot = Readonly<{
  id: string;
  revision: number;
  sourceMissionRevision: number;
  selectedByAgentSessionId: string;
  createdAt: string;
  sources: readonly Readonly<{
    order: number;
    runId: string;
    canonicalAttemptId: string;
  }>[];
}>;

export type ResolvedMissionRecording = Readonly<{
  selection: MissionRecordingSelectionSnapshot | null;
  recording: MissionRecordingManifest | null;
}>;

type SelectionRow = QueryResultRow & {
  id: string;
  revision: number;
  sourceMissionRevision: number;
  selectedByAgentSessionId: string;
  createdAt: string;
  sources: unknown;
};

type SelectedRunRow = QueryResultRow & {
  runOrder: number;

  runId: string;
  objectiveId: string;
  runState: string;
  runOutcomeClassification: string | null;
  runResultClassification: string | null;
  runCreatedAt: string;

  canonicalAttemptId: string | null;
  canonicalAttemptRunId: string | null;
  canonicalAttemptNumber: number | null;
  canonicalAttemptState: string | null;
  canonicalAttemptStartedAt: string | null;
  canonicalAttemptCompletedAt: string | null;
};

type TimelineRow = QueryResultRow & {
  attemptId: string;

  sequence: number;
  entryType: string;

  operationId: string | null;
  channel: string | null;

  startedAt: string;
  endedAt: string | null;

  reasonCode: string | null;
  metadata: unknown;

  contextId: string | null;
  captureEpoch: number | null;

  artifactId: string | null;
  artifactAttemptId: string | null;
  artifactKind: string | null;
  artifactAvailability: string | null;
  artifactPrivacyClassification: string | null;
  artifactContentType: string | null;
  artifactSizeBytes: string | null;
  artifactChecksumSha256: string | null;
  artifactContextId: string | null;
  artifactCaptureEpoch: number | null;
  artifactCreatedAt: string | null;
};

type ContinuityRow = QueryResultRow & {
  predecessorRunId: string;
  successorRunId: string;
  checkpointId: string;
  restoredByPraxisSessionId: string;
};

const recordingEntryTypes = new Set<string>([
  "capture_epoch",
  "video_segment",
  "trace_segment",
  "protected_gap",
  "document_transition_gap",
  "unavailable_interval",
  "quarantine_record",
  "checkpoint_boundary",
]);

export async function resolveMissionRecording(
  query: RecordingQuery,
  missionId: string,
): Promise<ResolvedMissionRecording> {
  const activeSelections = await query<SelectionRow>(
    `SELECT
       id::text AS id,
       revision,
       source_mission_revision
         AS "sourceMissionRevision",
       selected_by_agent_session_id::text
         AS "selectedByAgentSessionId",
       created_at::text AS "createdAt",
       COALESCE((
         SELECT activity.safe_metadata->'sources'
         FROM mission_activities activity
         WHERE activity.mission_id=selection.mission_id
           AND activity.type='recording_selection_updated'
           AND activity.safe_metadata->>'selectionId'=selection.id::text
         ORDER BY activity.occurred_at DESC,activity.id DESC
         LIMIT 1
       ),'[]'::jsonb) AS sources
     FROM mission_recording_selections selection
     WHERE selection.mission_id=$1
       AND selection.superseded_at IS NULL
     ORDER BY selection.revision DESC
     LIMIT 2`,
    [missionId],
  );

  if (activeSelections.rows.length > 1) fail("MISSION_RECORDING_SELECTION_AMBIGUOUS");

  const selectedAuthority = activeSelections.rows[0];

  if (!selectedAuthority) {
    const count = await missionRunCount(query, missionId);

    if (count > 0) fail("MISSION_RECORDING_SELECTION_REQUIRED");

    return {
      selection: null,
      recording: null,
    };
  }

  const selection: MissionRecordingSelectionSnapshot = Object.freeze({
    id: selectedAuthority.id,
    revision: Number(selectedAuthority.revision),
    sourceMissionRevision: Number(selectedAuthority.sourceMissionRevision),
    selectedByAgentSessionId: selectedAuthority.selectedByAgentSessionId,
    createdAt: iso(selectedAuthority.createdAt, "selection.createdAt"),
    sources: recordingSources(selectedAuthority.sources),
  });

  const selectedRuns = await query<SelectedRunRow>(
    `SELECT
         selected.run_order
           AS "runOrder",

         run.id::text
           AS "runId",
         run.objective_id::text
           AS "objectiveId",
         run.state
           AS "runState",
         run.outcome_classification
           AS "runOutcomeClassification",
         run.result_classification
           AS "runResultClassification",
         run.created_at::text
           AS "runCreatedAt",

         canonical.id::text
           AS "canonicalAttemptId",
         canonical.run_id::text
           AS "canonicalAttemptRunId",
         canonical.attempt_number
           AS "canonicalAttemptNumber",
         canonical.state
           AS "canonicalAttemptState",
         canonical.started_at::text
           AS "canonicalAttemptStartedAt",
         canonical.completed_at::text
           AS "canonicalAttemptCompletedAt"

       FROM mission_recording_selection_runs
         selected

       JOIN runs run
         ON run.id=selected.run_id
        AND run.mission_id=selected.mission_id
        AND run.objective_id=
              selected.objective_id

       LEFT JOIN LATERAL (
         SELECT
           attempt.id,
           attempt.run_id,
           attempt.attempt_number,
           attempt.state,
           attempt.started_at,
           attempt.completed_at
         FROM attempts attempt
         WHERE attempt.run_id=run.id
         ORDER BY
           attempt.attempt_number DESC,
           attempt.id DESC
         LIMIT 1
       ) canonical
         ON true

       WHERE selected.selection_id=$1
         AND selected.mission_id=$2

       ORDER BY selected.run_order`,
    [selectedAuthority.id, missionId],
  );

  if (!selectedRuns.rows.length) {
    const count = await missionRunCount(query, missionId);

    if (count > 0) fail("MISSION_RECORDING_SELECTION_EMPTY_WITH_RUNS");

    return {
      selection,
      recording: null,
    };
  }

  for (const row of selectedRuns.rows) {
    if (
      !row.canonicalAttemptId ||
      !row.canonicalAttemptRunId ||
      row.canonicalAttemptNumber === null ||
      !row.canonicalAttemptState
    )
      fail("MISSION_RECORDING_CANONICAL_ATTEMPT_UNAVAILABLE");

    if (row.canonicalAttemptRunId !== row.runId)
      fail("MISSION_RECORDING_CANONICAL_ATTEMPT_RUN_MISMATCH");
  }

  if (selection.sources.length) {
    if (selection.sources.length !== selectedRuns.rows.length)
      fail("MISSION_RECORDING_SELECTED_SOURCE_INADMISSIBLE");
    for (const [index, source] of selection.sources.entries()) {
      const selected = selectedRuns.rows[index];
      if (
        source.order !== index ||
        source.runId !== selected?.runId ||
        source.canonicalAttemptId !== selected.canonicalAttemptId
      )
        fail("MISSION_RECORDING_SELECTED_SOURCE_INADMISSIBLE");
    }
  }

  const attemptIds = selectedRuns.rows.map((row) => row.canonicalAttemptId!);

  const timelineRows = await query<TimelineRow>(
    `SELECT
         timeline.attempt_id::text
           AS "attemptId",

         timeline.sequence,
         timeline.entry_type
           AS "entryType",

         timeline.operation_id
           AS "operationId",
         timeline.channel,

         timeline.started_at::text
           AS "startedAt",
         timeline.ended_at::text
           AS "endedAt",

         timeline.reason_code
           AS "reasonCode",
         timeline.metadata,

         timeline.context_id::text
           AS "contextId",
         timeline.capture_epoch
           AS "captureEpoch",

         artifact.id::text
           AS "artifactId",
         artifact.attempt_id::text
           AS "artifactAttemptId",
         artifact.kind
           AS "artifactKind",
         artifact.availability
           AS "artifactAvailability",
         artifact.privacy_classification
           AS "artifactPrivacyClassification",
         artifact.content_type
           AS "artifactContentType",
         artifact.size_bytes::text
           AS "artifactSizeBytes",
         artifact.checksum_sha256
           AS "artifactChecksumSha256",
         artifact.context_id::text
           AS "artifactContextId",
         artifact.capture_epoch
           AS "artifactCaptureEpoch",
         artifact.created_at::text
           AS "artifactCreatedAt"

       FROM artifact_timeline_entries
         timeline

       LEFT JOIN artifacts artifact
         ON artifact.id=timeline.artifact_id

       WHERE timeline.attempt_id=
         ANY($1::uuid[])

       ORDER BY
         timeline.attempt_id,
         timeline.sequence`,
    [attemptIds],
  );

  const timelineByAttempt = new Map<string, MissionRecordingTimelineFact[]>();

  for (const attemptId of attemptIds) timelineByAttempt.set(attemptId, []);

  for (const row of timelineRows.rows) {
    if (!timelineByAttempt.has(row.attemptId))
      fail("MISSION_RECORDING_TIMELINE_ATTEMPT_UNSELECTED");

    if (!recordingEntryTypes.has(row.entryType))
      fail("MISSION_RECORDING_TIMELINE_TYPE_UNSUPPORTED");

    const entryType = row.entryType as MissionRecordingEntryType;

    const metadata = asRecord(row.metadata);

    const artifact = resolveArtifact(row);

    const operationId = entryType === "checkpoint_boundary" ? null : row.operationId;

    const checkpointId =
      text(metadata.checkpointId) ?? (entryType === "checkpoint_boundary" ? row.operationId : null);

    const checkpointBoundary = text(metadata.checkpointBoundary) ?? text(metadata.boundary) ?? null;

    const reason =
      text(metadata.reason) ??
      text(metadata.startReason) ??
      text(metadata.reasonCode) ??
      row.reasonCode;

    const entry: MissionRecordingTimelineFact = {
      // Persisted Attempt-wide sequence is
      // authoritative. Never use
      // metadata.sequence here.
      sequence: Number(row.sequence),

      entryType,

      operationId,
      channel: row.channel,

      startedAt: iso(row.startedAt, "timeline.startedAt"),

      endedAt: row.endedAt === null ? null : iso(row.endedAt, "timeline.endedAt"),

      reason,

      status: text(metadata.status) ?? null,

      privacyStatus: text(metadata.privacyStatus) ?? null,

      contextId: row.contextId,

      captureEpoch: row.captureEpoch === null ? null : Number(row.captureEpoch),

      checkpointId,
      checkpointBoundary,

      artifactId: row.artifactId,

      artifact,
    };

    timelineByAttempt.get(row.attemptId)!.push(entry);
  }

  const continuity = await resolveContinuity(query, missionId, selectedRuns.rows);

  const selectedFacts: MissionRecordingSelectedRun[] = selectedRuns.rows.map((row, index) => {
    const attemptId = row.canonicalAttemptId!;

    return {
      order: Number(row.runOrder),

      run: {
        id: row.runId,
        objectiveId: row.objectiveId,
        state: row.runState,

        outcomeClassification: row.runOutcomeClassification,

        resultClassification: row.runResultClassification,

        createdAt: iso(row.runCreatedAt, "run.createdAt"),

        // Runs do not own a separate
        // completed_at field. The
        // canonical Attempt is the
        // factual terminal-time source.
        completedAt:
          row.canonicalAttemptCompletedAt === null
            ? null
            : iso(row.canonicalAttemptCompletedAt, "run.completedAt"),
      },

      canonicalAttempt: {
        id: attemptId,
        runId: row.runId,

        attemptNumber: Number(row.canonicalAttemptNumber!),

        state: row.canonicalAttemptState!,

        startedAt:
          row.canonicalAttemptStartedAt === null
            ? null
            : iso(row.canonicalAttemptStartedAt, "attempt.startedAt"),

        completedAt:
          row.canonicalAttemptCompletedAt === null
            ? null
            : iso(row.canonicalAttemptCompletedAt, "attempt.completedAt"),
      },

      continuityFromPrevious:
        index === 0
          ? null
          : (continuity.get(pairKey(selectedRuns.rows[index - 1]!.runId, row.runId)) ?? null),

      timeline: timelineByAttempt.get(attemptId) ?? [],
    };
  });

  let recording: MissionRecordingManifest;

  try {
    recording = composeMissionRecording({
      missionId,

      // This is factual provenance of the
      // external-agent selection. It is
      // intentionally NOT an automatic
      // staleness/invalidation policy.
      sourceMissionRevision: selection.sourceMissionRevision,

      runs: selectedFacts,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CHRONICLE_RECORDING_"))
      fail(error.message);

    throw error;
  }

  return {
    selection,
    recording,
  };
}

async function resolveContinuity(
  query: RecordingQuery,
  missionId: string,
  runs: readonly SelectedRunRow[],
) {
  const result = new Map<
    string,
    {
      kind: "successor_checkpoint";
      predecessorRunId: string;
      checkpointId: string;
      restoredByPraxisSessionId: string;
    }
  >();

  if (runs.length < 2) return result;

  const predecessorIds = runs.slice(0, -1).map((row) => row.runId);

  const successorIds = runs.slice(1).map((row) => row.runId);

  const rows = await query<ContinuityRow>(
    `SELECT DISTINCT
         checkpoint.run_id::text
           AS "predecessorRunId",

         binding.run_id::text
           AS "successorRunId",

         checkpoint.id::text
           AS "checkpointId",

         session.id::text
           AS "restoredByPraxisSessionId"

       FROM run_successor_checkpoints
         checkpoint

       JOIN adaptive_sessions session
         ON session.restored_successor_checkpoint_id=
              checkpoint.id

       JOIN run_praxis_sessions binding
         ON binding.praxis_session_id=
              session.id

       JOIN runs successor
         ON successor.id=
              binding.run_id

       WHERE checkpoint.mission_id=$1
         AND checkpoint.state='verified'
         AND checkpoint.restored_at
              IS NOT NULL

         AND checkpoint.run_id=
              ANY($2::uuid[])

         AND binding.run_id=
              ANY($3::uuid[])

         AND successor.mission_id=$1

         AND session.project_id=
              successor.project_id

         AND session.mission_id=
              successor.mission_id

         AND session.objective_id=
              successor.objective_id

         AND session.environment_id=
              successor.environment_id

       ORDER BY
         "predecessorRunId",
         "successorRunId",
         "checkpointId",
         "restoredByPraxisSessionId"`,
    [missionId, predecessorIds, successorIds],
  );

  const adjacent = new Set<string>();

  for (let index = 1; index < runs.length; index += 1)
    adjacent.add(pairKey(runs[index - 1]!.runId, runs[index]!.runId));

  const facts = new Map<string, ContinuityRow[]>();

  for (const row of rows.rows) {
    const key = pairKey(row.predecessorRunId, row.successorRunId);

    // A factual restore relation between two
    // selected Runs is only relevant when
    // those Runs are adjacent in the
    // externally supplied journey order.
    if (!adjacent.has(key)) continue;

    const existing = facts.get(key) ?? [];

    existing.push(row);
    facts.set(key, existing);
  }

  for (const key of adjacent) {
    const matches = facts.get(key) ?? [];

    if (matches.length > 1) fail("MISSION_RECORDING_CONTINUITY_AMBIGUOUS");

    const row = matches[0];

    if (!row) continue;

    const [predecessorRunId] = key.split("|");

    result.set(key, {
      kind: "successor_checkpoint",

      predecessorRunId: predecessorRunId!,

      checkpointId: row.checkpointId,

      restoredByPraxisSessionId: row.restoredByPraxisSessionId,
    });
  }

  return result;
}

function resolveArtifact(row: TimelineRow) {
  if (row.artifactId === null) return null;

  if (
    !row.artifactAttemptId ||
    !row.artifactKind ||
    !row.artifactAvailability ||
    !row.artifactPrivacyClassification ||
    !row.artifactContentType ||
    !row.artifactCreatedAt
  )
    fail("MISSION_RECORDING_ARTIFACT_FACT_INCOMPLETE");

  return {
    id: row.artifactId,

    attemptId: row.artifactAttemptId,

    kind: row.artifactKind,

    availability: row.artifactAvailability,

    privacyClassification: row.artifactPrivacyClassification,

    contentType: row.artifactContentType,

    sizeBytes: row.artifactSizeBytes,

    checksumSha256: row.artifactChecksumSha256,

    contextId: row.artifactContextId,

    captureEpoch: row.artifactCaptureEpoch === null ? null : Number(row.artifactCaptureEpoch),

    createdAt: iso(row.artifactCreatedAt, "artifact.createdAt"),
  };
}

async function missionRunCount(query: RecordingQuery, missionId: string) {
  const result = await query<
    {
      count: number | string;
    } & QueryResultRow
  >(
    `SELECT count(*)::integer
         AS count
       FROM runs
       WHERE mission_id=$1`,
    [missionId],
  );

  return Number(result.rows[0]?.count ?? 0);
}

function pairKey(predecessorRunId: string, successorRunId: string) {
  return `${predecessorRunId}|${successorRunId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordingSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const source = asRecord(item);
    const order = Number(source.order);
    const runId = text(source.runId);
    const canonicalAttemptId = text(source.canonicalAttemptId);
    if (!Number.isInteger(order) || order !== index || !runId || !canonicalAttemptId)
      fail("MISSION_RECORDING_SELECTED_SOURCE_INADMISSIBLE");
    return { order, runId, canonicalAttemptId };
  });
}

function iso(value: string, field: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) fail(`MISSION_RECORDING_TIME_INVALID:${field}`);

  return date.toISOString();
}

function fail(code: string): never {
  throw new ConflictException({
    code,
  });
}
