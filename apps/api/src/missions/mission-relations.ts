import type { MissionRelationDisclosure, MissionRelationFact } from "@scry/contracts";
import type { QueryResultRow } from "pg";

export type MissionRelationQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

export async function insertMissionRelation(
  query: MissionRelationQuery,
  input: Omit<MissionRelationFact, "id" | "createdAt"> & { id: string },
): Promise<MissionRelationFact> {
  const result = await query<{ createdAt: string }>(
    `INSERT INTO mission_relations(
       id,project_id,source_mission_id,target_mission_id,relation,
       created_by_agent_session_id,reason
     ) VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING created_at::text AS "createdAt"`,
    [
      input.id,
      input.projectId,
      input.sourceMissionId,
      input.targetMissionId,
      input.relation,
      input.createdByAgentSessionId,
      input.reason,
    ],
  );
  return {
    ...input,
    createdAt: iso(result.rows[0]!.createdAt),
  };
}

export async function loadMissionRelationDisclosures(
  query: MissionRelationQuery,
  missionId: string,
): Promise<MissionRelationDisclosure[]> {
  const relations = await query<{
    relationId: string;
    relation: MissionRelationDisclosure["relation"];
    direction: MissionRelationDisclosure["direction"];
    reason: string;
    createdAt: string;
    relatedMissionId: string;
    relatedMissionPurpose: MissionRelationDisclosure["relatedMission"]["purpose"];
    relatedMissionStatus: MissionRelationDisclosure["relatedMission"]["status"];
  }>(
    `SELECT relation.id::text AS "relationId",relation.relation,
            CASE WHEN relation.target_mission_id=$1::uuid THEN 'incoming' ELSE 'outgoing' END
              AS direction,
            relation.reason,relation.created_at::text AS "createdAt",
            related.id::text AS "relatedMissionId",related.purpose AS "relatedMissionPurpose",
            related.status AS "relatedMissionStatus"
     FROM mission_relations relation
     JOIN missions related ON related.id=CASE
       WHEN relation.target_mission_id=$1::uuid THEN relation.source_mission_id
       ELSE relation.target_mission_id
     END
     WHERE relation.source_mission_id=$1 OR relation.target_mission_id=$1
     ORDER BY relation.created_at,relation.id`,
    [missionId],
  );
  if (!relations.rows.length) return [];

  const relatedMissionIds = [...new Set(relations.rows.map((row) => row.relatedMissionId))];
  const unresolved = await query<{
    protectedOperationId: string;
    missionId: string;
    operationId: string;
    objectiveId: string;
    state: string;
    mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
    recoveryClass: string | null;
    failureCode: string | null;
    updatedAt: string;
  }>(
    `SELECT id::text AS "protectedOperationId",mission_id::text AS "missionId",
            operation_id AS "operationId",objective_id::text AS "objectiveId",state,
            mutation_outcome AS "mutationOutcome",recovery_class AS "recoveryClass",
            failure_code AS "failureCode",updated_at::text AS "updatedAt"
     FROM protected_operations
     WHERE mission_id=ANY($1::uuid[])
       AND (mutation_outcome='unknown' OR state='recovery_required')
     ORDER BY mission_id,created_at,id`,
    [relatedMissionIds],
  );
  const unresolvedByMission = new Map<
    string,
    MissionRelationDisclosure["unresolvedProtectedOperations"]
  >();
  for (const row of unresolved.rows) {
    const current = unresolvedByMission.get(row.missionId) ?? [];
    unresolvedByMission.set(row.missionId, [
      ...current,
      {
        protectedOperationId: row.protectedOperationId,
        operationId: row.operationId,
        objectiveId: row.objectiveId,
        state: row.state,
        mutationOutcome: row.mutationOutcome,
        recoveryClass: row.recoveryClass,
        failureCode: row.failureCode,
        updatedAt: iso(row.updatedAt),
      },
    ]);
  }

  return relations.rows.map((row) => ({
    relationId: row.relationId,
    relation: row.relation,
    direction: row.direction,
    reason: row.reason,
    createdAt: iso(row.createdAt),
    relatedMission: {
      id: row.relatedMissionId,
      purpose: row.relatedMissionPurpose,
      status: row.relatedMissionStatus,
    },
    unresolvedProtectedOperations: unresolvedByMission.get(row.relatedMissionId) ?? [],
  }));
}

function iso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("MISSION_RELATION_TIMESTAMP_INVALID");
  return date.toISOString();
}
