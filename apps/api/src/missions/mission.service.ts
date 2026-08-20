import { composeMissionEvidence } from "@scry/chronicle";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  AcceptEvidenceInput,
  AttachFlowInput,
  ClassifyRunInput,
  CreateActivityRelationInput,
  CreateMissionInput,
  CreateObjectiveInput,
  EndAgentSessionInput,
  MissionTransitionInput,
  PublishMissionReportInput,
  SetMissionRecordingSelectionInput,
  StartAgentSessionInput,
  UpdateMissionInput,
  UpdateObjectiveInput,
  UpdateResumePointerInput,
  FinalizeAgentWorkInput,
  FinalizedAgentWork,
} from "@scry/contracts";

import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";
import { resolveMissionRecording } from "./mission-recording-resolver.js";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

const reportableObjectivePredicate = (alias: string) =>
  `(${alias}.status IN ('passed','failed') OR (${alias}.status IN ('blocked','skipped') AND ${alias}.conclusion IS NOT NULL))`;

@Injectable()
export class MissionService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async create(principal: Principal, projectId: string, input: CreateMissionInput) {
    this.requireWrite(principal);

    if (
      input.distinctReason &&
      (input.distinctAuthority?.confirmedUserAuthorized !== true ||
        input.distinctAuthority.selection !== "start_distinct_mission")
    )
      throw new ConflictException({
        code: "MISSION_DISTINCT_WORK_AUTHORITY_REQUIRED",
        message: "Distinct work requires explicit current-user authority after Mission comparison.",
        safeActions: ["list_missions"],
      });

    if (!input.distinctReason && input.distinctAuthority)
      throw new ConflictException({
        code: "MISSION_DISTINCT_WORK_AUTHORITY_WITHOUT_REASON",
      });

    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      await this.requireProject(query, principal, projectId);
      const replay = await this.claimIdempotency(
        query,
        `mission:create:${projectId}`,
        input.idempotencyKey,
        input,
      );
      if (replay)
        return {
          ...(replay as Record<string, unknown>),
          replayed: true,
        };
      if (!input.distinctReason) {
        const candidates = await query<{
          id: string;
          title: string;
          status: string;
          resumePointer: unknown;
        }>(
          `SELECT id,title,status,resume_pointer AS "resumePointer" FROM missions WHERE project_id=$1 AND status NOT IN ('completed','failed','cancelled') AND (lower(title)=lower($2) OR lower(original_instruction)=lower($3)) ORDER BY created_at DESC,id DESC`,
          [projectId, input.title, input.originalInstruction],
        );
        if (candidates.rowCount)
          throw new ConflictException({
            code: "MISSION_CONTINUATION_REQUIRED",
            message:
              "A non-terminal Mission with the same durable identity already exists. Do not infer continuation authority from this collision. Ask the user whether to continue a candidate or create distinct work; call resume_mission only after explicit continuation, or retry start_mission with distinctReason only after explicit new-work choice.",
            candidates: candidates.rows,
            safeActions: [
              "list_missions",
              "resume_mission",
              "update_mission",
              "cancel_mission",
              "start_distinct_mission",
            ],
          });
      }
      const missionId = randomUUID();
      const agentSessionId = randomUUID();
      await query(
        `INSERT INTO missions(id,project_id,title,original_instruction,status) VALUES($1,$2,$3,$4,'planning')`,
        [missionId, projectId, input.title, input.originalInstruction],
      );
      await query(
        `INSERT INTO agent_sessions(id,mission_id,provider,connection_id,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          agentSessionId,
          missionId,
          input.provider,
          input.connectionId ?? null,
          input.instructionSnapshot,
          input.idempotencyKey,
        ],
      );
      await this.activity(
        query,
        missionId,
        null,
        agentSessionId,
        "mission_created",
        `Mission created: ${input.title}`,
        {
          projectId,
          ...(input.distinctReason
            ? {
                distinctReason: input.distinctReason,
                userChoiceAuthority: {
                  confirmedUserAuthorized: true,
                  selection: input.distinctAuthority!.selection,
                  source: input.distinctAuthority!.source,
                },
              }
            : {}),
        },
      );
      const response = { missionId, agentSessionId, status: "planning", replayed: false };
      await this.completeIdempotency(
        query,
        `mission:create:${projectId}`,
        input.idempotencyKey,
        response,
      );
      return response;
    });
  }

  async list(principal: Principal, projectId: string) {
    await this.requireProject(
      (text, values) => this.database.query(text, values),
      principal,
      projectId,
    );
    return (
      await this.database.query(
        `SELECT m.id,m.project_id AS "projectId",m.title,m.original_instruction AS "originalInstruction",m.status,
              m.resume_pointer AS "resumePointer",m.revision,m.created_at AS "createdAt",m.updated_at AS "updatedAt",
              COUNT(DISTINCT o.id)::int AS "objectiveCount",COUNT(DISTINCT o.id) FILTER (WHERE ${reportableObjectivePredicate("o")})::int AS "terminalObjectiveCount",
              COUNT(DISTINCT e.id) FILTER (WHERE e.superseded_at IS NULL AND e.invalidated_at IS NULL)::int AS "acceptedEvidenceCount",
              (SELECT summary FROM mission_activities WHERE mission_id=m.id AND technical=false ORDER BY occurred_at DESC LIMIT 1) AS "lastMeaningfulActivity",
              (SELECT id FROM mission_reports WHERE mission_id=m.id AND status='published' ORDER BY revision DESC LIMIT 1) AS "latestReportId"
       FROM missions m LEFT JOIN mission_objectives o ON o.mission_id=m.id
       LEFT JOIN accepted_evidence e ON e.objective_id=o.id
       WHERE m.project_id=$1 GROUP BY m.id ORDER BY m.created_at DESC,m.id DESC`,
        [projectId],
      )
    ).rows;
  }

  async update(principal: Principal, missionId: string, input: UpdateMissionInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      await this.requireContext(q, principal, missionId, input.agentSessionId);
      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
      const updated = await q(
        `UPDATE missions SET title=COALESCE($2,title),original_instruction=COALESCE($3,original_instruction),updated_at=now(),revision=revision+1 WHERE id=$1 RETURNING id,title,original_instruction AS "originalInstruction",status,revision`,
        [missionId, input.title ?? null, input.originalInstruction ?? null],
      );
      await this.activity(
        q,
        missionId,
        null,
        input.agentSessionId,
        "mission_updated",
        "Mission definition updated",
        {
          fields: [
            input.title !== undefined ? "title" : null,
            input.originalInstruction !== undefined ? "originalInstruction" : null,
          ].filter(Boolean),
        },
      );
      return updated.rows[0];
    });
  }

  async get(principal: Principal, missionId: string) {
    await this.requireMission(
      (text, values) => this.database.query(text, values),
      principal,
      missionId,
      false,
    );
    const missionResult = await this.database.query(
      `SELECT m.id,m.project_id AS "projectId",m.title,m.original_instruction AS "originalInstruction",m.status,m.current_objective_id AS "currentObjectiveId",m.resume_pointer AS "resumePointer",m.final_report_id AS "finalReportId",m.final_report_id AS "latestReportId",m.revision,m.created_at AS "createdAt",m.updated_at AS "updatedAt",m.completed_at AS "completedAt",(SELECT COUNT(*)::int FROM mission_objectives WHERE mission_id=m.id) AS "objectiveCount",(SELECT COUNT(*)::int FROM mission_objectives o WHERE o.mission_id=m.id AND ${reportableObjectivePredicate("o")}) AS "terminalObjectiveCount",(SELECT COUNT(*)::int FROM accepted_evidence WHERE mission_id=m.id AND superseded_at IS NULL AND invalidated_at IS NULL) AS "acceptedEvidenceCount" FROM missions m WHERE m.id=$1`,
      [missionId],
    );
    const mission = missionResult.rows[0]!;
    const [objectives, flows, runs, evidence, reports, authoring] = await Promise.all([
      this.database.query(
        `SELECT o.id,o.title,o.description,o.status,o.dependencies,o.completion_criteria AS "completionCriteria",o.conclusion,o.objective_order AS "order",o.latest_candidate_run_id AS "latestCandidateRunId",o.created_at AS "createdAt",o.updated_at AS "updatedAt",x.state AS "orchestrationState",x.blocker_code AS "blockerCode",x.blocker_details AS "blockerDetails",x.active_run_id AS "activeRunId",b.mode AS "executionMode" FROM mission_objectives o LEFT JOIN mission_objective_orchestration x ON x.objective_id=o.id LEFT JOIN mission_execution_bindings b ON b.plan_id=x.plan_id AND b.objective_id=o.id WHERE o.mission_id=$1 ORDER BY o.objective_order`,
        [missionId],
      ),
      this.database.query(
        `SELECT l.objective_id AS "objectiveId",l.visibility,l.purpose,l.reason,f.id,f.name,f.description,f.latest_revision_id AS "latestRevisionId",fr.revision AS "latestRevision" FROM mission_flow_links l JOIN flows f ON f.id=l.flow_id JOIN flow_revisions fr ON fr.id=f.latest_revision_id WHERE l.mission_id=$1 ORDER BY l.created_at`,
        [missionId],
      ),
      this.database.query(
        `SELECT r.id,r.objective_id AS "objectiveId",r.state,r.phase,r.outcome_classification AS "outcomeClassification",r.result_classification AS "resultClassification",r.reliability_eligible AS "reliabilityEligible",r.compiled_contract_id AS "compiledContractId",fr.flow_id AS "flowId",f.name AS "flowName",l.role,l.reason,r.created_at AS "createdAt",r.updated_at AS "updatedAt",COALESCE(ae.available_count,0)::int AS "availableEvidenceCount",checkpoint.state AS "successorCheckpointState",checkpoint.expires_at AS "successorCheckpointExpiresAt" FROM runs r JOIN mission_run_links l ON l.run_id=r.id JOIN flow_revisions fr ON fr.id=r.flow_revision_id JOIN flows f ON f.id=fr.flow_id LEFT JOIN run_successor_checkpoints checkpoint ON checkpoint.run_id=r.id LEFT JOIN (SELECT ra.run_id,COUNT(*) FILTER (WHERE a.availability='available' AND a.privacy_classification IN ('safe','sanitized')) AS available_count FROM attempts ra JOIN artifacts a ON a.attempt_id=ra.id GROUP BY ra.run_id) ae ON ae.run_id=r.id WHERE r.mission_id=$1 ORDER BY r.created_at DESC,r.id DESC`,
        [missionId],
      ),
      this.database.query(
        `SELECT e.id,e.objective_id AS "objectiveId",e.run_id AS "runId",e.artifact_id AS "artifactId",e.conclusion,e.accepted_at AS "acceptedAt",e.superseded_at AS "supersededAt",e.invalidated_at AS "invalidatedAt" FROM accepted_evidence e WHERE e.mission_id=$1 ORDER BY e.accepted_at`,
        [missionId],
      ),
      this.database.query(
        `SELECT id,revision,status,snapshot,created_at AS "createdAt",superseded_at AS "supersededAt" FROM mission_reports WHERE mission_id=$1 ORDER BY revision DESC`,
        [missionId],
      ),
      this.database.query(
        `SELECT d.id,d.objective_id AS "objectiveId",d.predecessor_run_id AS "predecessorRunId",d.name,d.state,d.version,d.updated_at AS "updatedAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'level',p.level,'state',p.state,'draftVersion',p.draft_version,'result',p.result,'createdAt',p.created_at) ORDER BY p.created_at DESC) FROM probe_sessions p WHERE p.draft_id=d.id),'[]'::jsonb) probes,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'status',c.status,'draftVersion',c.draft_version,'diagnostics',c.diagnostics,'createdAt',c.created_at) ORDER BY c.created_at DESC) FROM flow_compilations c WHERE c.draft_id=d.id),'[]'::jsonb) compilations FROM flow_drafts d WHERE d.mission_id=$1 ORDER BY d.updated_at DESC`,
        [missionId],
      ),
    ]);
    const runRows = runs.rows as Array<
      Record<string, unknown> & { state: string; phase: string; flowId: string; flowName: string }
    >;
    const terminalRunStates = new Set([
      "passed",
      "failed",
      "cancelled",
      "timed_out",
      "infrastructure_error",
    ]);
    const currentRun = runRows.find((run) => !terminalRunStates.has(run.state));
    const currentDraft = (
      authoring.rows as Array<
        Record<string, unknown> & { id: string; name: string; state: string; updatedAt: string }
      >
    ).find((draft) => !["published", "abandoned"].includes(draft.state));
    return projectAgentMissionContext({
      ...mission,
      objectives: objectives.rows,
      flows: flows.rows,
      runs: runRows,
      acceptedEvidence: evidence.rows,
      reports: reports.rows,
      authoring: authoring.rows,
      flowProgress: {
        terminalRuns: runRows.filter((run) => terminalRunStates.has(run.state)).length,
        passedRuns: runRows.filter((run) => run.state === "passed").length,
        needsAttentionRuns: runRows.filter((run) =>
          ["failed", "timed_out", "infrastructure_error"].includes(run.state),
        ).length,
        current: currentRun
          ? {
              kind: "run",
              flowId: currentRun.flowId,
              name: currentRun.flowName,
              phase: currentRun.phase,
            }
          : currentDraft
            ? {
                kind: "authoring",
                flowId: currentDraft.id,
                name: currentDraft.name,
                phase: currentDraft.state,
              }
            : null,
        evidenceAvailable: runRows.some((run) => Number(run.availableEvidenceCount ?? 0) > 0),
      },
    });
  }

  async activities(principal: Principal, missionId: string, technical: boolean) {
    await this.requireMission(
      (text, values) => this.database.query(text, values),
      principal,
      missionId,
      false,
    );
    return (
      await this.database.query(
        `SELECT a.id,a.objective_id AS "objectiveId",a.agent_session_id AS "agentSessionId",a.type,a.summary,a.safe_metadata AS "safeMetadata",a.technical,a.occurred_at AS "occurredAt",
              COALESCE(jsonb_agg(jsonb_build_object('fromActivityId',r.from_activity_id,'toActivityId',r.to_activity_id,'relation',r.relation)) FILTER (WHERE r.id IS NOT NULL),'[]'::jsonb) AS relations
       FROM mission_activities a LEFT JOIN activity_relations r ON r.from_activity_id=a.id OR r.to_activity_id=a.id
       WHERE a.mission_id=$1 AND ($2 OR a.technical=false) GROUP BY a.id ORDER BY a.occurred_at`,
        [missionId, technical],
      )
    ).rows;
  }

  async relateActivities(
    principal: Principal,
    missionId: string,
    input: CreateActivityRelationInput,
  ) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      await this.requireContext(q, principal, missionId, input.agentSessionId);
      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
      const found = await q(
        `SELECT id FROM mission_activities WHERE mission_id=$1 AND id=ANY($2::uuid[])`,
        [missionId, [input.fromActivityId, input.toActivityId]],
      );
      if (found.rowCount !== 2)
        throw new ConflictException({ code: "ACTIVITY_RELATION_CONTEXT_MISMATCH" });
      const result = await q(
        `INSERT INTO activity_relations(mission_id,from_activity_id,to_activity_id,relation) VALUES($1,$2,$3,$4) RETURNING id`,
        [missionId, input.fromActivityId, input.toActivityId, input.relation],
      );
      return { id: result.rows[0]!.id, ...input };
    });
  }

  async startSession(principal: Principal, missionId: string, input: StartAgentSessionInput) {
    this.requireWrite(principal);

    if (
      input.continuationAuthority?.confirmedUserAuthorized !== true ||
      input.continuationAuthority.selection !== "continue_existing_mission"
    )
      throw new ConflictException({
        code: "MISSION_CONTINUATION_AUTHORITY_REQUIRED",
        message:
          "Creating a new agent session for an existing Mission requires explicit current-user continuation authority.",
        safeActions: ["list_missions"],
      });

    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      const mission = await this.requireMission(query, principal, missionId, true);

      if (["completed", "failed", "cancelled"].includes(mission.status))
        throw new ConflictException({
          code: "MISSION_REOPEN_REQUIRED",
          message:
            "A terminal Mission cannot start a new agent session through ordinary continuation. Reopen it explicitly before continuing.",
        });

      const existing = await query(
        `SELECT id,status FROM agent_sessions WHERE mission_id=$1 AND idempotency_key=$2`,
        [missionId, input.idempotencyKey],
      );
      if (existing.rowCount)
        return {
          missionId,
          agentSessionId: existing.rows[0]!.id,
          status: existing.rows[0]!.status,
          replayed: true,
        };
      const agentSessionId = randomUUID();
      await query(
        `INSERT INTO agent_sessions(id,mission_id,provider,connection_id,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          agentSessionId,
          missionId,
          input.provider,
          input.connectionId ?? null,
          input.instructionSnapshot,
          input.idempotencyKey,
        ],
      );
      await query(
        `UPDATE missions SET status=CASE WHEN status='planning' THEN 'running' ELSE status END,updated_at=now(),revision=revision+1 WHERE id=$1`,
        [missionId],
      );
      await this.activity(
        query,
        missionId,
        null,
        agentSessionId,
        "agent_session_started",
        `Agent session started (${input.provider})`,
        {
          continuationAuthority: {
            confirmedUserAuthorized: true,
            selection: input.continuationAuthority.selection,
            source: input.continuationAuthority.source,
          },
        },
      );
      return { missionId, agentSessionId, status: "active", replayed: false };
    });
  }

  async endSession(principal: Principal, sessionId: string, input: EndAgentSessionInput) {
    this.requireWrite(principal);
    const result = await this.database.query(
      `UPDATE agent_sessions s SET status=$2,ended_at=now() FROM missions m JOIN projects p ON p.id=m.project_id WHERE s.id=$1 AND m.id=s.mission_id AND ($3::uuid IS NULL OR p.workspace_id=$3) AND s.status='active' RETURNING s.id,s.mission_id AS "missionId"`,
      [sessionId, input.status, workspaceId(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Active agent session not found");
    await this.database.query(
      `INSERT INTO mission_activities(mission_id,agent_session_id,type,summary) VALUES($1,$2,'agent_session_ended',$3)`,
      [result.rows[0]!.missionId, sessionId, `Agent session ${input.status}`],
    );
    return { id: sessionId, status: input.status };
  }

  async finalizeAgentWork(
    principal: Principal,
    input: FinalizeAgentWorkInput,
  ): Promise<FinalizedAgentWork> {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      const scope = `mission:finalize-agent-work:${input.missionId}`;
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      await q(
        `INSERT INTO idempotency_records(scope,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [scope, input.idempotencyKey, requestHash],
      );
      const replay = await q<{ requestHash: string; response: FinalizedAgentWork | null }>(
        `SELECT request_hash AS "requestHash",response FROM idempotency_records WHERE scope=$1 AND key=$2 FOR UPDATE`,
        [scope, input.idempotencyKey],
      );
      if (replay.rows[0]!.requestHash !== requestHash)
        throw new ConflictException({ code: "AGENT_WORK_FINALIZATION_IDEMPOTENCY_CONFLICT" });
      if (replay.rows[0]!.response) return { ...replay.rows[0]!.response, replayed: true };
      const mission = await q<{ status: string; revision: number }>(
        `SELECT m.status,m.revision FROM missions m JOIN projects p ON p.id=m.project_id
         WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2) FOR UPDATE OF m`,
        [input.missionId, workspaceId(principal)],
      );
      if (!mission.rowCount) throw new NotFoundException("Mission not found");
      if (["completed", "failed", "cancelled"].includes(mission.rows[0]!.status))
        throw new ConflictException({ code: "MISSION_TERMINAL" });
      if (mission.rows[0]!.revision !== input.expectedMissionRevision)
        throw new ConflictException({
          code: "MISSION_REVISION_CONFLICT",
          actualRevision: mission.rows[0]!.revision,
        });
      if (mission.rows[0]!.status === "awaiting_user" && input.kind === "terminal_objective")
        throw new ConflictException({
          code: "AWAITING_USER_IS_NON_TERMINAL",
          terminal: false,
          sameMissionResumable: true,
          sameObjectiveResumable: true,
          shouldPublishFinalReport: false,
          safeActions: ["get_operating_context", "resume_mission", "cancel_mission_orchestration"],
        });
      if (input.kind === "await_user" && !input.pointer.externalInput?.fulfillmentPaths.length)
        throw new ConflictException({ code: "HUMAN_FULFILLMENT_PATH_REQUIRED" });
      const session = await q(
        `SELECT id FROM agent_sessions WHERE id=$1 AND mission_id=$2 AND status='active' FOR UPDATE`,
        [input.agentSessionId, input.missionId],
      );
      if (!session.rowCount)
        throw new ConflictException({ code: "ACTIVE_AGENT_SESSION_NOT_FOUND" });
      const objective = await q<{ status: string }>(
        `SELECT status FROM mission_objectives WHERE id=$1 AND mission_id=$2 FOR UPDATE`,
        [input.objectiveId, input.missionId],
      );
      if (!objective.rowCount) throw new ConflictException({ code: "OBJECTIVE_NOT_FOUND" });
      const authoring = await q<{
        state: string;
        decisionBoundary: { reasonCode?: string } | null;
      }>(
        `SELECT state,decision_boundary AS "decisionBoundary" FROM adaptive_sessions WHERE mission_id=$1
          AND (objective_id=$2 OR active_objective_id=$2) FOR UPDATE`,
        [input.missionId, input.objectiveId],
      );
      if (
        authoring.rows.some(
          ({ state, decisionBoundary }) =>
            !["completed", "failed", "cancelled"].includes(state) &&
            !(
              state === "recovery_required" &&
              decisionBoundary?.reasonCode === "ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED"
            ),
        )
      )
        throw new ConflictException({ code: "MISSION_AUTHORING_CLOSE_REQUIRED" });
      const unsafe = await q(
        `SELECT 1 FROM adaptive_operations o
        WHERE o.mission_id=$1 AND o.objective_id=$2
          AND (o.state='running' OR (o.mutation_outcome='unknown' AND adaptive_operation_unknown_unresolved(o.session_id,o.operation_id))) LIMIT 1 FOR UPDATE`,
        [input.missionId, input.objectiveId],
      );
      if (unsafe.rowCount)
        throw new ConflictException({
          code: "MISSION_AUTHORING_CLOSE_RECONCILIATION_REQUIRED",
          mutationOutcome: "unknown",
          retry: "reconciliation_required",
        });
      let missionStatus: "planning" | "running" | "blocked" | "awaiting_user";
      let objectiveStatus: FinalizedAgentWork["objectiveStatus"];
      let agentSessionStatus: FinalizedAgentWork["agentSessionStatus"];
      if (input.kind === "await_user") {
        if (
          input.pointer.objectiveId !== input.objectiveId ||
          input.pointer.externalInput?.resumeRef !== input.objectiveId
        )
          throw new ConflictException({ code: "MISSION_RESUME_POINTER_OBJECTIVE_MISMATCH" });
        if (["passed", "failed", "blocked", "skipped"].includes(objective.rows[0]!.status))
          throw new ConflictException({ code: "TERMINAL_OBJECTIVE_CANNOT_AWAIT_USER" });
        await q(
          `UPDATE missions SET status='awaiting_user',resume_pointer=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1`,
          [input.missionId, JSON.stringify(input.pointer)],
        );
        missionStatus = "awaiting_user";
        objectiveStatus = objective.rows[0]!.status as FinalizedAgentWork["objectiveStatus"];
        agentSessionStatus = "interrupted";
      } else {
        const orchestration = await q<{ mode: string }>(
          `SELECT b.mode FROM mission_objective_orchestration x
           JOIN mission_execution_plans ep ON ep.id=x.plan_id AND ep.status IN ('active','paused')
           JOIN mission_execution_bindings b ON b.plan_id=x.plan_id AND b.objective_id=x.objective_id
           WHERE x.objective_id=$1`,
          [input.objectiveId],
        );
        if (
          input.objectiveStatus === "passed" &&
          orchestration.rowCount &&
          orchestration.rows[0]!.mode !== "manual"
        )
          throw new ConflictException({ code: "AUTOMATED_OBJECTIVE_REQUIRES_ACCEPTED_EVIDENCE" });
        await q(
          `UPDATE mission_objectives SET status=$3,conclusion=$4,updated_at=now() WHERE id=$1 AND mission_id=$2`,
          [input.objectiveId, input.missionId, input.objectiveStatus, input.conclusion],
        );
        await q(
          `UPDATE missions SET status=CASE WHEN status='awaiting_user' THEN 'running' ELSE status END,
          resume_pointer=CASE WHEN resume_pointer->>'objectiveId'=$2 THEN NULL ELSE resume_pointer END,
          revision=revision+1,updated_at=now() WHERE id=$1`,
          [input.missionId, input.objectiveId],
        );
        if (orchestration.rowCount)
          await q(
            `UPDATE mission_objective_orchestration SET
            state=CASE WHEN $2='passed' THEN 'passed' WHEN $2='failed' THEN 'failed' ELSE 'blocked' END,
            blocker_code=CASE WHEN $2='passed' THEN NULL ELSE blocker_code END,updated_at=now()
            WHERE objective_id=$1`,
            [input.objectiveId, input.objectiveStatus],
          );
        missionStatus =
          mission.rows[0]!.status === "awaiting_user"
            ? "running"
            : (mission.rows[0]!.status as typeof missionStatus);
        objectiveStatus = input.objectiveStatus;
        agentSessionStatus = input.sessionStatus;
      }
      await q(`UPDATE agent_sessions SET status=$2,ended_at=now() WHERE id=$1`, [
        input.agentSessionId,
        agentSessionStatus,
      ]);
      await q(
        `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES
        ($1,$2,$3,$4,$5,$6::jsonb),($1,$2,$3,'agent_session_ended',$7,'{}'::jsonb)`,
        [
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          input.kind === "await_user" ? "mission_awaiting_user" : "objective_updated",
          input.kind === "await_user"
            ? "Mission awaiting user input"
            : `Objective updated: ${objectiveStatus}`,
          JSON.stringify({ status: objectiveStatus }),
          `Agent session ${agentSessionStatus}`,
        ],
      );
      const response: FinalizedAgentWork = {
        replayed: false,
        missionId: input.missionId,
        objectiveId: input.objectiveId,
        missionStatus,
        objectiveStatus,
        agentSessionStatus,
        ...(input.kind === "await_user"
          ? {
              awaitingUser: {
                terminal: false,
                taskStillActive: true,
                sameMissionResumable: true,
                sameObjectiveResumable: true,
                shouldFinalize: false,
                shouldPublishFinalReport: false,
                shouldCreateReplacementMission: false,
                requiredNextStep: "fulfill_human_prerequisite_then_resume" as const,
              },
            }
          : {}),
      };
      await q(
        `UPDATE idempotency_records SET response=$3::jsonb,completed_at=now() WHERE scope=$1 AND key=$2`,
        [scope, input.idempotencyKey, JSON.stringify(response)],
      );
      return response;
    });
  }

  async createObjective(principal: Principal, missionId: string, input: CreateObjectiveInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      await this.requireContext(query, principal, missionId, input.agentSessionId);
      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
      await this.validateDependencies(query, missionId, input.dependencies);
      const id = randomUUID();
      await query(
        `INSERT INTO mission_objectives(id,mission_id,title,description,dependencies,completion_criteria,objective_order) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
        [
          id,
          missionId,
          input.title,
          input.description,
          JSON.stringify(input.dependencies),
          JSON.stringify(input.completionCriteria),
          input.order,
        ],
      );
      await query(
        `UPDATE missions SET current_objective_id=COALESCE(current_objective_id,$2),updated_at=now(),revision=revision+1 WHERE id=$1`,
        [missionId, id],
      );
      await this.activity(
        query,
        missionId,
        id,
        input.agentSessionId,
        "objective_created",
        `Objective created: ${input.title}`,
        {},
      );
      return { id, missionId, status: "pending", order: input.order };
    });
  }

  async updateObjective(principal: Principal, objectiveId: string, input: UpdateObjectiveInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      const mission = await this.requireContext(
        q,
        principal,
        input.missionId,
        input.agentSessionId,
        objectiveId,
      );
      if (
        mission.status === "awaiting_user" &&
        input.status &&
        ["passed", "failed", "blocked", "skipped"].includes(input.status)
      )
        throw new ConflictException({
          code: "AWAITING_USER_IS_NON_TERMINAL",
          terminal: false,
          sameMissionResumable: true,
          sameObjectiveResumable: true,
          shouldPublishFinalReport: false,
          safeActions: ["get_operating_context", "resume_mission", "cancel_mission_orchestration"],
        });
      const orchestration = await q<{ mode: string; state: string }>(
        `SELECT b.mode,x.state FROM mission_objective_orchestration x JOIN mission_execution_plans ep ON ep.id=x.plan_id AND ep.status IN ('active','paused') JOIN mission_execution_bindings b ON b.plan_id=x.plan_id AND b.objective_id=x.objective_id WHERE x.objective_id=$1`,
        [objectiveId],
      );
      if (orchestration.rowCount && input.dependencies)
        throw new ConflictException({
          code: "ACTIVE_PLAN_REVISION_REQUIRED",
          message: "Replace the execution plan before changing dependencies.",
        });
      if (
        orchestration.rowCount &&
        input.status === "passed" &&
        orchestration.rows[0]!.mode !== "manual"
      )
        throw new ConflictException({ code: "AUTOMATED_OBJECTIVE_REQUIRES_ACCEPTED_EVIDENCE" });
      if (input.dependencies)
        await this.validateDependencies(q, input.missionId, input.dependencies, objectiveId);
      if (["blocked", "skipped"].includes(input.status ?? "") && !input.conclusion)
        throw new ConflictException({ code: "OBJECTIVE_CONCLUSION_REQUIRED" });
      const result = await q(
        `UPDATE mission_objectives SET title=COALESCE($2,title),description=COALESCE($3,description),dependencies=COALESCE($4::jsonb,dependencies),completion_criteria=COALESCE($5::jsonb,completion_criteria),objective_order=COALESCE($6,objective_order),status=COALESCE($7,status),conclusion=COALESCE($8,conclusion),updated_at=now() WHERE id=$1 AND mission_id=$9 RETURNING *`,
        [
          objectiveId,
          input.title ?? null,
          input.description ?? null,
          input.dependencies ? JSON.stringify(input.dependencies) : null,
          input.completionCriteria ? JSON.stringify(input.completionCriteria) : null,
          input.order ?? null,
          input.status ?? null,
          input.conclusion ?? null,
          input.missionId,
        ],
      );
      await q(`UPDATE missions SET updated_at=now(),revision=revision+1 WHERE id=$1`, [
        input.missionId,
      ]);
      const shouldSynchronizeOrchestration =
        orchestration.rowCount &&
        input.status &&
        (orchestration.rows[0]!.mode === "manual" ||
          ["failed", "blocked", "skipped"].includes(input.status));
      if (shouldSynchronizeOrchestration)
        await q(
          `UPDATE mission_objective_orchestration SET state=CASE WHEN $2='passed' THEN 'passed' WHEN $2='failed' THEN 'failed' WHEN $2 IN ('blocked','skipped') THEN 'blocked' ELSE state END,blocker_code=CASE WHEN $2='passed' THEN NULL ELSE blocker_code END,updated_at=now() WHERE objective_id=$1`,
          [objectiveId, input.status],
        );
      await this.activity(
        q,
        input.missionId,
        objectiveId,
        input.agentSessionId,
        "objective_updated",
        `Objective updated${input.status ? `: ${input.status}` : ""}`,
        { status: input.status },
      );
      return result.rows[0];
    });
  }

  async attachFlow(principal: Principal, missionId: string, input: AttachFlowInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      await this.requireContext(q, principal, missionId, input.agentSessionId, input.objectiveId);
      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
      const flow = await q(
        `SELECT f.id FROM flows f JOIN missions m ON m.project_id=f.project_id WHERE f.id=$1 AND m.id=$2`,
        [input.flowId, missionId],
      );
      if (!flow.rowCount) throw new NotFoundException("Flow not found in Mission project");
      await q(
        `INSERT INTO mission_flow_links(mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(mission_id,flow_id) DO UPDATE SET objective_id=EXCLUDED.objective_id,visibility=EXCLUDED.visibility,purpose=EXCLUDED.purpose,reason=EXCLUDED.reason,created_by_agent_session_id=EXCLUDED.created_by_agent_session_id`,
        [
          missionId,
          input.objectiveId,
          input.flowId,
          input.visibility,
          input.purpose,
          input.reason,
          input.agentSessionId,
        ],
      );
      const promoted = input.visibility === "reusable";
      if (promoted)
        await q(`UPDATE flows SET visibility='reusable',updated_at=now() WHERE id=$1`, [
          input.flowId,
        ]);
      await this.activity(
        q,
        missionId,
        input.objectiveId,
        input.agentSessionId,
        promoted ? "flow_promoted" : "flow_attached",
        promoted ? "Flow promoted to reusable library" : "Flow attached to Mission",
        { flowId: input.flowId, visibility: input.visibility, purpose: input.purpose },
      );
      return input;
    });
  }

  async classifyRun(principal: Principal, runId: string, input: ClassifyRunInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      await this.requireContext(q, principal, input.missionId, input.agentSessionId);
      const run = await q<{ objectiveId: string }>(
        `SELECT objective_id AS "objectiveId" FROM runs WHERE id=$1 AND mission_id=$2`,
        [runId, input.missionId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found in Mission");
      await q(
        `UPDATE mission_run_links SET role=$2,reason=$3,classified_by_agent_session_id=$4,updated_at=now() WHERE run_id=$1`,
        [runId, input.role, input.reason, input.agentSessionId],
      );
      if (input.role === "invalidated")
        await q(
          `UPDATE accepted_evidence SET invalidated_at=now() WHERE run_id=$1 AND invalidated_at IS NULL`,
          [runId],
        );
      if (input.role === "superseded")
        await q(
          `UPDATE accepted_evidence SET superseded_at=now() WHERE run_id=$1 AND superseded_at IS NULL`,
          [runId],
        );
      await this.activity(
        q,
        input.missionId,
        run.rows[0]!.objectiveId,
        input.agentSessionId,
        input.role === "invalidated"
          ? "evidence_invalidated"
          : input.role === "superseded"
            ? "evidence_superseded"
            : "run_classified",
        `Run classified as ${input.role}`,
        { runId, reason: input.reason },
      );
      return { runId, role: input.role };
    });
  }

  async acceptEvidence(principal: Principal, objectiveId: string, input: AcceptEvidenceInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      await this.requireContext(q, principal, input.missionId, input.agentSessionId, objectiveId);
      const run = await q(
        `SELECT id,state FROM runs WHERE id=$1 AND mission_id=$2 AND objective_id=$3`,
        [input.runId, input.missionId, objectiveId],
      );
      if (!run.rowCount) throw new NotFoundException("Run is not part of this objective");
      if (run.rows[0]!.state !== "passed")
        throw new ConflictException({
          code: "RUN_NOT_ACCEPTABLE",
          message: "Only passed Runs can be accepted.",
        });
      const canonicalAttempt = await q<{
        id: string;
        state: string;
      }>(
        `SELECT id,state
         FROM attempts
         WHERE run_id=$1
         ORDER BY attempt_number DESC,id DESC
         LIMIT 1`,
        [input.runId],
      );

      if (!canonicalAttempt.rowCount || canonicalAttempt.rows[0]!.state !== "passed")
        throw new ConflictException({
          code: "EVIDENCE_CANONICAL_ATTEMPT_UNAVAILABLE",
        });

      if (input.artifactIds.length) {
        const artifacts = await q(
          `SELECT id
           FROM artifacts
           WHERE attempt_id=$1
             AND id=ANY($2::uuid[])
             AND availability='available'
             AND privacy_classification IN ('safe','sanitized')`,
          [canonicalAttempt.rows[0]!.id, input.artifactIds],
        );

        if (artifacts.rowCount !== input.artifactIds.length)
          throw new ConflictException({
            code: "EVIDENCE_NOT_ADMISSIBLE",
          });
      }
      const incident = await q(
        `SELECT 1 FROM credential_incidents WHERE run_id=$1 AND state IN ('pending','failed','timed_out','manual_action_required') LIMIT 1`,
        [input.runId],
      );
      if (incident.rowCount) throw new ConflictException({ code: "UNRESOLVED_PRIVACY_INCIDENT" });
      await q(
        `UPDATE mission_run_links SET role='superseded',reason='Replaced by newly accepted evidence',classified_by_agent_session_id=$3,updated_at=now() WHERE run_id IN (SELECT run_id FROM accepted_evidence WHERE mission_id=$1 AND objective_id=$2 AND superseded_at IS NULL AND invalidated_at IS NULL)`,
        [input.missionId, objectiveId, input.agentSessionId],
      );
      await q(
        `UPDATE accepted_evidence SET superseded_at=now() WHERE mission_id=$1 AND objective_id=$2 AND superseded_at IS NULL AND invalidated_at IS NULL`,
        [input.missionId, objectiveId],
      );
      const artifacts = input.artifactIds.length ? input.artifactIds : [null];
      for (const artifactId of artifacts)
        await q(
          `INSERT INTO accepted_evidence(mission_id,objective_id,run_id,artifact_id,conclusion,accepted_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            input.missionId,
            objectiveId,
            input.runId,
            artifactId,
            input.conclusion,
            input.agentSessionId,
          ],
        );
      await q(
        `UPDATE mission_run_links SET role='accepted',reason=$2,classified_by_agent_session_id=$3,updated_at=now() WHERE run_id=$1`,
        [input.runId, input.conclusion, input.agentSessionId],
      );
      await q(
        `UPDATE mission_objectives SET status='passed',conclusion=$2,updated_at=now() WHERE id=$1`,
        [objectiveId, input.conclusion],
      );
      await q(
        `UPDATE mission_objective_orchestration SET state='passed',blocker_code=NULL,blocker_details='{}'::jsonb,active_run_id=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE objective_id=$1`,
        [objectiveId, input.runId],
      );
      await q(
        `UPDATE missions SET status=CASE WHEN status IN ('blocked','awaiting_user') AND resume_pointer->>'runId'=$2 THEN 'running' ELSE status END,resume_pointer=CASE WHEN resume_pointer->>'runId'=$2 THEN NULL ELSE resume_pointer END,updated_at=now(),revision=revision+1 WHERE id=$1`,
        [input.missionId, input.runId],
      );
      await this.activity(
        q,
        input.missionId,
        objectiveId,
        input.agentSessionId,
        "run_accepted",
        "Run accepted as objective evidence",
        { runId: input.runId, artifactCount: input.artifactIds.length },
      );
      return { objectiveId, runId: input.runId, status: "accepted" };
    });
  }

  async updateResumePointer(
    principal: Principal,
    missionId: string,
    input: UpdateResumePointerInput,
  ) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      await this.requireContext(
        q,
        principal,
        missionId,
        input.agentSessionId,
        input.pointer?.objectiveId,
      );
      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
      if (
        input.pointer?.recommendedAction === "await_user" &&
        !input.pointer.externalInput?.fulfillmentPaths.length
      )
        throw new ConflictException({ code: "HUMAN_FULFILLMENT_PATH_REQUIRED" });
      if (input.pointer?.recommendedAction === "await_user") {
        const objective = await q<{ status: string }>(
          `SELECT status FROM mission_objectives WHERE id=$1 AND mission_id=$2 FOR UPDATE`,
          [input.pointer.objectiveId, missionId],
        );
        if (!objective.rowCount) throw new ConflictException({ code: "OBJECTIVE_NOT_FOUND" });
        if (["passed", "failed", "blocked", "skipped"].includes(objective.rows[0]!.status))
          throw new ConflictException({ code: "TERMINAL_OBJECTIVE_CANNOT_AWAIT_USER" });
      }
      if (input.pointer?.flowId) {
        const found = await q(
          `SELECT 1 FROM mission_flow_links WHERE mission_id=$1 AND flow_id=$2`,
          [missionId, input.pointer.flowId],
        );
        if (!found.rowCount) throw new ConflictException({ code: "RESUME_TARGET_MISMATCH" });
      }
      if (input.pointer?.runId) {
        const found = await q(`SELECT 1 FROM runs WHERE mission_id=$1 AND id=$2`, [
          missionId,
          input.pointer.runId,
        ]);
        if (!found.rowCount) throw new ConflictException({ code: "RESUME_TARGET_MISMATCH" });
      }
      await q(
        `UPDATE missions SET resume_pointer=$2::jsonb,current_objective_id=$3,status=CASE WHEN $4 THEN 'awaiting_user' WHEN status='awaiting_user' THEN 'running' ELSE status END,updated_at=now(),revision=revision+1 WHERE id=$1`,
        [
          missionId,
          JSON.stringify(input.pointer),
          input.pointer?.objectiveId ?? null,
          input.pointer?.recommendedAction === "await_user",
        ],
      );
      await this.activity(
        q,
        missionId,
        input.pointer?.objectiveId ?? null,
        input.agentSessionId,
        "resume_pointer_updated",
        input.pointer?.explanation ?? "Resume pointer cleared",
        { recommendedAction: input.pointer?.recommendedAction },
      );
      return { missionId, resumePointer: input.pointer };
    });
  }

  async transition(
    principal: Principal,
    missionId: string,
    action: "resume" | "cancel" | "reopen",
    input: MissionTransitionInput,
  ) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      const m = await this.requireContext(q, principal, missionId, input.agentSessionId);
      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
      const allowed =
        action === "cancel"
          ? !["completed", "cancelled"].includes(m.status)
          : action === "reopen"
            ? ["completed", "failed", "cancelled"].includes(m.status)
            : !["completed", "cancelled"].includes(m.status);
      if (!allowed) throw new ConflictException({ code: "INVALID_MISSION_TRANSITION" });
      const status = action === "cancel" ? "cancelled" : "running";
      await q(
        `UPDATE missions SET status=$2,completed_at=CASE WHEN $2='cancelled' THEN now() ELSE NULL END,updated_at=now(),revision=revision+1 WHERE id=$1`,
        [missionId, status],
      );
      if (action === "reopen") {
        const latest = await q<{ id: string }>(
          `SELECT id FROM mission_execution_plans WHERE mission_id=$1 ORDER BY revision DESC LIMIT 1`,
          [missionId],
        );
        if (latest.rowCount) {
          const created = await q<{ id: string }>(
            `INSERT INTO mission_execution_plans(mission_id,revision,status,source_mission_revision,created_by_agent_session_id) SELECT mission_id,revision+1,'draft',$2,$3 FROM mission_execution_plans WHERE id=$1 RETURNING id`,
            [latest.rows[0]!.id, m.revision + 1, input.agentSessionId],
          );
          await q(
            `INSERT INTO mission_execution_bindings(plan_id,mission_id,objective_id,mode,flow_revision_id,environment_id,execution_settings,authorization_ids) SELECT $2,mission_id,objective_id,mode,flow_revision_id,environment_id,execution_settings,authorization_ids FROM mission_execution_bindings WHERE plan_id=$1`,
            [latest.rows[0]!.id, created.rows[0]!.id],
          );
        }
      }
      await this.activity(
        q,
        missionId,
        null,
        input.agentSessionId,
        `mission_${action}d`,
        input.explanation,
        {},
      );
      return { missionId, status };
    });
  }

  async setRecordingSelection(
    principal: Principal,
    missionId: string,
    input: SetMissionRecordingSelectionInput,
  ) {
    this.requireWrite(principal);

    return this.database.transaction(async (client) => {
      const q = bindQuery(client);

      const mission = await this.requireContext(q, principal, missionId, input.agentSessionId);

      if (input.missionId !== missionId)
        throw new ConflictException({
          code: "MISSION_CONTEXT_MISMATCH",
        });

      const replay = await this.claimIdempotency(
        q,
        `mission:recording-selection:${missionId}`,
        input.idempotencyKey,
        input,
      );

      if (replay)
        return {
          ...(replay as Record<string, unknown>),
          replayed: true,
        };

      if (["completed", "failed", "cancelled"].includes(mission.status))
        throw new ConflictException({
          code: "MISSION_REOPEN_REQUIRED",
        });

      if (mission.revision !== input.expectedMissionRevision)
        throw new ConflictException({
          code: "MISSION_REVISION_CONFLICT",
          expectedRevision: input.expectedMissionRevision,
          actualRevision: mission.revision,
        });

      const orderedRunIds = [...input.orderedRunIds];

      if (new Set(orderedRunIds).size !== orderedRunIds.length)
        throw new ConflictException({
          code: "MISSION_RECORDING_SELECTION_DUPLICATE_RUN",
        });

      const runById = new Map<
        string,
        {
          id: string;
          objectiveId: string;
        }
      >();

      if (orderedRunIds.length) {
        const found = await q<{
          id: string;
          objectiveId: string;
        }>(
          `SELECT
             id,
             objective_id AS "objectiveId"
           FROM runs
           WHERE mission_id=$1
             AND id=ANY($2::uuid[])`,
          [missionId, orderedRunIds],
        );

        for (const row of found.rows) runById.set(row.id, row);

        if (runById.size !== orderedRunIds.length)
          throw new ConflictException({
            code: "MISSION_RECORDING_SELECTION_RUN_CONTEXT_MISMATCH",
          });
      } else {
        const existingRun = await q(
          `SELECT 1
           FROM runs
           WHERE mission_id=$1
           LIMIT 1`,
          [missionId],
        );

        if (existingRun.rowCount)
          throw new ConflictException({
            code: "MISSION_RECORDING_SELECTION_EMPTY_WITH_RUNS",
          });
      }

      const previous = await q<{ revision: number }>(
        `SELECT revision
         FROM mission_recording_selections
         WHERE mission_id=$1
         ORDER BY revision DESC
         LIMIT 1
         FOR UPDATE`,
        [missionId],
      );

      const selectionRevision = (previous.rows[0]?.revision ?? 0) + 1;
      const selectionId = randomUUID();

      await q(
        `UPDATE mission_recording_selections
         SET superseded_at=now()
         WHERE mission_id=$1
           AND superseded_at IS NULL`,
        [missionId],
      );

      await q(
        `INSERT INTO mission_recording_selections(
           id,
           mission_id,
           revision,
           source_mission_revision,
           selected_by_agent_session_id
         )
         VALUES($1,$2,$3,$4,$5)`,
        [selectionId, missionId, selectionRevision, mission.revision, input.agentSessionId],
      );

      for (const [runOrder, runId] of orderedRunIds.entries()) {
        const run = runById.get(runId);

        if (!run)
          throw new ConflictException({
            code: "MISSION_RECORDING_SELECTION_RUN_CONTEXT_MISMATCH",
          });

        await q(
          `INSERT INTO mission_recording_selection_runs(
             selection_id,
             mission_id,
             objective_id,
             run_id,
             run_order
           )
           VALUES($1,$2,$3,$4,$5)`,
          [selectionId, missionId, run.objectiveId, runId, runOrder],
        );
      }

      const updated = await q<{ revision: number }>(
        `UPDATE missions
         SET revision=revision+1,
             updated_at=now()
         WHERE id=$1
           AND revision=$2
         RETURNING revision`,
        [missionId, mission.revision],
      );

      if (!updated.rowCount)
        throw new ConflictException({
          code: "MISSION_REVISION_CONFLICT",
        });

      await this.activity(
        q,
        missionId,
        null,
        input.agentSessionId,
        "recording_selection_updated",
        `Mission recording selection revision ${selectionRevision} persisted`,
        {
          selectionId,
          selectionRevision,
          sourceMissionRevision: mission.revision,
          orderedRunIds,
        },
      );

      const response = {
        selectionId,
        missionId,
        selectionRevision,
        sourceMissionRevision: mission.revision,
        orderedRunIds,
        missionRevision: updated.rows[0]!.revision,
        replayed: false,
      };

      await this.completeIdempotency(
        q,
        `mission:recording-selection:${missionId}`,
        input.idempotencyKey,
        response,
      );

      return response;
    });
  }

  async previewReport(principal: Principal, missionId: string) {
    await this.requireMission((t, v) => this.database.query(t, v), principal, missionId, false);
    return this.buildReportSnapshot((t, v) => this.database.query(t, v), missionId, "", [], []);
  }

  async publishReport(principal: Principal, missionId: string, input: PublishMissionReportInput) {
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const q = bindQuery(client);
      const mission = await this.requireMission(q, principal, missionId, true);

      if (input.missionId !== missionId)
        throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });

      const scope = `mission:publish-report:${missionId}`;
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

      await q(
        `INSERT INTO idempotency_records(scope,key,request_hash)
         VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [scope, input.idempotencyKey, requestHash],
      );

      const replay = await q<{
        requestHash: string;
        response: Record<string, unknown> | null;
      }>(
        `SELECT request_hash AS "requestHash",response
         FROM idempotency_records
         WHERE scope=$1 AND key=$2
         FOR UPDATE`,
        [scope, input.idempotencyKey],
      );

      if (!replay.rowCount)
        throw new ConflictException({
          code: "MISSION_REPORT_IDEMPOTENCY_CLAIM_FAILED",
        });

      if (replay.rows[0]!.requestHash !== requestHash)
        throw new ConflictException({
          code: "MISSION_REPORT_IDEMPOTENCY_CONFLICT",
        });

      if (replay.rows[0]!.response)
        return {
          ...replay.rows[0]!.response,
          replayed: true,
        };

      if (["completed", "failed", "cancelled"].includes(mission.status))
        throw new ConflictException({ code: "MISSION_TERMINAL" });

      if (mission.revision !== input.expectedRevision)
        throw new ConflictException({
          code: "MISSION_REVISION_CONFLICT",
          actualRevision: mission.revision,
        });

      const agentSession = await q(
        `SELECT 1
         FROM agent_sessions
         WHERE id=$1
           AND mission_id=$2
           AND status='active'
         FOR UPDATE`,
        [input.agentSessionId, missionId],
      );

      if (!agentSession.rowCount)
        throw new ConflictException({
          code: "AGENT_SESSION_CONTEXT_INVALID",
        });

      if (mission.status === "awaiting_user")
        throw new ConflictException({
          code: "AWAITING_USER_REPORT_NOT_FINAL",
          terminal: false,
          sameMissionResumable: true,
          sameObjectiveResumable: true,
          shouldPublishFinalReport: false,
          safeActions: ["get_operating_context", "resume_mission", "cancel_mission_orchestration"],
        });
      const liveAuthoring = await q(
        `SELECT 1
         FROM adaptive_sessions
         WHERE mission_id=$1
           AND state NOT IN ('completed','failed','cancelled')
         LIMIT 1
         FOR UPDATE`,
        [missionId],
      );

      if (liveAuthoring.rowCount)
        throw new ConflictException({
          code: "MISSION_RUNTIME_CLOSE_REQUIRED",
        });

      const unresolvedOperations = await q(
        `SELECT 1
         FROM adaptive_operations o
         WHERE o.mission_id=$1
           AND (
             o.state='running'
             OR (
               o.mutation_outcome='unknown'
               AND adaptive_operation_unknown_unresolved(
                 o.session_id,
                 o.operation_id
               )
             )
           )
         LIMIT 1
         FOR UPDATE`,
        [missionId],
      );

      if (unresolvedOperations.rowCount)
        throw new ConflictException({
          code: "MISSION_RUNTIME_RECONCILIATION_REQUIRED",
          mutationOutcome: "unknown",
          retry: "reconciliation_required",
        });

      const liveRuns = await q(
        `SELECT 1
         FROM runs
         WHERE mission_id=$1
           AND state NOT IN (
             'passed',
             'failed',
             'cancelled',
             'timed_out',
             'infrastructure_error'
           )
         LIMIT 1
         FOR UPDATE`,
        [missionId],
      );

      if (liveRuns.rowCount)
        throw new ConflictException({
          code: "MISSION_RUNS_NOT_TERMINAL",
        });

      const openAttempts = await q(
        `SELECT 1
         FROM attempts a
         JOIN runs r
           ON r.id=a.run_id
         WHERE r.mission_id=$1
           AND a.completed_at IS NULL
         LIMIT 1
         FOR UPDATE OF a`,
        [missionId],
      );

      if (openAttempts.rowCount)
        throw new ConflictException({
          code: "MISSION_ATTEMPTS_NOT_TERMINAL",
        });

      const liveOrchestration = await q(
        `SELECT 1
         FROM mission_objective_orchestration
         WHERE mission_id=$1
           AND state NOT IN (
             'passed',
             'failed',
             'blocked',
             'cancelled'
           )
         LIMIT 1
         FOR UPDATE`,
        [missionId],
      );

      if (liveOrchestration.rowCount)
        throw new ConflictException({
          code: "MISSION_ORCHESTRATION_NOT_TERMINAL",
        });

      const incomplete = await q(
        `SELECT o.id,o.status,o.conclusion FROM mission_objectives o WHERE o.mission_id=$1 AND NOT ${reportableObjectivePredicate("o")}`,
        [missionId],
      );
      if (incomplete.rowCount)
        throw new ConflictException({ code: "MISSION_OBJECTIVES_NOT_TERMINAL" });
      const privacy = await q(
        `SELECT 1 FROM credential_incidents ci JOIN runs r ON r.id=ci.run_id JOIN accepted_evidence e ON e.run_id=r.id AND e.superseded_at IS NULL AND e.invalidated_at IS NULL WHERE e.mission_id=$1 AND ci.state IN ('pending','failed','timed_out','manual_action_required') LIMIT 1`,
        [missionId],
      );
      if (privacy.rowCount) throw new ConflictException({ code: "UNRESOLVED_PRIVACY_INCIDENT" });
      const snapshot = await this.buildReportSnapshot(
        q,
        missionId,
        input.overallConclusion,
        input.journeySummary,
        input.remainingActions,
        "completed",
      );
      const last = await q<{ revision: number }>(
        `SELECT revision FROM mission_reports WHERE mission_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [missionId],
      );
      const revision = (last.rows[0]?.revision ?? 0) + 1;
      await q(
        `UPDATE mission_reports SET status='superseded',superseded_at=now() WHERE mission_id=$1 AND status='published'`,
        [missionId],
      );
      const reportId = randomUUID();
      await q(
        `INSERT INTO mission_reports(id,mission_id,revision,snapshot,published_by_agent_session_id) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [reportId, missionId, revision, JSON.stringify(snapshot), input.agentSessionId],
      );
      await q(
        `UPDATE missions SET status='completed',final_report_id=$2,resume_pointer=NULL,completed_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1`,
        [missionId, reportId],
      );
      await this.activity(
        q,
        missionId,
        null,
        input.agentSessionId,
        "report_published",
        `Mission report revision ${revision} published`,
        { reportId, revision },
      );
      const response = {
        id: reportId,
        missionId,
        revision,
        status: "published" as const,
        snapshot,
        replayed: false,
      };

      await q(
        `UPDATE idempotency_records
         SET response=$3::jsonb,
             completed_at=now()
         WHERE scope=$1 AND key=$2`,
        [scope, input.idempotencyKey, JSON.stringify(response)],
      );

      return response;
    });
  }

  async listReports(principal: Principal, projectId: string) {
    await this.requireProject((t, v) => this.database.query(t, v), principal, projectId);
    return (
      await this.database.query(
        `SELECT r.id,r.mission_id AS "missionId",r.revision,r.status,r.snapshot,r.created_at AS "createdAt",m.title AS "missionTitle" FROM mission_reports r JOIN missions m ON m.id=r.mission_id WHERE m.project_id=$1 ORDER BY r.created_at DESC`,
        [projectId],
      )
    ).rows;
  }
  async getReport(principal: Principal, reportId: string) {
    const result = await this.database.query(
      `SELECT r.id,r.mission_id AS "missionId",r.revision,r.status,r.snapshot,r.created_at AS "createdAt" FROM mission_reports r JOIN missions m ON m.id=r.mission_id JOIN projects p ON p.id=m.project_id WHERE r.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`,
      [reportId, workspaceId(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Mission report not found");
    return result.rows[0];
  }

  private async buildReportSnapshot(
    query: Query,
    missionId: string,
    overallConclusion: string,
    journeySummary: string[],
    remainingActions: string[],
    finalStatus?: string,
  ) {
    const missionResult = await query<{
      id: string;
      revision: number;
      title: string;
      originalInstruction: string;
      status: string;
    }>(
      `SELECT
         id,
         revision,
         title,
         original_instruction AS "originalInstruction",
         status
       FROM missions
       WHERE id=$1`,
      [missionId],
    );

    const mission = missionResult.rows[0]!;

    const objectives = await query<{
      id: string;
      title: string;
      status: string;
      conclusion: string | null;
      order: number;
    }>(
      `SELECT
         o.id,
         o.title,
         o.status,
         o.conclusion,
         o.objective_order AS "order"
       FROM mission_objectives o
       WHERE o.mission_id=$1
       ORDER BY o.objective_order,o.id`,
      [missionId],
    );

    const accepted = await query<{
      id: string;
      objectiveId: string;
      runId: string;
      artifactId: string | null;
      acceptanceConclusion: string;
      acceptedByAgentSessionId: string;
      acceptedAt: string;
      runState: string;
      runOutcomeClassification: string | null;
      runResultClassification: string | null;
      runReliabilityEligible: boolean;
      runFlowRevisionId: string;
      runEnvironmentId: string;
      runExecutionModel: string | null;
      runCreatedAt: string;
      runUpdatedAt: string;
      canonicalAttemptId: string;
      canonicalAttemptRunId: string;
      canonicalAttemptNumber: number;
      canonicalAttemptState: string;
      canonicalAttemptStartedAt: string | null;
      canonicalAttemptCompletedAt: string | null;
      artifactAttemptId: string | null;
      artifactKind: string | null;
      artifactAvailability: string | null;
      artifactPrivacyClassification: string | null;
      artifactContentType: string | null;
      artifactSizeBytes: string | null;
      artifactChecksumSha256: string | null;
      artifactContextId: string | null;
      artifactCaptureEpoch: number | null;
      artifactRetentionUntil: string | null;
      artifactCreatedAt: string | null;
    }>(
      `SELECT
         e.id::text AS id,
         e.objective_id::text AS "objectiveId",
         e.run_id::text AS "runId",
         e.artifact_id::text AS "artifactId",
         e.conclusion AS "acceptanceConclusion",
         e.accepted_by_agent_session_id::text
           AS "acceptedByAgentSessionId",
         e.accepted_at::text AS "acceptedAt",

         r.state AS "runState",
         r.outcome_classification
           AS "runOutcomeClassification",
         r.result_classification
           AS "runResultClassification",
         r.reliability_eligible
           AS "runReliabilityEligible",
         r.flow_revision_id::text
           AS "runFlowRevisionId",
         r.environment_id::text
           AS "runEnvironmentId",
         r.execution_snapshot->>'executionModel'
           AS "runExecutionModel",
         r.created_at::text AS "runCreatedAt",
         r.updated_at::text AS "runUpdatedAt",

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
           AS "canonicalAttemptCompletedAt",

         a.attempt_id::text
           AS "artifactAttemptId",
         a.kind AS "artifactKind",
         a.availability
           AS "artifactAvailability",
         a.privacy_classification
           AS "artifactPrivacyClassification",
         a.content_type
           AS "artifactContentType",
         a.size_bytes::text
           AS "artifactSizeBytes",
         a.checksum_sha256
           AS "artifactChecksumSha256",
         a.context_id::text
           AS "artifactContextId",
         a.capture_epoch
           AS "artifactCaptureEpoch",
         a.retention_until::text
           AS "artifactRetentionUntil",
         a.created_at::text
           AS "artifactCreatedAt"

       FROM accepted_evidence e

       JOIN runs r
         ON r.id=e.run_id
        AND r.mission_id=e.mission_id
        AND r.objective_id=e.objective_id

       JOIN LATERAL (
         SELECT
           att.id,
           att.run_id,
           att.attempt_number,
           att.state,
           att.started_at,
           att.completed_at
         FROM attempts att
         WHERE att.run_id=e.run_id
         ORDER BY
           att.attempt_number DESC,
           att.id DESC
         LIMIT 1
       ) canonical ON true

       LEFT JOIN artifacts a
         ON a.id=e.artifact_id

       WHERE e.mission_id=$1
         AND e.superseded_at IS NULL
         AND e.invalidated_at IS NULL

       ORDER BY
         e.objective_id,
         e.accepted_at,
         e.id`,
      [missionId],
    );

    const superseded = await query<{
      count: number;
    }>(
      `SELECT COUNT(*)::int AS count
       FROM attempts a
       JOIN runs r
         ON r.id=a.run_id
       WHERE r.mission_id=$1
         AND EXISTS (
           SELECT 1
           FROM attempts newer
           WHERE newer.run_id=a.run_id
             AND newer.attempt_number >
                 a.attempt_number
         )`,
      [missionId],
    );

    const composition = composeMissionEvidence({
      missionId,
      sourceMissionRevision: mission.revision,
      objectives: objectives.rows.map((objective) => ({
        objectiveId: objective.id,
        order: objective.order,
      })),
      acceptedEvidence: accepted.rows.map((row) => ({
        id: row.id,
        objectiveId: row.objectiveId,
        runId: row.runId,
        artifactId: row.artifactId,
        acceptanceConclusion: row.acceptanceConclusion,
        acceptedByAgentSessionId: row.acceptedByAgentSessionId,
        acceptedAt: row.acceptedAt,
        run: {
          id: row.runId,
          state: row.runState,
          outcomeClassification: row.runOutcomeClassification,
          resultClassification: row.runResultClassification,
          reliabilityEligible: row.runReliabilityEligible,
          flowRevisionId: row.runFlowRevisionId,
          environmentId: row.runEnvironmentId,
          executionModel: row.runExecutionModel,
          createdAt: row.runCreatedAt,
          updatedAt: row.runUpdatedAt,
        },
        canonicalAttempt: {
          id: row.canonicalAttemptId,
          runId: row.canonicalAttemptRunId,
          attemptNumber: row.canonicalAttemptNumber,
          state: row.canonicalAttemptState,
          startedAt: row.canonicalAttemptStartedAt,
          completedAt: row.canonicalAttemptCompletedAt,
        },
        artifact: row.artifactId
          ? {
              id: row.artifactId,
              attemptId: row.artifactAttemptId!,
              kind: row.artifactKind!,
              availability: row.artifactAvailability!,
              privacyClassification: row.artifactPrivacyClassification!,
              contentType: row.artifactContentType!,
              sizeBytes: row.artifactSizeBytes,
              checksumSha256: row.artifactChecksumSha256,
              contextId: row.artifactContextId,
              captureEpoch: row.artifactCaptureEpoch,
              retentionUntil: row.artifactRetentionUntil,
              createdAt: row.artifactCreatedAt!,
            }
          : null,
      })),
      supersededAttemptCount: superseded.rows[0]?.count ?? 0,
    });

    const compositionByObjective = new Map(
      composition.objectives.map((objective) => [objective.objectiveId, objective]),
    );

    const resolvedRecording = await resolveMissionRecording(query, missionId);

    return {
      mission: {
        id: mission.id,
        title: mission.title,
        originalInstruction: mission.originalInstruction,
        status: finalStatus ?? mission.status,
        sourceRevision: mission.revision,
      },

      overallConclusion,
      journeySummary,
      remainingActions,

      objectiveResults: objectives.rows.map((objective) => {
        const evidence = compositionByObjective.get(objective.id);

        return {
          id: objective.id,
          title: objective.title,
          status: objective.status,
          conclusion: objective.conclusion,
          acceptedRunIds: evidence?.acceptedRunIds ?? [],
          acceptedArtifactIds: evidence?.acceptedArtifactIds ?? [],
        };
      }),

      evidence: composition,
      evidenceDigest: composition.evidenceDigest,

      recordingSelection: resolvedRecording.selection,
      recording: resolvedRecording.recording,
      recordingDigest: resolvedRecording.recording?.recordingDigest ?? null,

      supersededAttemptCount: composition.supersededAttemptCount,

      generatedAt: new Date().toISOString(),
    };
  }

  private async validateDependencies(q: Query, missionId: string, ids: string[], self?: string) {
    if (ids.includes(self ?? ""))
      throw new ConflictException({ code: "OBJECTIVE_SELF_DEPENDENCY" });
    if (!ids.length) return;
    const found = await q(
      `SELECT id FROM mission_objectives WHERE mission_id=$1 AND id=ANY($2::uuid[])`,
      [missionId, ids],
    );
    if (found.rowCount !== new Set(ids).size)
      throw new ConflictException({ code: "OBJECTIVE_DEPENDENCY_MISMATCH" });
    if (self) {
      const cycle = await q(
        `WITH RECURSIVE dependency_tree(id) AS (
      SELECT value::uuid FROM mission_objectives o,jsonb_array_elements_text(o.dependencies) value WHERE o.mission_id=$1 AND o.id=ANY($2::uuid[])
      UNION SELECT value::uuid FROM mission_objectives o JOIN dependency_tree tree ON o.id=tree.id,jsonb_array_elements_text(o.dependencies) value WHERE o.mission_id=$1
    ) SELECT 1 FROM dependency_tree WHERE id=$3 LIMIT 1`,
        [missionId, ids, self],
      );
      if (cycle.rowCount) throw new ConflictException({ code: "OBJECTIVE_DEPENDENCY_CYCLE" });
    }
  }
  private async requireContext(
    q: Query,
    principal: Principal,
    missionId: string,
    sessionId: string,
    objectiveId?: string,
  ) {
    const m = await this.requireMission(q, principal, missionId, true);
    const session = await q(
      `SELECT 1 FROM agent_sessions WHERE id=$1 AND mission_id=$2 AND status='active'`,
      [sessionId, missionId],
    );
    if (!session.rowCount) throw new ConflictException({ code: "AGENT_SESSION_CONTEXT_INVALID" });
    if (objectiveId) {
      const objective = await q(`SELECT 1 FROM mission_objectives WHERE id=$1 AND mission_id=$2`, [
        objectiveId,
        missionId,
      ]);
      if (!objective.rowCount) throw new ConflictException({ code: "OBJECTIVE_CONTEXT_MISMATCH" });
    }
    return m;
  }
  private async requireProject(q: Query, principal: Principal, id: string) {
    const r = await q(
      `SELECT 1 FROM projects WHERE id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)`,
      [id, workspaceId(principal)],
    );
    if (!r.rowCount) throw new NotFoundException("Project not found");
  }
  private async requireMission(q: Query, principal: Principal, id: string, lock: boolean) {
    const r = await q<{ id: string; projectId: string; status: string; revision: number }>(
      `SELECT m.id,m.project_id AS "projectId",m.status,m.revision FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2) ${lock ? "FOR UPDATE OF m" : ""}`,
      [id, workspaceId(principal)],
    );
    if (!r.rowCount) throw new NotFoundException("Mission not found");
    return r.rows[0]!;
  }
  private activity(
    q: Query,
    missionId: string,
    objectiveId: string | null,
    sessionId: string | null,
    type: string,
    summary: string,
    metadata: unknown,
    technical = false,
  ) {
    return q(
      `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
      [missionId, objectiveId, sessionId, type, summary, JSON.stringify(metadata), technical],
    );
  }
  private async claimIdempotency(q: Query, scope: string, key: string, value: unknown) {
    const requestHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await q(
      `INSERT INTO idempotency_records(scope,key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [scope, key, requestHash],
    );
    const r = await q<{ requestHash: string; response?: unknown }>(
      `SELECT request_hash AS "requestHash",response FROM idempotency_records WHERE scope=$1 AND key=$2 FOR UPDATE`,
      [scope, key],
    );
    if (r.rows[0]!.requestHash !== requestHash)
      throw new ConflictException({ code: "IDEMPOTENCY_KEY_REUSED" });
    return r.rows[0]!.response;
  }
  private completeIdempotency(q: Query, scope: string, key: string, response: unknown) {
    return q(
      `UPDATE idempotency_records SET response=$3::jsonb,completed_at=now() WHERE scope=$1 AND key=$2`,
      [scope, key, JSON.stringify(response)],
    );
  }
  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer")
      throw new ForbiddenException("Workspace viewers have read-only access");
  }
}

type MissionProjectionRow = Record<string, unknown>;

function projectAgentMissionContext(value: MissionProjectionRow) {
  const mission = asRow(value);
  return compact({
    id: mission.id,
    projectId: mission.projectId,
    title: bounded(mission.title, 500),
    originalInstruction: bounded(mission.originalInstruction, 20_000),
    status: mission.status,
    currentObjectiveId: mission.currentObjectiveId,
    resumePointer: projectResumePointer(mission.resumePointer),
    finalReportId: mission.finalReportId,
    latestReportId: mission.latestReportId,
    revision: mission.revision,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    completedAt: mission.completedAt,
    objectiveCount: mission.objectiveCount,
    terminalObjectiveCount: mission.terminalObjectiveCount,
    acceptedEvidenceCount: mission.acceptedEvidenceCount,
    objectives: rows(mission.objectives, 100).map((item) =>
      compact({
        id: item.id,
        title: bounded(item.title, 500),
        description: bounded(item.description, 2_000),
        status: item.status,
        dependencies: scalarList(item.dependencies, 100),
        completionCriteria: rows(item.completionCriteria, 100).map((criterion) =>
          compact({
            description: bounded(criterion.description, 2_000),
            required: criterion.required,
          }),
        ),
        conclusion: bounded(item.conclusion, 5_000),
        order: item.order,
        latestCandidateRunId: item.latestCandidateRunId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        orchestrationState: item.orchestrationState,
        blockerCode: bounded(item.blockerCode, 200),
        activeRunId: item.activeRunId,
        executionMode: item.executionMode,
      }),
    ),
    flows: rows(mission.flows, 250).map((item) =>
      compact({
        objectiveId: item.objectiveId,
        visibility: item.visibility,
        purpose: item.purpose,
        reason: bounded(item.reason, 2_000),
        id: item.id,
        name: bounded(item.name, 500),
        description: bounded(item.description, 2_000),
        latestRevisionId: item.latestRevisionId,
        latestRevision: item.latestRevision,
      }),
    ),
    runs: rows(mission.runs, 500).map((item) =>
      compact({
        id: item.id,
        objectiveId: item.objectiveId,
        flowId: item.flowId,
        flowName: bounded(item.flowName, 500),
        availableEvidenceCount: item.availableEvidenceCount,
        state: item.state,
        phase: item.phase,
        outcomeClassification: item.outcomeClassification,
        resultClassification: item.resultClassification,
        reliabilityEligible: item.reliabilityEligible,
        compiledContractId: item.compiledContractId,
        role: item.role,
        reason: bounded(item.reason, 2_000),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }),
    ),
    acceptedEvidence: rows(mission.acceptedEvidence, 500).map((item) =>
      compact({
        id: item.id,
        objectiveId: item.objectiveId,
        runId: item.runId,
        artifactId: item.artifactId,
        conclusion: bounded(item.conclusion, 10_000),
        acceptedAt: item.acceptedAt,
        supersededAt: item.supersededAt,
        invalidatedAt: item.invalidatedAt,
      }),
    ),
    reports: rows(mission.reports, 100).map((item) =>
      compact({
        id: item.id,
        revision: item.revision,
        status: item.status,
        createdAt: item.createdAt,
        supersededAt: item.supersededAt,
      }),
    ),
    authoring: rows(mission.authoring, 250).map((item) =>
      compact({
        id: item.id,
        objectiveId: item.objectiveId,
        name: bounded(item.name, 500),
        state: item.state,
        version: item.version,
        updatedAt: item.updatedAt,
        probes: rows(item.probes, 100).map((probe) =>
          compact({
            id: probe.id,
            level: probe.level,
            state: probe.state,
            draftVersion: probe.draftVersion,
            createdAt: probe.createdAt,
          }),
        ),
        compilations: rows(item.compilations, 100).map((compilation) =>
          compact({
            id: compilation.id,
            status: compilation.status,
            draftVersion: compilation.draftVersion,
            createdAt: compilation.createdAt,
          }),
        ),
      }),
    ),
    flowProgress: mission.flowProgress,
  });
}

function projectResumePointer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return value === null ? null : undefined;
  const pointer = asRow(value);
  return compact({
    objectiveId: pointer.objectiveId,
    recommendedAction: pointer.recommendedAction,
    flowId: pointer.flowId,
    revisionId: pointer.revisionId,
    runId: pointer.runId,
    explanation: bounded(pointer.explanation, 2_000),
    externalInput: projectExternalInput(pointer.externalInput),
  });
}

function projectExternalInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = asRow(value);
  const authority = asRow(input.authority);
  const continuation = asRow(input.continuation);
  const fulfillmentPaths = rows(input.fulfillmentPaths, 10);
  return compact({
    condition: input.condition,
    cause: bounded(input.cause, 2_000),
    affectedOperation: bounded(input.affectedOperation, 500),
    affectedResource: bounded(input.affectedResource, 500),
    effectState: input.effectState,
    authority: compact({
      required: authority.required,
      type: authority.type,
      reason: bounded(authority.reason, 2_000),
    }),
    availableCapabilities: scalarList(input.availableCapabilities, 20),
    fulfillmentPaths: fulfillmentPaths.map((path) => {
      const pathContinuation = asRow(path.continuation);
      return compact({
        kind: path.kind,
        humanAction: bounded(path.humanAction, 1_000),
        agentExposure: path.agentExposure,
        result: bounded(path.result, 1_000),
        availableCapabilities: scalarList(path.availableCapabilities, 10),
        ...(Array.isArray(path.dashboardPath)
          ? { dashboardPath: scalarList(path.dashboardPath, 10) }
          : {}),
        continuation: {
          sameMission: pathContinuation.sameMission,
          sameObjective: pathContinuation.sameObjective,
          replacementMissionRequired: pathContinuation.replacementMissionRequired,
          resumeWith: pathContinuation.resumeWith,
        },
      });
    }),
    constraints: scalarList(input.constraints, 50),
    consequences: scalarList(input.consequences, 50),
    continuation: compact({
      retryCurrentOperation: continuation.retryCurrentOperation,
      freshObservationRequired: continuation.freshObservationRequired,
      newOperationRequired: continuation.newOperationRequired,
      newDraftRequired: continuation.newDraftRequired,
      newSessionRequired: continuation.newSessionRequired,
    }),
    waiting: input.waiting,
    terminal: input.terminal,
    lifecycle: {
      terminal: false,
      taskStillActive: true,
      sameMissionResumable: true,
      sameObjectiveResumable: true,
      shouldFinalize: false,
      shouldPublishFinalReport: false,
      shouldCreateReplacementMission: false,
      requiredNextStep: "fulfill_human_prerequisite_then_resume",
    },
    resumeRef: input.resumeRef,
  });
}

function asRow(value: unknown): MissionProjectionRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MissionProjectionRow)
    : {};
}

function rows(value: unknown, maximum: number) {
  return Array.isArray(value) ? value.slice(0, maximum).map(asRow) : [];
}

function scalarList(value: unknown, maximum: number) {
  return Array.isArray(value)
    ? value
        .filter(
          (item) =>
            typeof item === "string" || typeof item === "number" || typeof item === "boolean",
        )
        .slice(0, maximum)
    : [];
}

function bounded(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function compact<T extends MissionProjectionRow>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function bindQuery(client: PoolClient): Query {
  return (text, values = []) => client.query(text, values);
}
function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}
