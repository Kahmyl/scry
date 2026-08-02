import { createHash, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  executionPolicySchema,
  validatePlanAgainstPolicy,
  type CreateFlowRevisionInput,
  type CreateFlowInput,
  type CreateFlowRunInput,
  type CurrentPlan,
  type ValidatePlanInput,
  type BindCalibrationInput,
  PRAXIS_CONTRACT_VERSION,
  PRAXIS_RUNTIME_VERSION,
  PRAXIS_SCORING_POLICY_VERSION,
} from "@scry/contracts";
import { browserObservationRuntimeHealth, protectedTransactionDigest } from "@scry/executor";
import type { PoolClient, QueryResultRow } from "pg";

import type { Principal } from "./auth.types.js";
import { Database } from "./database.js";
import { ReleaseAdmissionService } from "./release-admission.service.js";

type Query = <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: T[] }>;
type Diagnostic = { severity: "error" | "warning"; code: string; message: string; suggestion?: string; stepId?: string };

@Injectable()
export class FlowService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  capabilities() {
    const observer = browserObservationRuntimeHealth();
    return {
      releaseId: process.env.SCRY_RELEASE_ID ?? "development",
      schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
      supportedActions: ["navigate", "click", "fill", "select", "check", "press", "scroll", "waitFor", "screenshot", "protectedTransaction", "capturePublicValue"],
      evidenceChannels: ["video", "trace", "screenshot", "dom", "accessibility", "console", "page_error", "network", "report", "event", "metadata"],
      artifactCapabilities: ["range", "text-pagination", "literal-search", "html-selector", "delete"],
      collectorCapabilities: ["segmented-video", "segmented-trace", "privacy-gate", "separate-browser-protected-capsule", "context-provenance", "fenced-mutation-ledger", "checkpoint-restoration"],
      groundingCapabilities: ["actionable-control-inventory-v2","capability-universal-gate","independent-evidence-fusion","typed-observation-failures","typed-interaction-adapters","local-state-verification","deterministic-ocr-anchors","geometry-evidence","open-shadow-dom","risk-thresholds","effect-verification","environment-history","drift-rejection","typed-acquisition","bounded-protected-recovery"],
      groundingManifest: { browserObservationRuntime:"available",semanticObserver:observer.healthy?"available":"unavailable",accessibilityMapping:"available",ocr:"available",geometry:"available",shadowDom:"available",visualCanvas:"available",adapters:["gauntlet.clipboard","gauntlet.network","gauntlet.safe-exit","gauntlet.revocation"],runtimeHash:observer.runtimeHash,capabilityManifestHash:observer.capabilityManifestHash,health:observer.health,diagnostics:observer.diagnostics },
      praxis: { contractVersion: PRAXIS_CONTRACT_VERSION, runtimeVersion: PRAXIS_RUNTIME_VERSION, scoringPolicyVersion: PRAXIS_SCORING_POLICY_VERSION, cutoff: true, evidenceChannels: ["native_control","accessibility","textual","structural","runtime","visual","historical"], strategies: ["native_activate","native_fill","native_select","native_check","computed_activate","focus_keyboard","content_editable","verified_pointer","canvas_coordinate","scroll","inspect","application_adapter"], hardBoundaries: ["no_selectors","no_raw_locators","no_arbitrary_coordinates","no_protected_values_in_reports","unknown_mutation_never_retry_safe","no_legacy_consumer_rollback"] },
      intelligenceCapabilities: { modelAssistance: false, visualGrounding: "deterministic-local" },
      adapterCapabilities: ["gauntlet.clipboard", "gauntlet.network", "gauntlet.safe-exit", "gauntlet.revocation"],
      limits: { maxPlanSteps: 500, maxArtifactTextPageBytes: 262_144 },
      publicArtifactAccess: Boolean(process.env.SCRY_PUBLIC_API_BASE_URL),
      missionContext: { requiredForWrites: true, transport: "explicit", phases: ["identity","objectives","reports","mcp-enforcement","core-orchestration","capability-grounding","authoring-compilation"] },
      authoring: { drafts: true, probeLevels:["inspection","reversible","calibration_transaction"], compilationRequiredForRuns:true, candidateRunBudget:1, encryptedSessionReuse:"project-policy-opt-in" },
      orchestration: { enabled: process.env.SCRY_ORCHESTRATION_ENABLED==="true", projectConcurrencyLimit: 3, readinessAuthoritative: true },
    } as const;
  }

  async readiness() {
    return { ...await this.admission.status(), ...this.capabilities() };
  }

  async validate(principal: Principal, input: ValidatePlanInput) {
    await this.admission.assertAcceptingWork();
    return this.validateWith((text, values) => this.database.query(text, values), principal, input, true);
  }

  async createFlow(principal: Principal, projectId: string, input: CreateFlowInput) {
    throw new ConflictException({ code: "AUTHORING_DRAFT_REQUIRED", message: "Create a mutable Flow draft, probe and compile it, then publish an immutable revision." });
    /* legacy direct publication is intentionally unreachable after the authoring cutoff */
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      await this.requireMissionContext(query, principal, projectId, input.missionId, input.objectiveId, input.agentSessionId);
      const validation = await this.validateWith(query, principal, {
        projectId,
        environmentId: input.environmentId,
        plan: input.plan,
      }, false);
      this.requireValid(validation);
      const requestHash = hash(input);
      const replay = await this.claimIdempotency(query, `flow:create:${projectId}`, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const flowId = randomUUID();
      const revisionId = randomUUID();
      await query(
        `INSERT INTO flows(id, project_id, name, description, latest_revision_id,visibility,purpose,origin_mission_id,origin_objective_id,created_by_agent_session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [flowId, projectId, input.name, input.description, revisionId,input.visibility,input.purpose,input.missionId,input.objectiveId,input.agentSessionId],
      );
      await query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason)
         VALUES($1,$2,1,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)`,
        [revisionId,flowId,JSON.stringify(input.content),JSON.stringify(input.plan),JSON.stringify(validation),input.agentSessionId,input.reason],
      );
      await query(`INSERT INTO mission_flow_links(mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.missionId,input.objectiveId,flowId,input.visibility,input.purpose,input.reason,input.agentSessionId]);
      await query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'flow_created',$4,$5::jsonb)`,[input.missionId,input.objectiveId,input.agentSessionId,`Flow created: ${input.name}`,JSON.stringify({flowId,revisionId,visibility:input.visibility,purpose:input.purpose})]);
      const response = { flowId, revisionId, revision: 1, validation, replayed: false };
      await this.completeIdempotency(query, `flow:create:${projectId}`, input.idempotencyKey, response);
      return response;
    });
  }

  async listFlows(principal: Principal, projectId: string, visibility = "reusable") {
    await this.requireProject((text, values) => this.database.query(text, values), principal, projectId);
    return (await this.database.query(
      `SELECT f.id, f.name, f.description, f.latest_revision_id AS "latestRevisionId",
              f.visibility,f.purpose,f.origin_mission_id AS "originMissionId",f.origin_objective_id AS "originObjectiveId",
              COALESCE((SELECT jsonb_agg(jsonb_build_object('missionId',linked.mission_id,'objectiveId',linked.objective_id,'missionTitle',linked.title) ORDER BY linked.created_at DESC)
                FROM (SELECT l.mission_id,l.objective_id,m.title,l.created_at FROM mission_flow_links l JOIN missions m ON m.id=l.mission_id WHERE l.flow_id=f.id) linked),'[]'::jsonb) AS "missionLinks",
              fr.revision AS "latestRevision",
              fr.content AS "latestContent", fr.plan AS "latestPlan",
              f.created_at AS "createdAt", f.updated_at AS "updatedAt"
       FROM flows f JOIN flow_revisions fr ON fr.id = f.latest_revision_id
       WHERE f.project_id=$1 AND ($2='all' OR f.visibility=$2) ORDER BY f.updated_at DESC`,
      [projectId,visibility],
    )).rows;
  }

  async reviseFlow(principal: Principal, flowId: string, input: CreateFlowRevisionInput) {
    throw new ConflictException({ code: "AUTHORING_DRAFT_REQUIRED", message: "Edit a mutable Flow draft and publish it only after execution-ready compilation." });
    /* legacy direct revision is intentionally unreachable after the authoring cutoff */
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      const flow = await this.requireFlow(query, principal, flowId, true);
      await this.requireMissionContext(query, principal, flow.projectId, input.missionId, input.objectiveId, input.agentSessionId, flowId);
      const requestHash = hash(input);
      const replay = await this.claimIdempotency(query, `flow:revise:${flowId}`, input.idempotencyKey, requestHash);
      if (replay) return replay;
      if (flow.latestRevisionId !== input.expectedRevisionId) {
        throw new ConflictException({
          code: "FLOW_REVISION_CONFLICT",
          message: "The Flow changed after it was read.",
          expectedRevisionId: input.expectedRevisionId,
          actualRevisionId: flow.latestRevisionId,
        });
      }
      const validation = await this.validateWith(query, principal, {
        projectId: flow.projectId,
        environmentId: input.environmentId,
        plan: input.plan,
      }, false);
      this.requireValid(validation);
      const revisionId = randomUUID();
      const nextRevision = flow.revision + 1;
      await query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`,
        [revisionId,flowId,nextRevision,JSON.stringify(input.content),JSON.stringify(input.plan),JSON.stringify(validation),input.agentSessionId,input.reason],
      );
      await query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'flow_revised',$4,$5::jsonb)`,[input.missionId,input.objectiveId,input.agentSessionId,`Flow revision ${nextRevision} created`,JSON.stringify({flowId,revisionId,reason:input.reason})]);
      await query(
        `UPDATE flows SET latest_revision_id = $2, name = COALESCE($3, name),
                          description = COALESCE($4, description), updated_at = now()
         WHERE id = $1`,
        [flowId, revisionId, input.name ?? null, input.description ?? null],
      );
      const response = { flowId, revisionId, revision: nextRevision, validation, replayed: false };
      await this.completeIdempotency(query, `flow:revise:${flowId}`, input.idempotencyKey, response);
      return response;
    });
  }

  async bindCalibration(principal: Principal, flowId: string, input: BindCalibrationInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      const flow = await this.requireFlow(query, principal, flowId, true);
      await this.requireMissionContext(query,principal,flow.projectId,input.missionId,input.objectiveId,input.agentSessionId,flowId);
      const replay = await this.claimIdempotency(query, `flow:calibration:${flowId}`, input.idempotencyKey, hash(input));
      if (replay) return replay;
      if (flow.latestRevisionId !== input.expectedRevisionId) throw new ConflictException({ code: "FLOW_REVISION_CONFLICT", message: "The Flow changed after it was read.", actualRevisionId: flow.latestRevisionId });
      const current = await query<{ content: unknown; plan: CurrentPlan }>(`SELECT content,plan FROM flow_revisions WHERE id=$1 AND flow_id=$2`, [flow.latestRevisionId, flowId]);
      let matches = 0;
      const plan: CurrentPlan = { ...current.rows[0]!.plan, steps: current.rows[0]!.plan.steps.map((step) => {
        if (step.action.type !== "protectedTransaction" || step.action.operationId !== input.operationId) return step;
        matches += 1;
        return { ...step, action: { ...step.action, calibrationAttestationId: input.attestationId } };
      }) };
      if (matches !== 1) throw new ConflictException({ code: matches ? "CALIBRATION_OPERATION_AMBIGUOUS" : "CALIBRATION_OPERATION_MISMATCH", message: "The Flow must contain exactly one matching protected operation." });
      const validation = await this.validateWith(query, principal, { projectId: flow.projectId, environmentId: input.environmentId, plan }, true);
      this.requireValid(validation);
      const revisionId = randomUUID();
      const nextRevision = flow.revision + 1;
      await query(`INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`, [revisionId,flowId,nextRevision,JSON.stringify(current.rows[0]!.content),JSON.stringify(plan),JSON.stringify(validation),input.agentSessionId,input.reason]);
      await query(`UPDATE flows SET latest_revision_id=$2,updated_at=now() WHERE id=$1`, [flowId, revisionId]);
      const response = { flowId, revisionId, revision: nextRevision, attestationId: input.attestationId, validation, replayed: false };
      await this.completeIdempotency(query, `flow:calibration:${flowId}`, input.idempotencyKey, response);
      return response;
    });
  }

  async createRun(principal: Principal, projectId: string, input: CreateFlowRunInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      await this.requireMissionContext(query, principal, projectId, input.missionId, input.objectiveId, input.agentSessionId);
      const replay = await this.claimIdempotency(query, `run:create:${projectId}`, input.idempotencyKey, hash(input));
      if (replay) return replay;
      await query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[projectId]);
      const authority=await query<{state:string;mode:string;flowRevisionId:string|null;compiledContractId:string|null;environmentId:string|null;executionSettings:{browser:string;viewport:{width:number;height:number};seed?:number}}>(`SELECT x.state,b.mode,b.flow_revision_id AS "flowRevisionId",b.compiled_contract_id AS "compiledContractId",b.environment_id AS "environmentId",b.execution_settings AS "executionSettings" FROM mission_objective_orchestration x JOIN mission_execution_plans ep ON ep.id=x.plan_id AND ep.status='active' JOIN mission_execution_bindings b ON b.plan_id=x.plan_id AND b.objective_id=x.objective_id WHERE x.mission_id=$1 AND x.objective_id=$2 FOR UPDATE`,[input.missionId,input.objectiveId]);
      if(!authority.rowCount) throw new ConflictException({code:"ORCHESTRATION_PLAN_REQUIRED",message:"Activate an approved Mission execution plan before starting Runs."});
      const binding=authority.rows[0]!;
      if(binding.state!=="ready") throw new ConflictException({code:"OBJECTIVE_NOT_READY",message:"Scry readiness is authoritative.",state:binding.state});
      if(binding.flowRevisionId&&binding.flowRevisionId!==input.flowRevisionId||binding.compiledContractId&&binding.compiledContractId!==input.compiledContractId||binding.environmentId&&binding.environmentId!==input.environmentId) throw new ConflictException({code:"EXECUTION_BINDING_MISMATCH"});
      if(binding.mode==="automatic"&&hash(binding.executionSettings)!==hash({browser:input.browser,viewport:input.viewport,seed:input.seed})) throw new ConflictException({code:"EXECUTION_SETTINGS_MISMATCH"});
      const active=await query<{count:string}>(`SELECT count(*)::text count FROM mission_objective_orchestration x JOIN missions m ON m.id=x.mission_id WHERE m.project_id=$1 AND x.state IN ('queued','running')`,[projectId]);
      if(Number(active.rows[0]!.count)>=3) throw new ConflictException({code:"PROJECT_CONCURRENCY_LIMIT",limit:3});
      const revision = await query<{ plan: CurrentPlan; flowId: string }>(
        `SELECT fr.plan, fr.flow_id AS "flowId"
         FROM flow_revisions fr JOIN flows f ON f.id = fr.flow_id
         JOIN projects p ON p.id = f.project_id
         WHERE fr.id = $1 AND f.project_id = $2
           AND ($3::uuid IS NULL OR p.workspace_id = $3)`,
        [input.flowRevisionId, projectId, workspaceId(principal)],
      );
      if (!revision.rowCount) throw new NotFoundException("Flow revision not found");
      const runtime=browserObservationRuntimeHealth();
      const compilation=await query<{id:string;compiledContractDigest:string;runtimeHash:string;capabilityManifestHash:string}>(`SELECT id,compiled_contract_digest AS "compiledContractDigest",runtime_hash AS "runtimeHash",capability_manifest_hash AS "capabilityManifestHash" FROM flow_compilations WHERE id=$1 AND flow_revision_id=$2 AND environment_id=$3 AND mission_id=$4 AND objective_id=$5 AND status='execution_ready'`,[input.compiledContractId,input.flowRevisionId,input.environmentId,input.missionId,input.objectiveId]);
      if(!runtime.healthy)throw new ServiceUnavailableException({code:"BROWSER_RUNTIME_UNHEALTHY",diagnostics:runtime.diagnostics});
      if(!compilation.rowCount)throw new ConflictException({code:"EXECUTION_READY_COMPILATION_REQUIRED",safeActions:["inspect_compilation","start_probe_session","compile_flow_draft"]});
      if(compilation.rows[0]!.runtimeHash!==runtime.runtimeHash||compilation.rows[0]!.capabilityManifestHash!==runtime.capabilityManifestHash){await query(`UPDATE flow_compilations SET status='stale',invalidated_at=now() WHERE id=$1`,[input.compiledContractId]);throw new ConflictException({code:"COMPILED_CONTRACT_STALE",safeActions:["start_probe_session","recompile"]});}
      const existingCandidate=await query(`SELECT 1 FROM runs WHERE mission_id=$1 AND objective_id=$2 AND compiled_contract_id=$3 AND reliability_eligible AND state IN ('queued','preparing','running','finalizing','failed','timed_out','infrastructure_error')`,[input.missionId,input.objectiveId,input.compiledContractId]);
      if(existingCandidate.rowCount)throw new ConflictException({code:"CANDIDATE_RUN_BUDGET_EXHAUSTED",safeActions:["accept_evidence","return_to_calibration","publish_new_revision"]});
      const validation = await this.validateWith(query, principal, {
        projectId,
        environmentId: input.environmentId,
        plan: revision.rows[0]!.plan,
      }, true);
      this.requireValid(validation);
      const environment = await query<{ name: string; baseOrigin: string; policy: unknown; secretRefs: string[] }>(
        `SELECT name, base_origin AS "baseOrigin", policy, secret_refs AS "secretRefs"
         FROM environments WHERE id = $1 AND project_id = $2`,
        [input.environmentId, projectId],
      );
      const run = await query<{ id: string; state: string }>(
        `INSERT INTO runs(project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,compiled_contract_id,compiled_contract_digest,state,phase,
                          plan_snapshot, environment_snapshot, policy_snapshot, execution_snapshot, idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','queued',$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13)
         RETURNING id, state`,
        [projectId,input.missionId,input.objectiveId,input.agentSessionId,input.environmentId,input.flowRevisionId,input.compiledContractId,compilation.rows[0]!.compiledContractDigest,JSON.stringify(revision.rows[0]!.plan),
         JSON.stringify({ id: input.environmentId, ...environment.rows[0] }), JSON.stringify(environment.rows[0]!.policy),
         JSON.stringify({ browser: input.browser, viewport: input.viewport, seed: input.seed }), input.idempotencyKey],
      );
      await query(`INSERT INTO mission_run_links(run_id,mission_id,objective_id,role,reason,classified_by_agent_session_id) VALUES($1,$2,$3,$4,'Run created',$5)`,[run.rows[0]!.id,input.missionId,input.objectiveId,input.role,input.agentSessionId]);
      await query(`UPDATE mission_objective_orchestration SET state='queued',active_run_id=$2,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE objective_id=$1`,[input.objectiveId,run.rows[0]!.id]);
      await query(`UPDATE mission_objectives SET latest_candidate_run_id=$2,status=CASE WHEN status='pending' THEN 'running' ELSE status END,updated_at=now() WHERE id=$1`,[input.objectiveId,run.rows[0]!.id]);
      await query(`UPDATE missions SET status=CASE WHEN status='planning' THEN 'running' ELSE status END,updated_at=now(),revision=revision+1 WHERE id=$1`,[input.missionId]);
      await query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'run_started','Run queued',$4::jsonb)`,[input.missionId,input.objectiveId,input.agentSessionId,JSON.stringify({runId:run.rows[0]!.id,flowRevisionId:input.flowRevisionId,role:input.role})]);
      await query(`INSERT INTO run_outbox(run_id, release_id, schema_fingerprint) VALUES ($1, $2, $3)`,
        [run.rows[0]!.id, process.env.SCRY_RELEASE_ID ?? "development", process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline"]);
      const response = { runId: run.rows[0]!.id, state: run.rows[0]!.state, validation, replayed: false };
      await this.completeIdempotency(query, `run:create:${projectId}`, input.idempotencyKey, response);
      return response;
    });
  }

  private async validateWith(query: Query, principal: Principal, input: ValidatePlanInput, requireCalibration: boolean) {
    await this.requireProject(query, principal, input.projectId);
    const environment = await query<{ policy: unknown; secretRefs: string[] }>(
      `SELECT policy, secret_refs AS "secretRefs" FROM environments WHERE id = $1 AND project_id = $2`,
      [input.environmentId, input.projectId],
    );
    if (!environment.rowCount) throw new NotFoundException("Environment not found");
    const diagnostics: Diagnostic[] = [];
    const observer = browserObservationRuntimeHealth();
    if (!observer.healthy) diagnostics.push({ severity:"error",code:"FLOW_CAPABILITY_UNAVAILABLE",message:"The Browser Observation Runtime failed its self-contained artifact check.",suggestion:"Deploy a healthy capability-grounding worker before accepting Flows." });
    const policy = executionPolicySchema.parse(environment.rows[0]!.policy);
    diagnostics.push(...validatePlanAgainstPolicy(input.plan, policy).map((item) => ({ severity: "error" as const, ...item })));
    const requestedAdapters=adapterReferences(input.plan);
    if(requestedAdapters.length){
      const registered=await query<{id:string;permittedOrigins:string[]}>(`SELECT id,permitted_origins AS "permittedOrigins" FROM adapter_registrations WHERE id=ANY($1::text[])`,[requestedAdapters]);
      const byId=new Map(registered.rows.map((item)=>[item.id,item]));
      for(const id of requestedAdapters){const adapter=byId.get(id);if(!adapter||input.plan.allowedOrigins.some((origin)=>!adapter.permittedOrigins.includes(origin)))diagnostics.push({severity:"error",code:"FLOW_CAPABILITY_UNAVAILABLE",message:`Reviewed adapter ${id} is unavailable for every allowed origin.`,suggestion:"Use a registered origin-bound adapter or remove the adapter request."});}
    }
    for (const step of input.plan.steps) {
      if (step.action.type !== "protectedTransaction") continue;
      if (!step.action.calibrationAttestationId) {
        diagnostics.push({
          severity: requireCalibration ? "error" : "warning",
          code: requireCalibration ? "CALIBRATION_REQUIRED" : "CALIBRATION_PENDING",
          message: `Protected operation ${step.action.operationId} must be calibrated and bound before execution.`,
          stepId: step.id,
          suggestion: "Create an authenticated calibration from this Flow revision, approve the attested revision, then bind its revision ID.",
        });
        continue;
      }
      const calibrated = await query(
        `SELECT 1 FROM calibration_attestations attestation
         JOIN calibration_contract_revisions revision ON revision.id=attestation.contract_revision_id
         JOIN calibration_contracts contract ON contract.id=revision.contract_id
         JOIN calibration_decisions decision ON decision.attestation_id=attestation.id AND decision.decision='approved'
         LEFT JOIN calibration_revocations revocation ON revocation.attestation_id=attestation.id
         WHERE attestation.id=$1 AND contract.project_id=$2 AND revision.environment_id=$3 AND revision.operation_id=$4
           AND revision.operation_digest=$5 AND attestation.operation_digest=$5 AND revocation.id IS NULL
           AND revision.input_schema_digest=attestation.input_schema_digest
           AND attestation.privacy_verified AND attestation.canary_scan_passed AND attestation.mutation_count=1`,
        [step.action.calibrationAttestationId, input.projectId, input.environmentId, step.action.operationId, protectedTransactionDigest(step.action, input.plan.allowedOrigins)],
      );
      if (!calibrated.rowCount) diagnostics.push({ severity: "error", code: "CALIBRATION_REQUIRED", message: `Protected operation ${step.action.operationId} requires an approved calibration contract revision.`, stepId: step.id });
    }
    const refs = secretReferences(input.plan);
    const allowed = new Set(environment.rows[0]!.secretRefs);
    for (const reference of refs.filter((item) => !allowed.has(item))) {
      diagnostics.push({ severity: "error", code: "CREDENTIAL_NOT_AUTHORIZED", message: `Credential ${reference} is not authorized in this environment.` });
    }
    if (refs.length) {
      const active = await query<{ id: string }>(
        `SELECT id::text FROM project_credentials WHERE project_id = $1 AND deleted_at IS NULL AND security_status = 'active' AND id = ANY($2::uuid[])`,
        [input.projectId, refs],
      ).catch((error) => {
        throw new ServiceUnavailableException({ code: "CREDENTIAL_STORAGE_FAILURE", message: "Credential storage could not be validated.", cause: error instanceof Error ? error.message : String(error) });
      });
      const ids = new Set(active.rows.map(({ id }) => String(id)));
      for (const reference of refs.filter((item) => !ids.has(item))) {
        diagnostics.push({ severity: "error", code: "CREDENTIAL_UNAVAILABLE", message: `Credential ${reference} is missing or deleted.` });
      }
    }
    return {
      correlationId: randomUUID(),
      valid: !diagnostics.some(({ severity }) => severity === "error"),
      errors: diagnostics.filter(({ severity }) => severity === "error"),
      warnings: diagnostics.filter(({ severity }) => severity === "warning"),
      validatedAt: new Date().toISOString(),
    };
  }

  private requireValid(validation: { valid: boolean; errors: Diagnostic[] }) {
    if (!validation.valid) throw new ConflictException({ code: "PLAN_VALIDATION_FAILED", message: "Plan validation failed", ...validation });
  }

  private async requireProject(query: Query, principal: Principal, projectId: string) {
    const result = await query(`SELECT 1 FROM projects WHERE id = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`, [projectId, workspaceId(principal)]);
    if (!result.rowCount) throw new NotFoundException("Project not found");
  }

  private async requireMissionContext(query: Query, principal: Principal, projectId: string, missionId: string, objectiveId: string, agentSessionId: string, flowId?: string) {
    const context = await query(
      `SELECT 1 FROM missions m
       JOIN projects p ON p.id=m.project_id
       JOIN mission_objectives o ON o.mission_id=m.id AND o.id=$3
       JOIN agent_sessions s ON s.mission_id=m.id AND s.id=$4 AND s.status='active'
       WHERE m.id=$2 AND m.project_id=$1 AND ($5::uuid IS NULL OR p.workspace_id=$5)`,
      [projectId,missionId,objectiveId,agentSessionId,workspaceId(principal)],
    );
    if (!context.rowCount) throw new ConflictException({ code: "MISSION_CONTEXT_INVALID", message: "Mission, objective, and active agent session must belong to the selected project." });
    if (flowId) {
      const linked = await query(`SELECT 1 FROM mission_flow_links WHERE mission_id=$1 AND flow_id=$2`, [missionId,flowId]);
      if (!linked.rowCount) throw new ConflictException({ code: "FLOW_NOT_ATTACHED_TO_MISSION", message: "Attach the Flow before revising it in this Mission." });
    }
  }

  private async requireFlow(query: Query, principal: Principal, flowId: string, lock: boolean) {
    const result = await query<{ projectId: string; latestRevisionId: string; revision: number }>(
      `SELECT f.project_id AS "projectId", f.latest_revision_id AS "latestRevisionId", fr.revision
       FROM flows f JOIN flow_revisions fr ON fr.id = f.latest_revision_id
       JOIN projects p ON p.id = f.project_id
       WHERE f.id = $1 AND ($2::uuid IS NULL OR p.workspace_id = $2) ${lock ? "FOR UPDATE OF f" : ""}`,
      [flowId, workspaceId(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Flow not found");
    return result.rows[0]!;
  }

  private async claimIdempotency(query: Query, scope: string, key: string, requestHash: string) {
    await query(`INSERT INTO idempotency_records(scope, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [scope, key, requestHash]);
    const record = await query<{ requestHash: string; response?: unknown }>(
      `SELECT request_hash AS "requestHash", response FROM idempotency_records WHERE scope = $1 AND key = $2 FOR UPDATE`, [scope, key],
    );
    if (record.rows[0]!.requestHash !== requestHash) throw new ConflictException({ code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency key was used with a different request." });
    return record.rows[0]!.response as Record<string, unknown> | undefined;
  }

  private completeIdempotency(query: Query, scope: string, key: string, response: unknown) {
    return query(`UPDATE idempotency_records SET response = $3::jsonb, completed_at = now() WHERE scope = $1 AND key = $2`, [scope, key, JSON.stringify(response)]);
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") throw new ForbiddenException("Workspace viewers have read-only access");
  }
}

function adapterReferences(plan:CurrentPlan){const ids=new Set<string>();for(const step of plan.steps){if(step.action.type==="capturePublicValue"&&step.action.capture.acquisition.adapter)ids.add(step.action.capture.acquisition.adapter.id);if(step.action.type!=="protectedTransaction")continue;for(const output of step.action.extraction.outputs)if(output.acquisition.adapter)ids.add(output.acquisition.adapter.id);const reconciliation=step.action.mutation.reconciliation;if((reconciliation.strategy==="adapter"||reconciliation.strategy==="public_api_state"))ids.add(reconciliation.adapterId);if(step.action.revocationAdapter)ids.add(step.action.revocationAdapter.adapterId);}return[...ids];}

function bindQuery(client: PoolClient): Query {
  return (text, values = []) => client.query(text, values);
}
function workspaceId(principal: Principal) { return principal.kind === "user" ? principal.workspaceId : null; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function secretReferences(plan: CurrentPlan) {
  return [...new Set(plan.steps.flatMap(({ action }) => {
    if (action.type === "fill" && action.secretRef) return [action.secretRef];
    if (action.type === "protectedTransaction") return Object.values(action.inputs).flatMap((input) => input.classification === "known_secret" ? [input.credentialRef] : []);
    return [];
  }))];
}
