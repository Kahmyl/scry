import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

export type AttachExternalAgentSessionInput = Readonly<{
  missionId: string;
  projectId: string;
  workspaceId: string | null;
  provider: string;
  model?: string;
  externalRunId?: string;
  experimentId?: string;
  connectionId?: string;
  instructionSnapshot: string;
  idempotencyKey: string;
  leaseMs: number;
}>;

/**
 * Attaches the canonical pre-Mission execution row when one exists; otherwise
 * creates the same row at the Mission boundary. An external-run identity can
 * own at most one agent session for its entire lifecycle.
 */
export async function attachOrCreateExternalAgentSession(
  query: Query,
  input: AttachExternalAgentSessionInput,
) {
  if (!input.externalRunId) {
    const agentSessionId = randomUUID();
    await insertMissionSession(query, agentSessionId, input);
    return { agentSessionId, attachedPreMission: false };
  }

  await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `external-agent:${input.externalRunId}`,
  ]);
  const existing = await query<{
    agentSessionId: string;
    missionId: string | null;
    projectId: string | null;
    workspaceId: string | null;
    provider: string;
    model: string | null;
    experimentId: string | null;
    status: string;
  }>(
    `SELECT id::text AS "agentSessionId",mission_id::text AS "missionId",
            project_id::text AS "projectId",workspace_id::text AS "workspaceId",
            provider,model,experiment_id AS "experimentId",status
       FROM agent_sessions WHERE external_run_id=$1 FOR UPDATE`,
    [input.externalRunId],
  );

  if (!existing.rowCount) {
    const agentSessionId = randomUUID();
    await insertMissionSession(query, agentSessionId, input);
    return { agentSessionId, attachedPreMission: false };
  }

  const session = existing.rows[0]!;
  requireProvenance(session, input);
  if (session.status !== "active")
    throw new ConflictException({
      code: "EXTERNAL_AGENT_RUN_ALREADY_SETTLED",
      terminalStatus: session.status,
      safeActions: ["use_fresh_external_run_identity"],
    });
  if (session.missionId)
    throw new ConflictException({
      code: "EXTERNAL_AGENT_RUN_ALREADY_ATTACHED",
      missionId: session.missionId,
      safeActions: ["get_mission"],
    });
  if (session.projectId && session.projectId !== input.projectId)
    throw new ConflictException({ code: "EXTERNAL_AGENT_PROJECT_IDENTITY_CONFLICT" });
  if (session.workspaceId && input.workspaceId && session.workspaceId !== input.workspaceId)
    throw new ConflictException({ code: "EXTERNAL_AGENT_WORKSPACE_IDENTITY_CONFLICT" });

  await query(
    `UPDATE agent_sessions SET
       mission_id=$2,project_id=$3,workspace_id=COALESCE(workspace_id,$4),
       connection_id=$5,instruction_snapshot=$6,idempotency_key=$7,
       blocker_code=NULL,heartbeat_at=now(),
       lease_expires_at=now()+($8::text || ' milliseconds')::interval
     WHERE id=$1`,
    [
      session.agentSessionId,
      input.missionId,
      input.projectId,
      input.workspaceId,
      input.connectionId ?? null,
      input.instructionSnapshot,
      input.idempotencyKey,
      input.leaseMs,
    ],
  );
  return { agentSessionId: session.agentSessionId, attachedPreMission: true };
}

async function insertMissionSession(
  query: Query,
  agentSessionId: string,
  input: AttachExternalAgentSessionInput,
) {
  await query(
    `INSERT INTO agent_sessions(
       id,mission_id,project_id,workspace_id,provider,model,external_run_id,experiment_id,
       connection_id,instruction_snapshot,idempotency_key,heartbeat_at,lease_expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END,
       CASE WHEN $7::uuid IS NULL THEN NULL
         ELSE now()+($12::text || ' milliseconds')::interval END
     )`,
    [
      agentSessionId,
      input.missionId,
      input.projectId,
      input.workspaceId,
      input.provider,
      input.model ?? null,
      input.externalRunId ?? null,
      input.experimentId ?? null,
      input.connectionId ?? null,
      input.instructionSnapshot,
      input.idempotencyKey,
      input.leaseMs,
    ],
  );
}

function requireProvenance(
  session: {
    provider: string;
    model: string | null;
    experimentId: string | null;
  },
  input: AttachExternalAgentSessionInput,
) {
  if (
    session.provider !== input.provider ||
    session.model !== (input.model ?? null) ||
    session.experimentId !== (input.experimentId ?? null)
  )
    throw new ConflictException({ code: "EXTERNAL_AGENT_PROVENANCE_CONFLICT" });
}
