import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { ActivateExecutionPlanInput, CreateExecutionPlanInput, GrantMissionAuthorizationInput, OrchestrationControlInput, StartReadyObjectivesInput } from "@scry/contracts";
import type { PoolClient } from "pg";
import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";
import { executionPolicySchema } from "@scry/contracts";
import { snapshotVeilPolicy } from "./veil-policy-snapshot.js";

const ACTIVE = ["queued", "running"];
const TERMINAL_RUNS = ["passed", "failed", "cancelled", "timed_out", "infrastructure_error"];
const workspaceId = (p: Principal) => p.kind === "user" ? p.workspaceId : null;

@Injectable()
export class OrchestrationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(@Inject(Database) private readonly db: Database) {}

  async onModuleInit() {
    if (process.env.SCRY_ORCHESTRATION_ENABLED !== "true") return;
    await this.tick().catch(() => undefined);
    this.timer = setInterval(() => void this.tick().catch(() => undefined), Number(process.env.SCRY_ORCHESTRATION_INTERVAL_MS ?? 1_000));
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private write(p: Principal) { if (p.kind === "user" && p.role === "viewer") throw new ForbiddenException("Write access required"); }

  async createPlan(p: Principal, missionId: string, input: CreateExecutionPlanInput) {
    this.write(p);
    if (input.missionId !== missionId) throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [missionId]);
      const mission = await c.query<{ project_id: string; revision: number }>(`SELECT m.project_id,m.revision FROM missions m JOIN projects p ON p.id=m.project_id WHERE m.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)`, [missionId, workspaceId(p)]);
      if (!mission.rowCount) throw new NotFoundException("Mission not found");
      await this.requireSession(c, missionId, input.agentSessionId);
      const replay=await c.query<{id:string;revision:number;status:string}>(`SELECT id,revision,status FROM mission_execution_plans WHERE mission_id=$1 AND idempotency_key=$2`,[missionId,input.idempotencyKey]);
      if(replay.rowCount)return{planId:replay.rows[0]!.id,revision:replay.rows[0]!.revision,status:replay.rows[0]!.status,replayed:true};
      const objectives = await c.query<{ id: string; dependencies: string[] }>(`SELECT id,dependencies FROM mission_objectives WHERE mission_id=$1`, [missionId]);
      const ids = new Set(objectives.rows.map((x) => x.id));
      if (input.bindings.length !== ids.size || input.bindings.some((x) => !ids.has(x.objectiveId)) || new Set(input.bindings.map((x) => x.objectiveId)).size !== ids.size) throw new ConflictException({ code: "PLAN_OBJECTIVE_COVERAGE_INVALID" });
      this.assertAcyclic(objectives.rows);
      for (const binding of input.bindings.filter((x) => x.mode === "automatic")) {
        const valid = await c.query(`SELECT 1 FROM flow_revisions fr JOIN flows f ON f.id=fr.flow_id JOIN environments e ON e.id=$2 JOIN flow_compilations fc ON fc.id=$4 AND fc.flow_revision_id=fr.id AND fc.environment_id=e.id AND fc.status='execution_ready' WHERE fr.id=$1 AND f.project_id=$3 AND e.project_id=$3 AND COALESCE((fr.validation->>'valid')::boolean,false)`, [binding.flowRevisionId, binding.environmentId, mission.rows[0]!.project_id,binding.compiledContractId]);
        if (!valid.rowCount) throw new ConflictException({ code: "EXECUTION_BINDING_INVALID" });
      }
      const next = await c.query<{ revision: number }>(`SELECT COALESCE(max(revision),0)+1 revision FROM mission_execution_plans WHERE mission_id=$1`, [missionId]);
      const plan = await c.query<{ id: string }>(`INSERT INTO mission_execution_plans(mission_id,revision,status,source_mission_revision,created_by_agent_session_id,idempotency_key) VALUES($1,$2,'draft',$3,$4,$5) RETURNING id`, [missionId, next.rows[0]!.revision, mission.rows[0]!.revision, input.agentSessionId,input.idempotencyKey]);
      for (const binding of input.bindings) await c.query(`INSERT INTO mission_execution_bindings(plan_id,mission_id,objective_id,mode,flow_revision_id,compiled_contract_id,environment_id,execution_settings,authorization_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [plan.rows[0]!.id, missionId, binding.objectiveId, binding.mode, binding.flowRevisionId ?? null,binding.compiledContractId??null, binding.environmentId ?? null, JSON.stringify({ browser: binding.browser, viewport: binding.viewport, seed: binding.seed }),JSON.stringify(binding.authorizationIds)]);
      await this.activity(c, missionId, input.agentSessionId, null, "Execution plan drafted", { planId: plan.rows[0]!.id, revision: next.rows[0]!.revision });
      return { planId: plan.rows[0]!.id, revision: next.rows[0]!.revision, status: "draft" };
    });
  }

  async validate(p: Principal, missionId: string, revision: number) {
    const plan = await this.db.query(`SELECT ep.id,ep.status,ep.source_mission_revision AS "sourceMissionRevision",m.revision AS "missionRevision" FROM mission_execution_plans ep JOIN missions m ON m.id=ep.mission_id JOIN projects p ON p.id=m.project_id WHERE ep.mission_id=$1 AND ep.revision=$2 AND ($3::uuid IS NULL OR p.workspace_id=$3)`, [missionId, revision, workspaceId(p)]);
    if (!plan.rowCount) throw new NotFoundException("Execution plan not found");
    const blockers = await this.bindingBlockers(this.db, String(plan.rows[0]!.id));
    return { ...plan.rows[0], valid: blockers.length === 0, blockers };
  }

  async activate(p: Principal, missionId: string, input: ActivateExecutionPlanInput) {
    this.write(p);
    if (input.missionId !== missionId) throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [missionId]);
      await this.requireSession(c, missionId, input.agentSessionId);
      const plan = await c.query<{ id: string; source_mission_revision: number; mission_revision: number }>(`SELECT ep.id,ep.source_mission_revision,m.revision mission_revision FROM mission_execution_plans ep JOIN missions m ON m.id=ep.mission_id WHERE ep.mission_id=$1 AND ep.revision=$2 AND ep.status='draft' FOR UPDATE OF ep,m`, [missionId, input.planRevision]);
      if (!plan.rowCount) throw new ConflictException({ code: "PLAN_NOT_ACTIVATABLE" });
      if(plan.rows[0]!.source_mission_revision!==plan.rows[0]!.mission_revision) throw new ConflictException({code:"STALE_EXECUTION_PLAN",sourceMissionRevision:plan.rows[0]!.source_mission_revision,currentMissionRevision:plan.rows[0]!.mission_revision});
      const blockers = await this.bindingBlockers(c, plan.rows[0]!.id);
      if (blockers.length) throw new ConflictException({ code: "PLAN_VALIDATION_FAILED", blockers });
      await c.query(`UPDATE mission_execution_plans SET status='superseded' WHERE mission_id=$1 AND status IN ('active','paused')`, [missionId]);
      await c.query(`UPDATE mission_execution_plans SET status='active',activated_at=now() WHERE id=$1`, [plan.rows[0]!.id]);
      const objectives = await c.query<{ id: string; dependencies: string[]; status: string }>(`SELECT id,dependencies,status FROM mission_objectives WHERE mission_id=$1`, [missionId]);
      this.assertAcyclic(objectives.rows);
      for (const objective of objectives.rows) {
        const state = ["passed", "failed", "blocked", "skipped"].includes(objective.status) ? (objective.status === "skipped" ? "cancelled" : objective.status) : "unscheduled";
        await c.query(`INSERT INTO mission_objective_orchestration(mission_id,objective_id,plan_id,state,blocker_code,blocker_details) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(objective_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,state=EXCLUDED.state,active_run_id=NULL,blocker_code=EXCLUDED.blocker_code,blocker_details=EXCLUDED.blocker_details,lease_token=NULL,lease_expires_at=NULL,updated_at=now()`, [missionId, objective.id, plan.rows[0]!.id, state, state === "unscheduled" ? "DEPENDENCIES_INCOMPLETE" : null, JSON.stringify({ dependencies: objective.dependencies })]);
      }
      await c.query(`UPDATE missions SET status='running',revision=revision+1,updated_at=now() WHERE id=$1`, [missionId]);
      await this.reconcileMission(c, missionId);
      await this.activity(c, missionId, input.agentSessionId, null, "Execution plan activated", { planId: plan.rows[0]!.id, revision: input.planRevision });
      return this.status(p, missionId, c);
    });
  }

  async status(p: Principal, missionId: string, client?: PoolClient) {
    const query = client ? client.query.bind(client) : this.db.query.bind(this.db);
    const rows = await query(`SELECT o.id,o.title,o.dependencies,o.status AS "objectiveStatus",x.state,x.blocker_code AS "blockerCode",x.blocker_details AS "blockerDetails",b.mode,b.flow_revision_id AS "flowRevisionId",b.compiled_contract_id AS "compiledContractId",b.environment_id AS "environmentId",x.active_run_id AS "activeRunId" FROM mission_objectives o JOIN missions m ON m.id=o.mission_id JOIN projects p ON p.id=m.project_id LEFT JOIN mission_objective_orchestration x ON x.objective_id=o.id LEFT JOIN mission_execution_bindings b ON b.plan_id=x.plan_id AND b.objective_id=o.id WHERE o.mission_id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2) ORDER BY o.objective_order`, [missionId, workspaceId(p)]);
    if (!rows.rowCount) throw new NotFoundException("Mission not found");
    return { missionId, concurrencyLimit: 3, activeSlots: rows.rows.filter((x: any) => ACTIVE.includes(x.state)).length, objectives: rows.rows };
  }

  async startReady(p: Principal, missionId: string, input: StartReadyObjectivesInput) {
    this.write(p);
    if (input.missionId !== missionId) throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
    await this.db.transaction((c) => this.scheduleProject(c, missionId, input.agentSessionId, input.objectiveIds));
    return this.status(p, missionId);
  }

  async control(p: Principal, missionId: string, action: "pause" | "resume" | "cancel", input: OrchestrationControlInput) {
    this.write(p);
    if (input.missionId !== missionId) throw new ConflictException({ code: "MISSION_CONTEXT_MISMATCH" });
    return this.db.transaction(async (c) => {
      await this.requireSession(c, missionId, input.agentSessionId);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [missionId]);
      const target = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
      const changed = await c.query(`UPDATE mission_execution_plans SET status=$2 WHERE mission_id=$1 AND status IN ('active','paused') RETURNING id`, [missionId, target]);
      if (!changed.rowCount&&action!=="cancel") throw new ConflictException({ code: "ORCHESTRATION_NOT_ACTIVE" });
      if (action === "cancel") {
        await c.query(`UPDATE missions SET status='cancelled',completed_at=now(),revision=revision+1,updated_at=now() WHERE id=$1`,[missionId]);
        await c.query(`UPDATE runs SET cancellation_requested_at=COALESCE(cancellation_requested_at,now()),updated_at=now() WHERE mission_id=$1 AND state NOT IN ('passed','failed','cancelled','timed_out','infrastructure_error')`, [missionId]);
        await c.query(`UPDATE mission_objective_orchestration SET state='cancelled',blocker_code='MISSION_CANCELLED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE mission_id=$1 AND state NOT IN ('passed','failed','awaiting_evidence')`, [missionId]);
      } else if (action === "resume") await this.reconcileMission(c, missionId);
      await this.activity(c, missionId, input.agentSessionId, null, `Orchestration ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}`, { reason: input.reason });
      return this.status(p, missionId, c);
    });
  }

  async grantAuthorization(p:Principal,missionId:string,input:GrantMissionAuthorizationInput){
    this.write(p);if(p.kind!=="user"||!["owner","admin"].includes(p.role))throw new ForbiddenException("Live and protected authorization requires an owner or admin");
    if(input.missionId!==missionId)throw new ConflictException({code:"MISSION_CONTEXT_MISMATCH"});
    return this.db.transaction(async c=>{await this.requireSession(c,missionId,input.agentSessionId);const valid=await c.query(`SELECT 1 FROM mission_objectives o JOIN missions m ON m.id=o.mission_id JOIN environments e ON e.project_id=m.project_id WHERE o.id=$1 AND o.mission_id=$2 AND e.id=$3`,[input.objectiveId,missionId,input.environmentId]);if(!valid.rowCount)throw new ConflictException({code:"AUTHORIZATION_SCOPE_MISMATCH"});const result=await c.query<{id:string}>(`INSERT INTO mission_authorizations(mission_id,objective_id,environment_id,kind,reason,granted_by_agent_session_id,granted_by_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[missionId,input.objectiveId,input.environmentId,input.kind,input.reason,input.agentSessionId,p.userId,input.expiresAt??null]);await this.activity(c,missionId,input.agentSessionId,input.objectiveId,"Execution authorization granted",{authorizationId:result.rows[0]!.id,kind:input.kind,environmentId:input.environmentId});await this.reconcileMission(c,missionId);return{id:result.rows[0]!.id,status:"approved",kind:input.kind};});
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const missions = await this.db.query<{ id: string; session_id: string }>(`SELECT ep.mission_id id,ep.created_by_agent_session_id session_id FROM mission_execution_plans ep WHERE ep.status='active' ORDER BY ep.activated_at`);
      for (const mission of missions.rows) await this.db.transaction(async (c) => { await this.reconcileMission(c, mission.id); await this.scheduleProject(c, mission.id, mission.session_id); }).catch(() => undefined);
    } finally { this.ticking = false; }
  }

  private async scheduleProject(c: PoolClient, missionId: string, sessionId: string, requested?: string[]) {
    const project = await c.query<{ project_id: string }>(`SELECT project_id FROM missions WHERE id=$1`, [missionId]);
    if (!project.rowCount) throw new NotFoundException("Mission not found");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [project.rows[0]!.project_id]);
    const active = await c.query<{ count: string }>(`SELECT count(*)::text count FROM mission_objective_orchestration x JOIN missions m ON m.id=x.mission_id WHERE m.project_id=$1 AND x.state IN ('queued','running')`, [project.rows[0]!.project_id]);
    let slots = Math.max(0, 3 - Number(active.rows[0]!.count));
    if (!slots) return [];
    const ready = await c.query<any>(`SELECT x.objective_id,b.flow_revision_id,b.compiled_contract_id,b.environment_id,b.execution_settings,fr.plan,e.name,e.base_origin,e.policy,e.secret_refs,veil.preferences AS veil_preferences,fc.compiled_contract_digest FROM mission_objective_orchestration x JOIN mission_execution_plans ep ON ep.id=x.plan_id AND ep.status='active' JOIN mission_execution_bindings b ON b.plan_id=x.plan_id AND b.objective_id=x.objective_id JOIN flow_revisions fr ON fr.id=b.flow_revision_id JOIN environments e ON e.id=b.environment_id LEFT JOIN veil_environment_preferences veil ON veil.environment_id=e.id JOIN flow_compilations fc ON fc.id=b.compiled_contract_id AND fc.flow_revision_id=fr.id AND fc.environment_id=e.id AND fc.status='execution_ready' WHERE x.mission_id=$1 AND x.state='ready' AND b.mode='automatic' AND ($2::uuid[] IS NULL OR x.objective_id=ANY($2)) ORDER BY x.updated_at,x.objective_id FOR UPDATE OF x,e SKIP LOCKED`, [missionId, requested?.length ? requested : null]);
    const created: string[] = [];
    for (const row of ready.rows) {
      if (!slots--) break;
      const idempotencyKey = `orchestration:${row.objective_id}:${await this.planRevision(c, missionId)}`;
      const existing = await c.query<{ id: string }>(`SELECT id FROM runs WHERE project_id=$1 AND idempotency_key=$2`, [project.rows[0]!.project_id, idempotencyKey]);
      if (existing.rowCount) continue;
      const executionPolicy = executionPolicySchema.parse(row.policy);
      const veilPolicySnapshot = snapshotVeilPolicy(executionPolicy, row.veil_preferences);
      const run = await c.query<{ id: string }>(`INSERT INTO runs(project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,compiled_contract_id,compiled_contract_digest,state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,execution_snapshot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','queued',$9,$10,$11,$12,$13,$14) RETURNING id`, [project.rows[0]!.project_id, missionId, row.objective_id, sessionId, row.environment_id, row.flow_revision_id,row.compiled_contract_id,row.compiled_contract_digest, row.plan, JSON.stringify({ id: row.environment_id, name: row.name, baseOrigin: row.base_origin, policy: executionPolicy, secretRefs: row.secret_refs }), executionPolicy, veilPolicySnapshot, row.execution_settings, idempotencyKey]);
      await c.query(`INSERT INTO mission_run_links(run_id,mission_id,objective_id,role,reason,classified_by_agent_session_id) VALUES($1,$2,$3,'candidate','Automatically scheduled from approved execution plan',$4)`, [run.rows[0]!.id, missionId, row.objective_id, sessionId]);
      await c.query(`UPDATE mission_objective_orchestration SET state='queued',active_run_id=$2,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE objective_id=$1 AND state='ready'`, [row.objective_id, run.rows[0]!.id]);
      await c.query(`UPDATE mission_objectives SET status='running',latest_candidate_run_id=$2,updated_at=now() WHERE id=$1`, [row.objective_id, run.rows[0]!.id]);
      await c.query(`INSERT INTO run_outbox(run_id,release_id,schema_fingerprint) VALUES($1,$2,$3)`, [run.rows[0]!.id, process.env.SCRY_RELEASE_ID ?? "development", process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline"]);
      await this.activity(c, missionId, sessionId, row.objective_id, "Ready objective scheduled", { runId: run.rows[0]!.id, flowRevisionId: row.flow_revision_id });
      created.push(run.rows[0]!.id);
    }
    return created;
  }

  private async reconcileMission(c: PoolClient, missionId: string) {
    await c.query(`UPDATE mission_objective_orchestration x SET state='passed',blocker_code=NULL,blocker_details='{}'::jsonb,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE x.mission_id=$1 AND EXISTS(SELECT 1 FROM accepted_evidence e WHERE e.objective_id=x.objective_id AND e.superseded_at IS NULL AND e.invalidated_at IS NULL) AND x.state<>'passed'`, [missionId]);
    await c.query(`UPDATE missions m SET status='running',resume_pointer=NULL,updated_at=now() WHERE m.id=$1 AND m.status IN ('blocked','awaiting_user') AND m.resume_pointer IS NOT NULL AND EXISTS(SELECT 1 FROM mission_objectives o WHERE o.id=(m.resume_pointer->>'objectiveId')::uuid AND o.mission_id=m.id AND o.status='passed')`, [missionId]);
    await c.query(`UPDATE mission_objective_orchestration x SET state=CASE WHEN r.state='queued' THEN 'queued' WHEN r.state IN ('preparing','running','finalizing') THEN 'running' WHEN r.state='cancelled' THEN 'cancelled' ELSE 'awaiting_evidence' END,blocker_code=CASE WHEN r.state IN ('queued','preparing','running','finalizing','passed') THEN NULL ELSE upper(COALESCE(r.outcome_classification,r.state)) END,blocker_details=CASE WHEN r.state=ANY($2::text[]) THEN jsonb_build_object('candidateRunState',r.state,'outcomeClassification',r.outcome_classification) ELSE '{}'::jsonb END,lease_expires_at=CASE WHEN r.state IN ('queued','preparing','running','finalizing') THEN now()+interval '2 minutes' ELSE NULL END,updated_at=now() FROM runs r WHERE x.mission_id=$1 AND x.active_run_id=r.id AND (x.state IN ('queued','running') OR (r.state=ANY($2::text[]) AND x.state NOT IN ('passed','failed','blocked','cancelled')))`, [missionId, TERMINAL_RUNS]);
    await c.query(`UPDATE mission_objectives o SET status='pending',conclusion=NULL,updated_at=now() FROM mission_objective_orchestration x WHERE o.id=x.objective_id AND x.mission_id=$1 AND x.state='awaiting_evidence' AND o.status IN ('running','failed','blocked') AND NOT EXISTS(SELECT 1 FROM accepted_evidence e WHERE e.objective_id=o.id AND e.superseded_at IS NULL AND e.invalidated_at IS NULL)`, [missionId]);
    const objectives = await c.query<{ id: string; dependencies: string[]; state: string }>(`SELECT o.id,o.dependencies,x.state FROM mission_objectives o JOIN mission_objective_orchestration x ON x.objective_id=o.id WHERE o.mission_id=$1`, [missionId]);
    const states = new Map(objectives.rows.map((x) => [x.id, x.state]));
    for (const objective of objectives.rows.filter((x) => ["unscheduled", "blocked", "awaiting_authorization"].includes(x.state))) {
      const failed = objective.dependencies.find((id) => ["failed", "blocked", "cancelled"].includes(states.get(id) ?? ""));
      if (failed) {
        await c.query(`UPDATE mission_objective_orchestration SET state='blocked',blocker_code='DEPENDENCY_FAILED',blocker_details=$2::jsonb,updated_at=now() WHERE objective_id=$1`, [objective.id, JSON.stringify({ dependencyObjectiveId: failed })]);
        if(objective.state!=="blocked"){const session=await c.query<{id:string}>(`SELECT ep.created_by_agent_session_id id FROM mission_objective_orchestration x JOIN mission_execution_plans ep ON ep.id=x.plan_id WHERE x.objective_id=$1`,[objective.id]);const blocked=await c.query<{id:string}>(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical) VALUES($1,$2,$3,'decision','Objective blocked by failed dependency',$4::jsonb,false) RETURNING id`,[missionId,objective.id,session.rows[0]!.id,JSON.stringify({dependencyObjectiveId:failed})]);const cause=await c.query<{id:string}>(`SELECT id FROM mission_activities WHERE mission_id=$1 AND objective_id=$2 AND type='run_completed' ORDER BY occurred_at DESC LIMIT 1`,[missionId,failed]);if(cause.rowCount)await c.query(`INSERT INTO activity_relations(mission_id,from_activity_id,to_activity_id,relation) VALUES($1,$2,$3,'caused_by') ON CONFLICT DO NOTHING`,[missionId,blocked.rows[0]!.id,cause.rows[0]!.id]);}
        continue;
      }
      if (objective.dependencies.every((id) => states.get(id) === "passed")) {
        const authorization = await this.authorizationBlocker(c, objective.id);
        await c.query(`UPDATE mission_objective_orchestration SET state=$2,blocker_code=$3,blocker_details=$4::jsonb,updated_at=now() WHERE objective_id=$1`, [objective.id, authorization ? "awaiting_authorization" : "ready", authorization?.code ?? null, JSON.stringify(authorization ?? {})]);
      }
    }
    const reviewRuns = await c.query<any>(`SELECT x.objective_id,r.id run_id,r.state,r.outcome_classification FROM mission_objective_orchestration x JOIN runs r ON r.id=x.active_run_id WHERE x.mission_id=$1 AND x.state='awaiting_evidence' AND r.state<>'passed'`, [missionId]);
    for (const candidate of reviewRuns.rows) await c.query(`UPDATE missions SET resume_pointer=$2::jsonb,status='awaiting_user',updated_at=now() WHERE id=$1`, [missionId, JSON.stringify({ objectiveId: candidate.objective_id, recommendedAction: "review_failure", runId: candidate.run_id, explanation: `Review ${candidate.outcome_classification ?? candidate.state} candidate evidence before deciding the objective outcome.` })]);
  }

  private async authorizationBlocker(c: PoolClient, objectiveId: string) {
    const explicit=await c.query(`SELECT 1 FROM mission_execution_bindings b CROSS JOIN LATERAL jsonb_array_elements_text(b.authorization_ids) requested LEFT JOIN mission_authorizations a ON a.id=requested::uuid AND a.objective_id=b.objective_id AND a.environment_id=b.environment_id AND a.status='approved' AND (a.expires_at IS NULL OR a.expires_at>now()) WHERE b.objective_id=$1 AND a.id IS NULL`,[objectiveId]);
    if(explicit.rowCount)return{code:"LIVE_OR_PROTECTED_AUTHORIZATION_REQUIRED"};
    const credentials = await c.query(`SELECT 1 FROM mission_execution_bindings b JOIN environments e ON e.id=b.environment_id WHERE b.objective_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.secret_refs) ref LEFT JOIN project_credentials pc ON pc.id=ref::uuid AND pc.project_id=e.project_id AND pc.deleted_at IS NULL AND pc.security_status='active' WHERE pc.id IS NULL)`, [objectiveId]);
    if (credentials.rowCount) return { code: "CREDENTIAL_AUTHORIZATION_REQUIRED" };
    const calibration = await c.query(`SELECT 1 FROM mission_execution_bindings b JOIN flow_revisions fr ON fr.id=b.flow_revision_id CROSS JOIN LATERAL jsonb_path_query(fr.plan,'$.steps[*].action ? (@.type == "protectedTransaction")') action LEFT JOIN calibration_attestations a ON a.id=(action->>'calibrationAttestationId')::uuid LEFT JOIN calibration_decisions d ON d.attestation_id=a.id AND d.decision='approved' LEFT JOIN calibration_revocations r ON r.attestation_id=a.id WHERE b.objective_id=$1 AND (a.id IS NULL OR d.id IS NULL OR r.id IS NOT NULL)`, [objectiveId]);
    if (calibration.rowCount) return { code: "CALIBRATION_AUTHORIZATION_REQUIRED" };
    return null;
  }

  private async bindingBlockers(queryable: { query: <T = any>(text: string, values?: any[]) => Promise<any> }, planId: string) {
    const result = await queryable.query<any>(`SELECT b.objective_id AS "objectiveId",CASE WHEN o.id IS NULL THEN 'OBJECTIVE_MISSING' WHEN b.mode='automatic' AND fr.id IS NULL THEN 'FLOW_REVISION_MISSING' WHEN b.mode='automatic' AND e.id IS NULL THEN 'ENVIRONMENT_MISSING' WHEN b.mode='automatic' AND fc.id IS NULL THEN 'EXECUTION_READY_COMPILATION_REQUIRED' WHEN b.mode='automatic' AND fc.status<>'execution_ready' THEN 'COMPILED_CONTRACT_NOT_READY' WHEN b.mode='automatic' AND (fc.flow_revision_id<>fr.id OR fc.environment_id<>e.id) THEN 'COMPILED_CONTRACT_SCOPE_MISMATCH' WHEN b.mode='automatic' AND (f.project_id<>m.project_id OR e.project_id<>m.project_id OR fc.project_id<>m.project_id) THEN 'CROSS_PROJECT_BINDING' WHEN b.mode='automatic' AND NOT COALESCE((fr.validation->>'valid')::boolean,false) THEN 'FLOW_REVISION_INVALID' END code FROM mission_execution_bindings b JOIN mission_execution_plans ep ON ep.id=b.plan_id JOIN missions m ON m.id=ep.mission_id LEFT JOIN mission_objectives o ON o.id=b.objective_id AND o.mission_id=m.id LEFT JOIN flow_revisions fr ON fr.id=b.flow_revision_id LEFT JOIN flows f ON f.id=fr.flow_id LEFT JOIN environments e ON e.id=b.environment_id LEFT JOIN flow_compilations fc ON fc.id=b.compiled_contract_id WHERE b.plan_id=$1`, [planId]);
    const authorizations=await queryable.query(`SELECT b.objective_id AS "objectiveId",'AUTHORIZATION_INVALID' code FROM mission_execution_bindings b CROSS JOIN LATERAL jsonb_array_elements_text(b.authorization_ids) requested LEFT JOIN mission_authorizations a ON a.id=requested::uuid AND a.mission_id=b.mission_id AND a.objective_id=b.objective_id AND a.environment_id=b.environment_id AND a.status='approved' AND (a.expires_at IS NULL OR a.expires_at>now()) WHERE b.plan_id=$1 AND a.id IS NULL`,[planId]);
    return [...result.rows,...authorizations.rows].filter((x: any) => x.code);
  }
  private assertAcyclic(rows: Array<{ id: string; dependencies: string[] }>) { const map = new Map(rows.map((x) => [x.id, x.dependencies])); const done = new Set<string>(); const visit = (id: string, path = new Set<string>()) => { if (path.has(id)) throw new ConflictException({ code: "OBJECTIVE_DEPENDENCY_CYCLE" }); if (done.has(id)) return; const next = new Set(path); next.add(id); for (const dep of map.get(id) ?? []) { if (!map.has(dep)) throw new ConflictException({ code: "OBJECTIVE_DEPENDENCY_MISSING", objectiveId: id, dependencyId: dep }); visit(dep, next); } done.add(id); }; for (const id of map.keys()) visit(id); }
  private async requireSession(c: PoolClient, missionId: string, sessionId: string) { const session = await c.query(`SELECT 1 FROM agent_sessions WHERE id=$1 AND mission_id=$2 AND status='active'`, [sessionId, missionId]); if (!session.rowCount) throw new ConflictException({ code: "AGENT_SESSION_INACTIVE" }); }
  private async planRevision(c: PoolClient, missionId: string) { const result = await c.query<{ revision: number }>(`SELECT revision FROM mission_execution_plans WHERE mission_id=$1 AND status='active'`, [missionId]); return result.rows[0]?.revision ?? 0; }
  private async activity(c: PoolClient, missionId: string, sessionId: string, objectiveId: string | null, summary: string, metadata: object) { await c.query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata,technical) VALUES($1,$2,$3,'decision',$4,$5::jsonb,true)`, [missionId, objectiveId, sessionId, summary, JSON.stringify(metadata)]); }
}
