import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type {
  AdoptLegacyExternalAgentSessionInput,
  OperatingContext,
  StartExternalAgentRunInput,
  TerminateExternalAgentRunInput,
} from "@scry/contracts";

import { MissionFlowAuthoringService } from "../../adaptive-sessions/index.js";
import type { Principal } from "../../auth/index.js";
import { Database, OperationalEvents } from "../../infrastructure/index.js";

type OwnedSession = {
  agentSessionId: string;
  missionId: string | null;
  projectId: string | null;
  status: string;
};

@Injectable()
export class ExternalAgentLifecycleService implements OnModuleInit, OnModuleDestroy {
  private sweep?: NodeJS.Timeout;

  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(MissionFlowAuthoringService)
    private readonly praxis: MissionFlowAuthoringService,
    @Inject(OperationalEvents) private readonly events: OperationalEvents,
  ) {}

  onModuleInit() {
    this.sweep = setInterval(
      () => void this.recoverExpiredLeases().catch(() => undefined),
      configuredInteger("SCRY_EXTERNAL_AGENT_SWEEP_MS", 30_000, 1_000, 300_000),
    );
    this.sweep.unref();
  }

  onModuleDestroy() {
    if (this.sweep) clearInterval(this.sweep);
  }

  async start(principal: Principal, externalRunId: string, input: StartExternalAgentRunInput) {
    if (input.correlationId && input.correlationId !== externalRunId)
      throw new ConflictException({ code: "EXTERNAL_AGENT_CORRELATION_IDENTITY_CONFLICT" });
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `external-agent:${externalRunId}`,
      ]);
      const existing = await client.query<{
        agentSessionId: string;
        workspaceId: string | null;
        provider: string;
        model: string | null;
        experimentId: string | null;
        status: string;
        missionId: string | null;
        projectId: string | null;
      }>(
        `SELECT id::text AS "agentSessionId",workspace_id::text AS "workspaceId",
                provider,model,experiment_id AS "experimentId",status,
                mission_id::text AS "missionId",project_id::text AS "projectId"
           FROM agent_sessions WHERE external_run_id=$1 FOR UPDATE`,
        [externalRunId],
      );
      if (existing.rowCount) {
        const session = existing.rows[0]!;
        if (
          principal.kind === "user" &&
          session.workspaceId &&
          session.workspaceId !== principal.workspaceId
        )
          throw new ForbiddenException({ code: "EXTERNAL_AGENT_WORKSPACE_MISMATCH" });
        if (
          session.provider !== input.provider ||
          session.model !== (input.model ?? null) ||
          session.experimentId !== (input.experimentId ?? null)
        )
          throw new ConflictException({ code: "EXTERNAL_AGENT_PROVENANCE_CONFLICT" });
        if (session.status !== "active")
          throw new ConflictException({
            code: "EXTERNAL_AGENT_RUN_ALREADY_SETTLED",
            terminalStatus: session.status,
            safeActions: ["use_fresh_external_run_identity"],
          });
        return { ...session, externalRunId, replayed: true };
      }

      const inserted = await client.query<{ agentSessionId: string; status: string }>(
        `INSERT INTO agent_sessions(
           mission_id,project_id,workspace_id,provider,model,external_run_id,experiment_id,
           instruction_snapshot,idempotency_key,heartbeat_at,lease_expires_at
         ) VALUES(NULL,NULL,$1,$2,$3,$4,$5,
           'External MCP execution initialized before Mission selection',$6,now(),
           now()+($7::text || ' milliseconds')::interval)
         RETURNING id::text AS "agentSessionId",status`,
        [
          workspaceId(principal),
          input.provider,
          input.model ?? null,
          externalRunId,
          input.experimentId ?? null,
          `external-run:${externalRunId}`,
          externalAgentLeaseMs(),
        ],
      );
      return {
        ...inserted.rows[0]!,
        externalRunId,
        workspaceId: workspaceId(principal),
        missionId: null,
        projectId: null,
        provider: input.provider,
        model: input.model ?? null,
        experimentId: input.experimentId ?? null,
        replayed: false,
      };
    });
  }

  async observeOperatingContext(
    principal: Principal,
    externalRunId: string,
    projectId: string,
    context: OperatingContext,
  ) {
    const blockerCode = context.continuation.blockerCode ?? null;
    const bound = await this.database.transaction(async (client) => {
      const project = await client.query<{ workspaceId: string }>(
        `SELECT workspace_id::text AS "workspaceId" FROM projects
         WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)`,
        [projectId, workspaceId(principal)],
      );
      if (!project.rowCount) throw new NotFoundException({ code: "PROJECT_NOT_FOUND" });
      const session = await client.query<{
        agentSessionId: string;
        projectId: string | null;
        blockerCode: string | null;
      }>(
        `SELECT id::text AS "agentSessionId",project_id::text AS "projectId",
                blocker_code AS "blockerCode"
           FROM agent_sessions
          WHERE external_run_id=$1 AND status='active'
            AND ($2::uuid IS NULL OR workspace_id IS NULL OR workspace_id=$2)
          FOR UPDATE`,
        [externalRunId, workspaceId(principal)],
      );
      if (!session.rowCount) return null;
      const current = session.rows[0]!;
      if (current.projectId && current.projectId !== projectId)
        throw new ConflictException({ code: "EXTERNAL_AGENT_PROJECT_IDENTITY_CONFLICT" });
      await client.query(
        `UPDATE agent_sessions SET project_id=$2,workspace_id=COALESCE(workspace_id,$3),
           blocker_code=$4,heartbeat_at=now(),
           lease_expires_at=now()+($5::text || ' milliseconds')::interval
         WHERE id=$1`,
        [
          current.agentSessionId,
          projectId,
          project.rows[0]!.workspaceId,
          blockerCode,
          externalAgentLeaseMs(),
        ],
      );
      return {
        agentSessionId: current.agentSessionId,
        blockerChanged: Boolean(blockerCode && blockerCode !== current.blockerCode),
      };
    });

    if (bound?.blockerChanged && blockerCode) {
      await this.events.emit("runtime", {
        name: "external_agent.blocked",
        classification: blockerCode.includes("RECONCILIATION")
          ? "reconciliation_unknown"
          : "policy_refusal",
        reasonCode: blockerCode,
        outcome: blockerCode.includes("RECONCILIATION") ? "reconciliation_required" : "refused",
        causality: {
          projectId,
          agentSessionId: bound.agentSessionId,
          correlationId: externalRunId,
        },
        details: {
          stage: "pre_mission",
          userAuthorityRequired: context.continuation.userAuthorityRequired,
          freshPrimaryMissionPermitted: context.missions.policy.freshPrimaryMissionPermitted,
        },
      });
    }
    return {
      owned: Boolean(bound),
      agentSessionId: bound?.agentSessionId ?? null,
      projectId,
      blockerCode,
    };
  }

  async heartbeat(principal: Principal, externalRunId: string) {
    const result = await this.database.query<{ agentSessionId: string; leaseExpiresAt: string }>(
      `UPDATE agent_sessions session
       SET heartbeat_at=now(),
           lease_expires_at=now()+($3::text || ' milliseconds')::interval
       WHERE session.external_run_id=$1
         AND session.status='active'
         AND ($2::uuid IS NULL OR session.workspace_id=$2)
       RETURNING session.id::text AS "agentSessionId",
                 session.lease_expires_at::text AS "leaseExpiresAt"`,
      [externalRunId, workspaceId(principal), externalAgentLeaseMs()],
    );
    return {
      active: Boolean(result.rowCount),
      agentSessionId: result.rows[0]?.agentSessionId ?? null,
      leaseExpiresAt: result.rows[0]?.leaseExpiresAt ?? null,
    };
  }

  async terminate(
    principal: Principal,
    externalRunId: string,
    input: TerminateExternalAgentRunInput,
  ) {
    const owned = await this.ownedSessions(principal, externalRunId);
    if (!owned.length) return { settled: true, replayed: true, owned: false, sessions: [] };
    const activeOwned = owned.filter(({ status }) => status === "active");
    if (!activeOwned.length) {
      await this.repairSettledObjectiveProjection(principal, externalRunId);
      return {
        settled: true,
        replayed: true,
        owned: true,
        sessions: owned.map(({ agentSessionId }) => agentSessionId),
      };
    }
    const terminalOutcome =
      input.terminalOutcome ?? terminalOutcomeForReason(input.reasonCode, input.blockerCode);
    const terminalStatus = agentSessionStatusForOutcome(terminalOutcome);

    const praxisRows = await this.database.query<{ id: string }>(
      `SELECT adaptive.id::text
       FROM adaptive_sessions adaptive
       JOIN agent_sessions session ON session.id=adaptive.agent_session_id
       JOIN missions mission ON mission.id=session.mission_id
       JOIN projects project ON project.id=mission.project_id
       WHERE session.external_run_id=$1
         AND adaptive.state NOT IN ('completed','failed','cancelled','recovery_required')
         AND ($2::uuid IS NULL OR project.workspace_id=$2)
       ORDER BY adaptive.created_at,adaptive.id`,
      [externalRunId, workspaceId(principal)],
    );
    if (terminalOutcome === "objective_completed" && praxisRows.rowCount)
      throw new ConflictException({
        code: "EXTERNAL_AGENT_OBJECTIVE_COMPLETION_UNSETTLED_RUNTIME",
        safeActions: ["close_praxis_session", "finalize_run"],
      });
    const praxisSettlements = [];
    for (const row of praxisRows.rows) {
      try {
        praxisSettlements.push(
          await this.praxis.settleExternalOwnerLoss(
            principal,
            row.id,
            input.reasonCode,
            `external-owner-loss:${externalRunId}:${row.id}`,
          ),
        );
      } catch {
        praxisSettlements.push({
          state: "unavailable",
          reconciliationRequired: false,
          replayed: false,
          settlementUnavailable: true,
        });
      }
    }

    const settled = await this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${workspaceId(principal) ?? "service"}:${externalRunId}`,
      ]);
      const runs = await client.query<{
        runId: string;
        attemptId: string | null;
        missionId: string;
        objectiveId: string;
        agentSessionId: string;
        projectId: string;
      }>(
        `SELECT run.id::text AS "runId",attempt.id::text AS "attemptId",
                run.mission_id::text AS "missionId",run.objective_id::text AS "objectiveId",
                run.agent_session_id::text AS "agentSessionId",run.project_id::text AS "projectId"
         FROM runs run
         JOIN agent_sessions session ON session.id=run.agent_session_id
         JOIN missions mission ON mission.id=run.mission_id
         JOIN projects project ON project.id=mission.project_id
         LEFT JOIN LATERAL (
           SELECT candidate.id FROM attempts candidate
           WHERE candidate.run_id=run.id
             AND candidate.state IN ('preparing','running','finalizing')
           ORDER BY candidate.attempt_number DESC LIMIT 1
         ) attempt ON true
         WHERE session.external_run_id=$1
           AND ($2::uuid IS NULL OR project.workspace_id=$2)
           AND run.state NOT IN ('passed','failed','cancelled','timed_out','infrastructure_error')
         FOR UPDATE OF run`,
        [externalRunId, workspaceId(principal)],
      );
      if (terminalOutcome === "objective_completed" && runs.rowCount)
        throw new ConflictException({
          code: "EXTERNAL_AGENT_OBJECTIVE_COMPLETION_UNSETTLED_RUN",
          safeActions: ["finalize_run"],
        });
      const runIds = runs.rows.map(({ runId }) => runId);
      const objectiveIds = [...new Set(runs.rows.map(({ objectiveId }) => objectiveId))];
      const attemptIds = runs.rows.flatMap(({ attemptId }) => (attemptId ? [attemptId] : []));
      if (attemptIds.length)
        await client.query(
          `UPDATE attempts SET state='infrastructure_error',completed_at=now(),heartbeat_at=now(),
             error=$2 WHERE id=ANY($1::uuid[])`,
          [attemptIds, input.reasonCode],
        );
      if (runIds.length) {
        await client.query(
          `UPDATE runs SET state='infrastructure_error',phase='completed',
             outcome_classification='infrastructure_failure',
             result_classification='infrastructure_failure',updated_at=now()
           WHERE id=ANY($1::uuid[])`,
          [runIds],
        );
        await client.query(
          `UPDATE mission_objective_orchestration SET state='blocked',blocker_code=$2,
             lease_token=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE active_run_id=ANY($1::uuid[])`,
          [runIds, input.reasonCode],
        );
        await client.query(
          `UPDATE mission_objectives SET status='blocked',updated_at=now()
           WHERE id=ANY($1::uuid[]) AND status IN ('pending','running')`,
          [objectiveIds],
        );
      }
      const ended = await client.query<{ agentSessionId: string; missionId: string }>(
        `UPDATE agent_sessions session SET
           status=$4,ended_at=now(),lease_expires_at=now(),termination_reason=$3,
           blocker_code=COALESCE($5,blocker_code),terminal_outcome=$6
         FROM missions mission JOIN projects project ON project.id=mission.project_id
         WHERE session.external_run_id=$1 AND session.status='active'
           AND mission.id=session.mission_id
           AND ($2::uuid IS NULL OR project.workspace_id=$2)
         RETURNING session.id::text AS "agentSessionId",
                   session.mission_id::text AS "missionId"`,
        [
          externalRunId,
          workspaceId(principal),
          input.reasonCode,
          terminalStatus,
          input.blockerCode ?? null,
          terminalOutcome,
        ],
      );
      for (const row of ended.rows) {
        const run = runs.rows.find(({ agentSessionId }) => agentSessionId === row.agentSessionId);
        if (terminalOutcome !== "objective_completed")
          await client.query(
            `UPDATE missions SET status='blocked',
               resume_pointer=CASE WHEN $2::uuid IS NULL THEN resume_pointer ELSE jsonb_build_object(
                 'objectiveId',$2::text,
                 'recommendedAction','review_failure',
                 'runId',$3::text,
                 'explanation',$4::text
               ) END,
               revision=revision+1,updated_at=now()
             WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`,
            [row.missionId, run?.objectiveId ?? null, run?.runId ?? null, input.reasonCode],
          );
        await client.query(
          `INSERT INTO mission_activities(
             mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical
           ) VALUES($1,$2,$3,'agent_session_ended',$4,$5::jsonb,true)`,
          [
            row.missionId,
            run?.objectiveId ?? null,
            row.agentSessionId,
            terminalOutcome === "objective_completed"
              ? "External agent objective completed"
              : "External agent ownership ended",
            JSON.stringify({ reasonCode: input.reasonCode, externalRunId, terminalOutcome }),
          ],
        );
      }
      const preMissionEnded = await client.query<{
        agentSessionId: string;
        projectId: string | null;
      }>(
        `UPDATE agent_sessions SET status=$3,ended_at=now(),lease_expires_at=now(),
           termination_reason=$4,blocker_code=COALESCE($5,blocker_code),terminal_outcome=$6
         WHERE external_run_id=$1 AND mission_id IS NULL AND status='active'
           AND ($2::uuid IS NULL OR workspace_id=$2)
         RETURNING id::text AS "agentSessionId",project_id::text AS "projectId"`,
        [
          externalRunId,
          workspaceId(principal),
          terminalStatus,
          input.reasonCode,
          input.blockerCode ?? null,
          terminalOutcome,
        ],
      );
      return { runs: runs.rows, ended: ended.rows, preMissionEnded: preMissionEnded.rows };
    });

    const first = settled.runs[0];
    const preMission = settled.preMissionEnded[0];
    if (terminalOutcome !== "objective_completed")
      await this.events.emit("runtime", {
        name: "external_agent.lifecycle_settled",
        classification:
          terminalOutcome === "blocked_user_authority" || terminalOutcome === "blocked_system"
            ? "policy_refusal"
            : terminalOutcome === "provider_failure"
              ? "application_provider"
              : "infrastructure",
        reasonCode: input.reasonCode,
        outcome:
          terminalOutcome === "blocked_user_authority" || terminalOutcome === "blocked_system"
            ? "refused"
            : "failed",
        causality: {
          ...((first?.projectId ?? preMission?.projectId ?? activeOwned[0]!.projectId)
            ? { projectId: first?.projectId ?? preMission?.projectId ?? activeOwned[0]!.projectId! }
            : {}),
          ...((first?.missionId ?? activeOwned[0]!.missionId)
            ? { missionId: first?.missionId ?? activeOwned[0]!.missionId! }
            : {}),
          agentSessionId:
            first?.agentSessionId ?? preMission?.agentSessionId ?? activeOwned[0]!.agentSessionId,
          ...(first ? { objectiveId: first.objectiveId, runId: first.runId } : {}),
          correlationId: externalRunId,
        },
        transition: { from: "active", to: terminalStatus },
        details: {
          stage: first || activeOwned[0]!.missionId ? "mission" : "pre_mission",
          terminalOutcome,
          blockerRetained: Boolean(input.blockerCode),
          harnessLimit: input.reasonCode.startsWith("MAX_"),
          reconciliationRequired: praxisSettlements.some((value) => value.reconciliationRequired),
          praxisSettlementUnavailable: praxisSettlements.some(
            (value) => "settlementUnavailable" in value && value.settlementUnavailable,
          ),
        },
      });
    return {
      settled: true,
      replayed: settled.ended.length === 0 && settled.runs.length === 0,
      owned: true,
      sessions: owned.map(({ agentSessionId }) => agentSessionId),
      runs: settled.runs.map(({ runId }) => runId),
      praxis: praxisSettlements,
      reasonCode: input.reasonCode,
      terminalOutcome,
      blockerCode: input.blockerCode ?? null,
    };
  }

  async adoptAndTerminateLegacySession(
    agentSessionId: string,
    input: AdoptLegacyExternalAgentSessionInput,
  ) {
    const session = await this.database.query<{
      externalRunId: string | null;
      status: string;
      provider: string;
      model: string | null;
    }>(
      `SELECT external_run_id::text AS "externalRunId",status,provider,model
       FROM agent_sessions WHERE id=$1`,
      [agentSessionId],
    );
    if (!session.rowCount) throw new NotFoundException("Agent session not found");
    const current = session.rows[0]!;
    if (current.externalRunId && current.externalRunId !== input.externalRunId)
      throw new ConflictException({ code: "EXTERNAL_AGENT_RUN_IDENTITY_CONFLICT" });

    if (!current.externalRunId) {
      if (current.status !== "active")
        throw new ConflictException({ code: "LEGACY_AGENT_SESSION_NOT_ACTIVE" });
      const adopted = await this.database.query(
        `UPDATE agent_sessions SET
           external_run_id=$2,provider=$3,model=$4,experiment_id=$5,
           heartbeat_at=COALESCE(heartbeat_at,now()),lease_expires_at=now()
         WHERE id=$1 AND status='active' AND external_run_id IS NULL`,
        [
          agentSessionId,
          input.externalRunId,
          input.provider,
          input.model ?? null,
          input.experimentId ?? null,
        ],
      );
      if (!adopted.rowCount)
        throw new ConflictException({ code: "LEGACY_AGENT_SESSION_ADOPTION_CONFLICT" });
    } else if (current.provider !== input.provider || current.model !== (input.model ?? null)) {
      throw new ConflictException({ code: "EXTERNAL_AGENT_PROVENANCE_CONFLICT" });
    }

    return this.terminate({ kind: "service", subject: "scry-service" }, input.externalRunId, {
      reasonCode: input.reasonCode,
    });
  }

  async recoverExpiredLeases() {
    const expired = await this.database.query<{ externalRunId: string }>(
      `SELECT DISTINCT external_run_id::text AS "externalRunId"
       FROM agent_sessions
       WHERE status='active' AND external_run_id IS NOT NULL
         AND lease_expires_at IS NOT NULL AND lease_expires_at<now()
       ORDER BY external_run_id`,
    );
    for (const row of expired.rows)
      await this.terminate({ kind: "service", subject: "scry-service" }, row.externalRunId, {
        reasonCode: "EXTERNAL_AGENT_LEASE_EXPIRED",
      });
    await this.praxis.convergeExpiredRuntimeOwners?.();
    return expired.rows.map(({ externalRunId }) => externalRunId);
  }

  private async ownedSessions(principal: Principal, externalRunId: string) {
    return (
      await this.database.query<OwnedSession>(
        `SELECT session.id::text AS "agentSessionId",session.mission_id::text AS "missionId",
                COALESCE(session.project_id,mission.project_id)::text AS "projectId",session.status
         FROM agent_sessions session
         LEFT JOIN missions mission ON mission.id=session.mission_id
         LEFT JOIN projects project ON project.id=COALESCE(session.project_id,mission.project_id)
         WHERE session.external_run_id=$1
           AND ($2::uuid IS NULL OR COALESCE(session.workspace_id,project.workspace_id)=$2)
         ORDER BY session.started_at,session.id`,
        [externalRunId, workspaceId(principal)],
      )
    ).rows;
  }

  private async repairSettledObjectiveProjection(principal: Principal, externalRunId: string) {
    await this.database.query(
      `UPDATE mission_objectives objective SET status='blocked',updated_at=now()
       FROM runs run
       JOIN agent_sessions session ON session.id=run.agent_session_id
       JOIN missions mission ON mission.id=run.mission_id
       JOIN projects project ON project.id=mission.project_id
       WHERE session.external_run_id=$1
         AND ($2::uuid IS NULL OR project.workspace_id=$2)
         AND run.objective_id=objective.id
         AND run.state='infrastructure_error'
         AND objective.status IN ('pending','running')`,
      [externalRunId, workspaceId(principal)],
    );
  }
}

function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}

function externalAgentLeaseMs() {
  return configuredInteger("SCRY_EXTERNAL_AGENT_LEASE_MS", 180_000, 30_000, 3_600_000);
}

function terminalOutcomeForReason(
  reasonCode: TerminateExternalAgentRunInput["reasonCode"],
  blockerCode?: string,
): NonNullable<TerminateExternalAgentRunInput["terminalOutcome"]> {
  if (reasonCode === "EXTERNAL_AGENT_OBJECTIVE_COMPLETED") return "objective_completed";
  if (reasonCode === "EXTERNAL_AGENT_BLOCKED_USER_AUTHORITY") return "blocked_user_authority";
  if (reasonCode === "EXTERNAL_AGENT_BLOCKED_SYSTEM" || blockerCode) return "blocked_system";
  if (reasonCode.startsWith("MAX_")) return "limit_exceeded";
  if (reasonCode === "MODEL_PROVIDER_ERROR") return "provider_failure";
  if (reasonCode === "EXTERNAL_AGENT_HARNESS_CANCELLED") return "cancelled";
  if (reasonCode === "EXTERNAL_AGENT_MODEL_STOPPED_WITHOUT_COMPLETION")
    return "model_stopped_without_completion";
  return "blocked_system";
}

function agentSessionStatusForOutcome(
  outcome: NonNullable<TerminateExternalAgentRunInput["terminalOutcome"]>,
) {
  if (outcome === "objective_completed") return "completed" as const;
  if (outcome === "blocked_user_authority" || outcome === "blocked_system")
    return "blocked" as const;
  if (outcome === "provider_failure") return "failed" as const;
  return "interrupted" as const;
}

function configuredInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name}_INVALID`);
  return value;
}
