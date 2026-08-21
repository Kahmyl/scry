import { createHash } from "node:crypto";

export type MissionEvidenceRunFact = Readonly<{
  id: string;
  state: string;
  outcomeClassification: string | null;
  resultClassification: string | null;
  reliabilityEligible: boolean;
  flowRevisionId: string;
  environmentId: string;
  executionModel: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type MissionEvidenceAttemptFact = Readonly<{
  id: string;
  runId: string;
  attemptNumber: number;
  state: string;
  startedAt: string | null;
  completedAt: string | null;
}>;

export type MissionEvidenceArtifactFact = Readonly<{
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
  retentionUntil: string | null;
  createdAt: string;
}>;

export type MissionAcceptedEvidenceFact = Readonly<{
  id: string;
  objectiveId: string;
  runId: string;
  artifactId: string | null;
  acceptanceConclusion: string;
  acceptedByAgentSessionId: string;
  acceptedAt: string;
  run: MissionEvidenceRunFact;
  canonicalAttempt: MissionEvidenceAttemptFact;
  artifact: MissionEvidenceArtifactFact | null;
}>;

export type MissionEvidenceCompositionInput = Readonly<{
  missionId: string;
  sourceMissionRevision: number;
  objectives: readonly Readonly<{
    objectiveId: string;
    order: number;
  }>[];
  acceptedEvidence: readonly MissionAcceptedEvidenceFact[];
  supersededAttemptCount: number;
}>;

export type MissionEvidenceComposition = Readonly<{
  schemaVersion: 1;
  missionId: string;
  sourceMissionRevision: number;
  objectives: readonly Readonly<{
    objectiveId: string;
    order: number;
    acceptedRunIds: readonly string[];
    acceptedArtifactIds: readonly string[];
    acceptedEvidence: readonly MissionAcceptedEvidenceFact[];
  }>[];
  supersededAttemptCount: number;
  evidenceDigest: string;
}>;

/**
 * Compose already-admitted Mission evidence into deterministic factual
 * provenance.
 *
 * This function does not decide whether a Run or Artifact SHOULD be accepted.
 * Admission authority remains with the caller. Chronicle only verifies
 * referential consistency, orders facts deterministically and produces an
 * integrity digest.
 */
export function composeMissionEvidence(
  input: MissionEvidenceCompositionInput,
): MissionEvidenceComposition {
  if (!input.missionId) throw new Error("CHRONICLE_MISSION_ID_REQUIRED");

  if (!Number.isInteger(input.sourceMissionRevision) || input.sourceMissionRevision < 0)
    throw new Error("CHRONICLE_MISSION_REVISION_INVALID");

  if (!Number.isInteger(input.supersededAttemptCount) || input.supersededAttemptCount < 0)
    throw new Error("CHRONICLE_SUPERSEDED_ATTEMPT_COUNT_INVALID");

  const objectiveOrder = new Map<string, number>();

  for (const objective of input.objectives) {
    if (objectiveOrder.has(objective.objectiveId)) throw new Error("CHRONICLE_OBJECTIVE_DUPLICATE");

    if (!Number.isInteger(objective.order) || objective.order < 0)
      throw new Error("CHRONICLE_OBJECTIVE_ORDER_INVALID");

    objectiveOrder.set(objective.objectiveId, objective.order);
  }

  const grouped = new Map<string, MissionAcceptedEvidenceFact[]>();

  const acceptanceIds = new Set<string>();

  for (const raw of input.acceptedEvidence) {
    if (!objectiveOrder.has(raw.objectiveId))
      throw new Error("CHRONICLE_EVIDENCE_OBJECTIVE_UNKNOWN");

    if (acceptanceIds.has(raw.id)) throw new Error("CHRONICLE_ACCEPTANCE_DUPLICATE");

    acceptanceIds.add(raw.id);

    const fact = normalizeAcceptedEvidence(raw);

    const entries = grouped.get(fact.objectiveId) ?? [];

    entries.push(fact);
    grouped.set(fact.objectiveId, entries);
  }

  const objectives = [...input.objectives]
    .sort(
      (left, right) =>
        left.order - right.order || left.objectiveId.localeCompare(right.objectiveId),
    )
    .map((objective) => {
      const acceptedEvidence = [...(grouped.get(objective.objectiveId) ?? [])].sort(
        compareAcceptedEvidence,
      );

      const acceptedRunIds = [...new Set(acceptedEvidence.map((entry) => entry.runId))].sort();

      const acceptedArtifactIds = [
        ...new Set(
          acceptedEvidence.flatMap((entry) => (entry.artifactId ? [entry.artifactId] : [])),
        ),
      ].sort();

      return {
        objectiveId: objective.objectiveId,
        order: objective.order,
        acceptedRunIds,
        acceptedArtifactIds,
        acceptedEvidence,
      };
    });

  const factual = {
    schemaVersion: 1 as const,
    missionId: input.missionId,
    sourceMissionRevision: input.sourceMissionRevision,
    objectives,
    supersededAttemptCount: input.supersededAttemptCount,
  };

  const evidenceDigest = createHash("sha256").update(canonical(factual)).digest("hex");

  return deepFreeze({
    ...factual,
    evidenceDigest,
  });
}

function normalizeAcceptedEvidence(fact: MissionAcceptedEvidenceFact): MissionAcceptedEvidenceFact {
  if (fact.run.id !== fact.runId) throw new Error("CHRONICLE_EVIDENCE_RUN_MISMATCH");

  if (fact.canonicalAttempt.runId !== fact.runId)
    throw new Error("CHRONICLE_EVIDENCE_ATTEMPT_RUN_MISMATCH");

  if (
    !Number.isInteger(fact.canonicalAttempt.attemptNumber) ||
    fact.canonicalAttempt.attemptNumber < 1
  )
    throw new Error("CHRONICLE_ATTEMPT_NUMBER_INVALID");

  if (fact.artifactId === null) {
    if (fact.artifact !== null) throw new Error("CHRONICLE_EVIDENCE_ARTIFACT_MISMATCH");
  } else {
    if (!fact.artifact || fact.artifact.id !== fact.artifactId)
      throw new Error("CHRONICLE_EVIDENCE_ARTIFACT_MISMATCH");

    if (fact.artifact.attemptId !== fact.canonicalAttempt.id)
      throw new Error("CHRONICLE_EVIDENCE_ARTIFACT_ATTEMPT_MISMATCH");
  }

  return {
    id: fact.id,
    objectiveId: fact.objectiveId,
    runId: fact.runId,
    artifactId: fact.artifactId,
    acceptanceConclusion: fact.acceptanceConclusion,
    acceptedByAgentSessionId: fact.acceptedByAgentSessionId,
    acceptedAt: timestamp(fact.acceptedAt, "acceptedAt"),
    run: {
      ...fact.run,
      createdAt: timestamp(fact.run.createdAt, "run.createdAt"),
      updatedAt: timestamp(fact.run.updatedAt, "run.updatedAt"),
    },
    canonicalAttempt: {
      ...fact.canonicalAttempt,
      startedAt: nullableTimestamp(fact.canonicalAttempt.startedAt, "canonicalAttempt.startedAt"),
      completedAt: nullableTimestamp(
        fact.canonicalAttempt.completedAt,
        "canonicalAttempt.completedAt",
      ),
    },
    artifact: fact.artifact
      ? {
          ...fact.artifact,
          retentionUntil: nullableTimestamp(
            fact.artifact.retentionUntil,
            "artifact.retentionUntil",
          ),
          createdAt: timestamp(fact.artifact.createdAt, "artifact.createdAt"),
        }
      : null,
  };
}

function compareAcceptedEvidence(
  left: MissionAcceptedEvidenceFact,
  right: MissionAcceptedEvidenceFact,
) {
  return (
    left.acceptedAt.localeCompare(right.acceptedAt) ||
    left.runId.localeCompare(right.runId) ||
    (left.artifactId ?? "").localeCompare(right.artifactId ?? "") ||
    left.id.localeCompare(right.id)
  );
}

function timestamp(value: string, field: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime()))
    throw new Error(`CHRONICLE_MISSION_EVIDENCE_TIME_INVALID:${field}`);

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
