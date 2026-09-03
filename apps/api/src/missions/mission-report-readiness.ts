import type { ArtifactStore } from "@scry/chronicle/legacy";
import type { MissionReadinessBlocker } from "@scry/contracts";
import { ConflictException } from "@nestjs/common";
import type { QueryResultRow } from "pg";

import { resolveMissionRecording } from "./mission-recording-resolver.js";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

export async function loadMissionReportCompositionReadiness(input: {
  query: Query;
  missionId: string;
  missionRevision: number;
  artifactStore?: ArtifactStore;
  add: (blocker: MissionReadinessBlocker) => void;
}) {
  const { query, missionId, missionRevision, artifactStore, add } = input;
  let resolved: Awaited<ReturnType<typeof resolveMissionRecording>> | null = null;

  try {
    resolved = await resolveMissionRecording(query, missionId);
  } catch (error) {
    const code = conflictCode(error);
    if (!code) throw error;
    add({
      code,
      missionId,
      state: "inadmissible",
      resolution: "evidence_selection_required",
      safeActions: ["get_mission", "set_mission_recording_selection"],
      nextActions: ["set_mission_recording_selection"],
    });
  }

  if (resolved?.selection && resolved.selection.sourceMissionRevision + 1 !== missionRevision)
    add({
      code: "MISSION_RECORDING_SELECTION_STALE",
      missionId,
      recordingId: resolved.selection.id,
      state: "stale",
      reason: `Selection source revision ${resolved.selection.sourceMissionRevision}; current Mission revision ${missionRevision}.`,
      resolution: "evidence_selection_required",
      safeActions: ["get_mission", "set_mission_recording_selection"],
      nextActions: ["set_mission_recording_selection"],
    });

  const recordingArtifacts = new Map<
    string,
    { runId: string; kind: string; availability: string }
  >();
  for (const selected of resolved?.recording?.runs ?? []) {
    if (
      !selected.canonicalAttempt.completedAt ||
      !["passed", "failed", "cancelled", "timed_out", "infrastructure_error"].includes(
        selected.canonicalAttempt.state,
      )
    )
      add({
        code: "MISSION_RECORDING_SELECTED_SOURCE_INADMISSIBLE",
        missionId,
        objectiveId: selected.run.objectiveId,
        runId: selected.run.id,
        attemptId: selected.canonicalAttempt.id,
        state: selected.canonicalAttempt.state,
        resolution: "evidence_selection_required",
        safeActions: ["get_run", "set_mission_recording_selection"],
        nextActions: ["get_run", "set_mission_recording_selection"],
      });

    for (const entry of selected.timeline) {
      if (entry.entryType === "unavailable_interval")
        add({
          code: "MISSION_RECORDING_GAP",
          missionId,
          objectiveId: selected.run.objectiveId,
          runId: selected.run.id,
          attemptId: selected.canonicalAttempt.id,
          state: "unavailable_interval",
          ...(entry.reason ? { reasonCode: boundedReasonCode(entry.reason) } : {}),
          resolution: "evidence_selection_required",
          safeActions: ["get_run", "set_mission_recording_selection"],
          nextActions: ["get_run", "set_mission_recording_selection"],
        });
      if (entry.artifact)
        recordingArtifacts.set(entry.artifact.id, {
          runId: selected.run.id,
          kind: entry.artifact.kind,
          availability: entry.artifact.availability,
        });
    }
  }
  for (const boundary of resolved?.recording?.boundaries ?? [])
    if (boundary.kind === "recording_gap")
      add({
        code: "MISSION_RECORDING_GAP",
        missionId,
        runId: boundary.successorRunId,
        state: "cross_run_gap",
        reasonCode: "BROWSER_AUTHORITY_CHANGED_WITHOUT_VERIFIED_CONTINUITY",
        resolution: "evidence_selection_required",
        safeActions: ["get_run", "set_mission_recording_selection"],
        nextActions: ["set_mission_recording_selection"],
      });

  const evidence = await query<{
    evidenceId: string;
    objectiveId: string;
    runId: string;
    planSnapshot: unknown;
    artifactId: string | null;
    artifactKind: string | null;
    artifactAvailability: string | null;
    artifactPrivacyClassification: string | null;
    destructionStatus: string | null;
    storageKey: string | null;
  }>(
    `SELECT e.id::text AS "evidenceId",e.objective_id::text AS "objectiveId",
            e.run_id::text AS "runId",r.plan_snapshot AS "planSnapshot",
            a.id::text AS "artifactId",a.kind AS "artifactKind",
            a.availability AS "artifactAvailability",
            a.privacy_classification AS "artifactPrivacyClassification",
            a.destruction_status AS "destructionStatus",a.storage_key AS "storageKey"
     FROM accepted_evidence e
     JOIN runs r ON r.id=e.run_id AND r.mission_id=e.mission_id
     LEFT JOIN artifacts a ON a.id=e.artifact_id
     WHERE e.mission_id=$1 AND e.superseded_at IS NULL AND e.invalidated_at IS NULL
     ORDER BY e.objective_id,e.accepted_at,e.id`,
    [missionId],
  );

  const selectedKindsByRun = new Map<string, Set<string>>();
  const requiredKindsByRun = new Map<string, Set<string>>();
  const objectiveByRun = new Map<string, string>();
  const materialized = new Map<
    string,
    { objectiveId?: string; runId: string; kind: string; storageKey: string | null }
  >();

  for (const row of evidence.rows) {
    objectiveByRun.set(row.runId, row.objectiveId);
    requiredKindsByRun.set(row.runId, requiredEvidenceClasses(row.planSnapshot));
    const selected = selectedKindsByRun.get(row.runId) ?? new Set<string>();
    if (row.artifactId && row.artifactKind) selected.add(row.artifactKind);
    selectedKindsByRun.set(row.runId, selected);

    if (row.artifactId) {
      const available = row.artifactAvailability === "available";
      const admissible =
        ["safe", "sanitized"].includes(row.artifactPrivacyClassification ?? "") &&
        row.destructionStatus === "pending";
      if (!available)
        add({
          code: "REPORT_SELECTED_ARTIFACT_UNAVAILABLE",
          missionId,
          objectiveId: row.objectiveId,
          runId: row.runId,
          evidenceId: row.evidenceId,
          artifactId: row.artifactId,
          evidenceClass: row.artifactKind ?? undefined,
          state: row.artifactAvailability ?? "missing",
          resolution: "evidence_selection_required",
          safeActions: ["get_run", "accept_objective_evidence"],
          nextActions: ["get_run", "accept_objective_evidence"],
        });
      else if (!admissible)
        add({
          code: "REPORT_SELECTED_ARTIFACT_INADMISSIBLE",
          missionId,
          objectiveId: row.objectiveId,
          runId: row.runId,
          evidenceId: row.evidenceId,
          artifactId: row.artifactId,
          evidenceClass: row.artifactKind ?? undefined,
          state: row.destructionStatus ?? row.artifactPrivacyClassification ?? "inadmissible",
          resolution: "evidence_selection_required",
          safeActions: ["get_run", "accept_objective_evidence"],
          nextActions: ["get_run", "accept_objective_evidence"],
        });
      if (available && admissible)
        materialized.set(row.artifactId, {
          objectiveId: row.objectiveId,
          runId: row.runId,
          kind: row.artifactKind ?? "unknown",
          storageKey: row.storageKey,
        });
    }
  }

  for (const [artifactId, artifact] of recordingArtifacts) {
    const selected = selectedKindsByRun.get(artifact.runId) ?? new Set<string>();
    if (artifact.availability === "available") selected.add(artifact.kind);
    selectedKindsByRun.set(artifact.runId, selected);
    if (artifact.availability === "available" && !materialized.has(artifactId))
      materialized.set(artifactId, {
        ...(objectiveByRun.get(artifact.runId)
          ? { objectiveId: objectiveByRun.get(artifact.runId)! }
          : {}),
        runId: artifact.runId,
        kind: artifact.kind,
        storageKey: null,
      });
  }

  for (const [runId, requiredKinds] of requiredKindsByRun)
    for (const evidenceClass of requiredKinds)
      if (!selectedKindsByRun.get(runId)?.has(evidenceClass))
        add({
          code: "REPORT_REQUIRED_EVIDENCE_CLASS_MISSING",
          missionId,
          objectiveId: objectiveByRun.get(runId),
          runId,
          evidenceClass,
          state: "missing",
          resolution: "evidence_selection_required",
          safeActions: ["get_run", "accept_objective_evidence"],
          nextActions: ["get_run", "accept_objective_evidence"],
        });

  if (!artifactStore || !materialized.size) return;

  const storageRows = await query<{ artifactId: string; storageKey: string | null }>(
    `SELECT id::text AS "artifactId",storage_key AS "storageKey"
     FROM artifacts WHERE id=ANY($1::uuid[])`,
    [[...materialized.keys()]],
  );
  const storageById = new Map(storageRows.rows.map((row) => [row.artifactId, row.storageKey]));
  for (const [artifactId, fact] of materialized) {
    const storageKey = storageById.get(artifactId) ?? fact.storageKey;
    let exists = false;
    try {
      exists = Boolean(storageKey) && (await artifactStore.exists(storageKey!));
    } catch {
      exists = false;
    }
    if (!exists)
      add({
        code: "REPORT_ARTIFACT_STORE_FAILURE",
        missionId,
        ...(fact.objectiveId ? { objectiveId: fact.objectiveId } : {}),
        runId: fact.runId,
        artifactId,
        evidenceClass: fact.kind,
        state: storageKey ? "store_unavailable" : "storage_key_missing",
        resolution: "fresh_observation_required",
        safeActions: ["get_run"],
        nextActions: ["get_run"],
      });
  }
}

function conflictCode(error: unknown): string | null {
  if (!(error instanceof ConflictException)) return null;
  const response = error.getResponse();
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const code = (response as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function requiredEvidenceClasses(planSnapshot: unknown) {
  const required = new Set<string>();
  const plan = asRecord(planSnapshot);
  for (const step of records(plan.steps, 10_000))
    for (const evidence of Array.isArray(step.evidence) ? step.evidence : []) {
      const kind =
        typeof evidence === "string"
          ? evidence
          : typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
            ? (evidence as { kind?: unknown }).kind
            : null;
      if (typeof kind === "string" && kind.trim()) required.add(kind.trim());
    }
  return required;
}

function boundedReasonCode(value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200);
  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? normalized : "RECORDING_GAP";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown, maximum: number) {
  return Array.isArray(value) ? value.slice(0, maximum).map(asRecord) : [];
}
