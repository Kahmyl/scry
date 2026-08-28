import type { QueryResultRow } from "pg";
import { loadConflictScope } from "../recovery/conflict-scope.repository.js";

export type MissionSelectionStatus =
  "planning" | "running" | "blocked" | "awaiting_user" | "completed" | "failed" | "cancelled";

export type MissionSelectionPurpose = "primary" | "diagnostic" | "recovery";

export type MissionSelectionFact = Readonly<{
  id: string;
  title: string;
  status: MissionSelectionStatus;
  purpose: MissionSelectionPurpose;
  latestExternalRunId: string | null;
  latestAgentSessionStatus: string | null;
  knownExternalRunIds: readonly string[];
  activeExternalRunIds: readonly string[];
  activeExecutionOwnership: boolean;
  unresolvedMutationRisk: boolean;
  outstandingReconciliation: boolean;
}>;

export type MissionCandidateClassification =
  | "same_run_continuation"
  | "same_run_settled"
  | "active_other_run"
  | "mutation_reconciliation_required"
  | "settled_history";

export type MissionSelectionDecision = Readonly<{
  decision:
    | "fresh_primary_permitted"
    | "continuation_available"
    | "explicit_mission_selected"
    | "selection_required";
  freshPrimaryMissionPermitted: boolean;
  continuationAvailable: boolean;
  userAuthorityRequired: boolean;
  blockerCode?:
    | "MISSION_SELECTION_REQUIRED"
    | "MISSION_MUTATION_RECONCILIATION_REQUIRED"
    | "MISSION_DISTINCT_WORK_AUTHORITY_REQUIRED"
    | "EXTERNAL_AGENT_RUN_ALREADY_SETTLED";
  safeActions: readonly string[];
  candidates: readonly (MissionSelectionFact & {
    classification: MissionCandidateClassification;
    continuationAvailable: boolean;
  })[];
}>;

export type MissionSelectionInput = Readonly<{
  currentExternalRunId?: string;
  intendedPurpose: MissionSelectionPurpose;
  selectedMissionId?: string;
  distinctAuthorityConfirmed?: boolean;
  candidates: readonly MissionSelectionFact[];
}>;

/**
 * Canonical admission policy for Mission identity. It consumes only durable
 * lifecycle and mutation facts; it never chooses a semantic target or mutates
 * a Mission.
 */
export function decideMissionSelection(input: MissionSelectionInput): MissionSelectionDecision {
  const candidates = input.candidates.map((candidate) => {
    const classification = classifyCandidate(candidate, input.currentExternalRunId);
    return {
      ...candidate,
      classification,
      continuationAvailable: classification === "same_run_continuation",
    };
  });

  if (input.selectedMissionId) {
    return {
      decision: "explicit_mission_selected",
      freshPrimaryMissionPermitted: false,
      continuationAvailable: candidates.some(
        ({ id, continuationAvailable }) => id === input.selectedMissionId && continuationAvailable,
      ),
      userAuthorityRequired: false,
      safeActions: ["inspect_selected_mission"],
      candidates,
    };
  }

  if (input.intendedPurpose !== "primary" && !input.distinctAuthorityConfirmed) {
    return blocked(candidates, "MISSION_DISTINCT_WORK_AUTHORITY_REQUIRED", [
      "list_missions",
      "request_distinct_mission_authority",
    ]);
  }

  if (input.intendedPurpose !== "primary") {
    return {
      decision: "fresh_primary_permitted",
      freshPrimaryMissionPermitted: false,
      continuationAvailable: false,
      userAuthorityRequired: false,
      safeActions: ["start_mission"],
      candidates,
    };
  }

  if (
    candidates.some(({ classification }) => classification === "mutation_reconciliation_required")
  )
    return blocked(candidates, "MISSION_MUTATION_RECONCILIATION_REQUIRED", [
      "list_missions",
      "inspect_reconciliation",
    ]);

  const sameRunContinuations = candidates.filter(
    ({ classification }) => classification === "same_run_continuation",
  );
  const activeOther = candidates.filter(
    ({ classification }) => classification === "active_other_run",
  );

  if (sameRunContinuations.length === 1 && activeOther.length === 0) {
    return {
      decision: "continuation_available",
      freshPrimaryMissionPermitted: false,
      continuationAvailable: true,
      userAuthorityRequired: false,
      safeActions: ["inspect_same_run_mission", "resume_same_run"],
      candidates,
    };
  }

  if (sameRunContinuations.length > 0 || activeOther.length > 0)
    return blocked(candidates, "MISSION_SELECTION_REQUIRED", ["list_missions"]);

  if (candidates.some(({ classification }) => classification === "same_run_settled"))
    return blocked(candidates, "EXTERNAL_AGENT_RUN_ALREADY_SETTLED", [
      "use_fresh_external_run_identity",
      "list_missions",
    ]);

  if (candidates.length > 0 && !input.currentExternalRunId)
    return blocked(candidates, "MISSION_SELECTION_REQUIRED", ["list_missions"]);
  return {
    decision: "fresh_primary_permitted",
    freshPrimaryMissionPermitted: true,
    continuationAvailable: false,
    userAuthorityRequired: false,
    safeActions: ["start_mission"],
    candidates,
  };
}

function classifyCandidate(
  candidate: MissionSelectionFact,
  currentExternalRunId?: string,
): MissionCandidateClassification {
  if (candidate.unresolvedMutationRisk || candidate.outstandingReconciliation)
    return "mutation_reconciliation_required";

  const sameRunActive = Boolean(
    currentExternalRunId && candidate.activeExternalRunIds.includes(currentExternalRunId),
  );
  if (candidate.activeExecutionOwnership || isLifecycleActive(candidate.status))
    return sameRunActive ? "same_run_continuation" : "active_other_run";

  if (currentExternalRunId && candidate.latestExternalRunId === currentExternalRunId)
    return "same_run_settled";

  if (currentExternalRunId && candidate.knownExternalRunIds.includes(currentExternalRunId))
    return "same_run_settled";

  return "settled_history";
}

function isLifecycleActive(status: MissionSelectionStatus) {
  return status === "planning" || status === "running" || status === "awaiting_user";
}

function blocked(
  candidates: MissionSelectionDecision["candidates"],
  blockerCode: NonNullable<MissionSelectionDecision["blockerCode"]>,
  safeActions: readonly string[],
): MissionSelectionDecision {
  return {
    decision: "selection_required",
    freshPrimaryMissionPermitted: false,
    continuationAvailable: candidates.some(({ continuationAvailable }) => continuationAvailable),
    userAuthorityRequired: true,
    blockerCode,
    safeActions,
    candidates,
  };
}

export type MissionSelectionQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

export type LoadMissionSelectionFactsInput = Readonly<{
  projectId: string;
  missionId?: string;
  title?: string;
  originalInstruction?: string;
  limit?: number;
}>;

/** One factual loader shared by public context and every Mission creation path. */
export async function loadMissionSelectionFacts(
  query: MissionSelectionQuery,
  input: LoadMissionSelectionFactsInput,
): Promise<MissionSelectionFact[]> {
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);
  const [result, conflictScope] = await Promise.all([
    query<{
      id: string;
      title: string;
      status: MissionSelectionStatus;
      purpose: MissionSelectionPurpose;
      latestExternalRunId: string | null;
      latestAgentSessionStatus: string | null;
      knownExternalRunIds: string[] | null;
      activeExternalRunIds: string[] | null;
    }>(
      `SELECT mission.id::text,mission.title,mission.status,mission.purpose,
            latest.external_run_id::text AS "latestExternalRunId",
            latest.status AS "latestAgentSessionStatus",
            COALESCE((
              SELECT array_agg(DISTINCT known.external_run_id::text)
                FROM agent_sessions known
               WHERE known.mission_id=mission.id
                 AND known.external_run_id IS NOT NULL
            ),ARRAY[]::text[]) AS "knownExternalRunIds",
            COALESCE((
              SELECT array_agg(DISTINCT active.external_run_id::text)
                FROM agent_sessions active
               WHERE active.mission_id=mission.id AND active.status='active'
                 AND active.external_run_id IS NOT NULL
            ),ARRAY[]::text[]) AS "activeExternalRunIds",
            mission.updated_at
       FROM missions mission
       LEFT JOIN LATERAL (
         SELECT session.external_run_id,session.status
           FROM agent_sessions session
          WHERE session.mission_id=mission.id
          ORDER BY session.started_at DESC,session.id DESC LIMIT 1
       ) latest ON true
      WHERE mission.project_id=$1
        AND ($2::uuid IS NULL OR mission.id=$2)
        AND ($3::text IS NULL OR lower(mission.title)=lower($3)
          OR lower(mission.original_instruction)=lower($4))
      ORDER BY mission.updated_at DESC,mission.id DESC LIMIT $5`,
      [
        input.projectId,
        input.missionId ?? null,
        input.title ?? null,
        input.originalInstruction ?? null,
        limit,
      ],
    ),
    loadConflictScope(query, {
      projectId: input.projectId,
      ...(input.missionId ? { missionId: input.missionId } : {}),
    }),
  ]);
  return result.rows.map((row) => ({
    ...row,
    knownExternalRunIds: row.knownExternalRunIds ?? [],
    activeExternalRunIds: row.activeExternalRunIds ?? [],
    activeExecutionOwnership: conflictScope.some(
      ({ missionId, kind, blocking }) =>
        missionId === row.id &&
        blocking &&
        ["external_agent_owner", "run_owner", "praxis_runtime_owner"].includes(kind),
    ),
    unresolvedMutationRisk: conflictScope.some(
      ({ missionId, kind, blocking }) =>
        missionId === row.id &&
        blocking &&
        ["adaptive_unknown", "protected_mutation"].includes(kind),
    ),
    outstandingReconciliation: conflictScope.some(
      ({ missionId, kind, blocking }) =>
        missionId === row.id &&
        blocking &&
        ["reconciliation_owner", "praxis_recovery"].includes(kind),
    ),
  }));
}
