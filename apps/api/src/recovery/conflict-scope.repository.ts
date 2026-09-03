import type { QueryResultRow } from "pg";

export type ConflictScopeBlockerKind =
  | "adaptive_unknown"
  | "protected_mutation"
  | "reconciliation_owner"
  | "praxis_runtime_owner"
  | "praxis_recovery"
  | "external_agent_owner"
  | "run_owner"
  | "resource_binding";

export type ConflictScopeBlocker = Readonly<{
  kind: ConflictScopeBlockerKind;
  projectId: string;
  missionId: string | null;
  environmentId: string | null;
  resourceDomain: string | null;
  credentialDomain: string | null;
  operationId: string | null;
  protectedOperationId: string | null;
  recoveryId: string | null;
  authority: "adaptive" | "protected" | "reconciliation" | "lifecycle" | "external_binding";
  blocking: boolean;
  lifecycle: "live" | "recovery_required" | "expired";
}>;

export type ConflictScopeQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

/** Canonical read-only conflict authority. Expired owners remain visible but are non-blocking. */
export async function loadConflictScope(
  query: ConflictScopeQuery,
  input: {
    projectId: string;
    missionId?: string;
    environmentId?: string;
    resourceDomain?: string;
    credentialDomain?: string;
  },
): Promise<ConflictScopeBlocker[]> {
  const result = await query<ConflictScopeBlocker>(
    `WITH scoped_missions AS (
       SELECT id,project_id FROM missions
       WHERE project_id=$1 AND ($2::uuid IS NULL OR id=$2)
     ), blockers AS (
       SELECT 'adaptive_unknown'::text AS kind,session.project_id,session.mission_id,
              session.environment_id,NULL::text AS resource_domain,NULL::text AS credential_domain,
              operation.operation_id,NULL::uuid AS protected_operation_id,NULL::uuid AS recovery_id,
              'adaptive'::text AS authority,true AS blocking,'recovery_required'::text AS lifecycle
       FROM adaptive_operations operation
       JOIN adaptive_sessions session ON session.id=operation.session_id
       JOIN scoped_missions mission ON mission.id=session.mission_id
       WHERE operation.mutation_outcome='unknown'
         AND adaptive_operation_unknown_unresolved(operation.session_id,operation.operation_id)
       UNION ALL
       SELECT 'protected_mutation',mission.project_id,operation.mission_id,operation.environment_id,
              binding.resource_scope,NULL,operation.operation_id,operation.id,NULL,
              'protected',true,'recovery_required'
       FROM protected_operations operation
       JOIN scoped_missions mission ON mission.id=operation.mission_id
       LEFT JOIN LATERAL (
         SELECT resource_scope FROM external_resource_bindings candidate
         WHERE candidate.source_protected_operation_id=operation.id
           AND candidate.lifecycle_state='active' ORDER BY candidate.created_at DESC LIMIT 1
       ) binding ON true
       WHERE operation.mutation_outcome='unknown'
          OR operation.state IN ('reconciling','recovery_required')
          OR operation.recovery_class='reconciliation_required'
       UNION ALL
       SELECT 'resource_binding',mission.project_id,operation.mission_id,binding.environment_id,
              binding.resource_scope,NULL,operation.operation_id,operation.id,NULL,
              'external_binding',true,'live'
       FROM external_resource_bindings binding
       JOIN protected_operations operation ON operation.id=binding.source_protected_operation_id
       JOIN scoped_missions mission ON mission.id=operation.mission_id
       WHERE binding.lifecycle_state='active'
       UNION ALL
       SELECT 'reconciliation_owner',mission.project_id,reconciliation.mission_id,session.environment_id,
              NULL,NULL,reconciliation.operation_id,NULL,reconciliation.id,
              'reconciliation',reconciliation.lease_expires_at>now(),
              CASE WHEN reconciliation.lease_expires_at>now() THEN 'live' ELSE 'expired' END
       FROM adaptive_operation_reconciliations reconciliation
       JOIN scoped_missions mission ON mission.id=reconciliation.mission_id
       JOIN adaptive_sessions session ON session.id=reconciliation.session_id
       WHERE reconciliation.state='observing'
       UNION ALL
       SELECT CASE WHEN lease.lease_expires_at>now() THEN 'praxis_runtime_owner' ELSE 'praxis_recovery' END,
              session.project_id,session.mission_id,session.environment_id,NULL,NULL,NULL,NULL,NULL,
              'lifecycle',true,
              CASE WHEN lease.lease_expires_at>now() THEN 'live' ELSE 'recovery_required' END
       FROM adaptive_sessions session
       JOIN scoped_missions mission ON mission.id=session.mission_id
       LEFT JOIN adaptive_session_runtime_leases lease ON lease.session_id=session.id
       WHERE session.state IN ('created','provisioning','active','suspended','recovery_required')
         AND (session.state='recovery_required' OR lease.session_id IS NULL OR lease.lease_expires_at<=now()
              OR lease.lease_expires_at>now())
       UNION ALL
       SELECT 'external_agent_owner',mission.project_id,agent.mission_id,NULL,NULL,NULL,NULL,NULL,NULL,
              'lifecycle',agent.lease_expires_at IS NULL OR agent.lease_expires_at>now(),
              CASE WHEN agent.lease_expires_at IS NULL OR agent.lease_expires_at>now()
                   THEN 'live' ELSE 'expired' END
       FROM agent_sessions agent JOIN scoped_missions mission ON mission.id=agent.mission_id
       WHERE agent.status='active'
       UNION ALL
       SELECT 'run_owner',run.project_id,run.mission_id,NULL,NULL,NULL,NULL,NULL,NULL,
              'lifecycle',true,'live'
       FROM runs run JOIN scoped_missions mission ON mission.id=run.mission_id
       WHERE run.state NOT IN ('passed','failed','cancelled','timed_out','infrastructure_error')
     )
     SELECT kind,"projectId"::text,"missionId"::text,"environmentId"::text,
            "resourceDomain","credentialDomain",operation_id AS "operationId",
            protected_operation_id::text AS "protectedOperationId",recovery_id::text AS "recoveryId",
            authority,blocking,lifecycle
     FROM (SELECT kind,project_id AS "projectId",mission_id AS "missionId",
                  environment_id AS "environmentId",resource_domain AS "resourceDomain",
                  credential_domain AS "credentialDomain",operation_id,protected_operation_id,
                  recovery_id,authority,blocking,lifecycle FROM blockers) scoped
     WHERE ($3::uuid IS NULL OR "environmentId" IS NULL OR "environmentId"=$3)
       AND ($4::text IS NULL OR "resourceDomain" IS NULL OR "resourceDomain"=$4)
       AND ($5::text IS NULL OR "credentialDomain" IS NULL OR "credentialDomain"=$5)`,
    [
      input.projectId,
      input.missionId ?? null,
      input.environmentId ?? null,
      input.resourceDomain ?? null,
      input.credentialDomain ?? null,
    ],
  );
  return result.rows;
}
