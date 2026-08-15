import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  executionPolicySchema,
  validatePlanAgainstPolicy,
  analyzePlanRisks,
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
import { protectedTransactionDigest } from "@scry/executor";
import { browserObservationRuntimeHealth } from "@scry/praxis";
import type { PoolClient, QueryResultRow } from "pg";

import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { snapshotVeilPolicy } from "../veil/index.js";
import { FlowReadRepository } from "./flow-read.repository.js";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;
type Diagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  suggestion?: string;
  stepId?: string;
};

@Injectable()
export class FlowService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
    @Optional() @Inject(FlowReadRepository) private readonly reads?: FlowReadRepository,
  ) {}

  capabilities() {
    const observer = browserObservationRuntimeHealth();
    return {
      releaseId: process.env.SCRY_RELEASE_ID ?? "development",
      schemaFingerprint: process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
      adaptiveExecution: {
        kernel: true,
        authoringTurn: true,
        modes: ["observe", "rehearse", "transact", "certify", "run"],
      },
      supportedActions: [
        "navigate",
        "click",
        "fill",
        "select",
        "check",
        "press",
        "scroll",
        "waitFor",
        "screenshot",
        "protectedTransaction",
        "capturePublicValue",
      ],
      evidenceChannels: [
        "video",
        "trace",
        "screenshot",
        "dom",
        "accessibility",
        "console",
        "page_error",
        "network",
        "report",
        "event",
        "metadata",
      ],
      artifactCapabilities: [
        "range",
        "text-pagination",
        "literal-search",
        "html-selector",
        "delete",
      ],
      collectorCapabilities: [
        "segmented-video",
        "segmented-trace",
        "privacy-gate",
        "separate-browser-protected-capsule",
        "context-provenance",
        "fenced-mutation-ledger",
        "checkpoint-restoration",
      ],
      groundingCapabilities: [
        "actionable-control-inventory-v2",
        "capability-universal-gate",
        "independent-evidence-fusion",
        "typed-observation-failures",
        "typed-interaction-adapters",
        "local-state-verification",
        "deterministic-ocr-anchors",
        "geometry-evidence",
        "open-shadow-dom",
        "risk-thresholds",
        "effect-verification",
        "environment-history",
        "drift-rejection",
        "typed-acquisition",
        "bounded-protected-recovery",
      ],
      groundingManifest: {
        browserObservationRuntime: "available",
        semanticObserver: observer.healthy ? "available" : "unavailable",
        accessibilityMapping: "available",
        ocr: "available",
        geometry: "available",
        shadowDom: "available",
        visualCanvas: "available",
        adapters: [
          "gauntlet.clipboard",
          "gauntlet.network",
          "gauntlet.safe-exit",
          "gauntlet.revocation",
        ],
        runtimeHash: observer.runtimeHash,
        capabilityManifestHash: observer.capabilityManifestHash,
        health: observer.health,
        diagnostics: observer.diagnostics,
      },
      praxis: {
        contractVersion: PRAXIS_CONTRACT_VERSION,
        runtimeVersion: PRAXIS_RUNTIME_VERSION,
        scoringPolicyVersion: PRAXIS_SCORING_POLICY_VERSION,
        cutoff: true,
        evidenceChannels: [
          "native_control",
          "accessibility",
          "textual",
          "structural",
          "runtime",
          "visual",
          "historical",
        ],
        strategies: [
          "native_activate",
          "native_fill",
          "native_select",
          "native_check",
          "computed_activate",
          "focus_keyboard",
          "content_editable",
          "verified_pointer",
          "canvas_coordinate",
          "scroll",
          "inspect",
          "application_adapter",
        ],
        hardBoundaries: [
          "no_selectors",
          "no_raw_locators",
          "no_arbitrary_coordinates",
          "no_protected_values_in_reports",
          "unknown_mutation_never_retry_safe",
          "no_legacy_consumer_rollback",
        ],
      },
      intelligenceCapabilities: { modelAssistance: false, visualGrounding: "deterministic-local" },
      adapterCapabilities: [
        "gauntlet.clipboard",
        "gauntlet.network",
        "gauntlet.safe-exit",
        "gauntlet.revocation",
      ],
      limits: { maxPlanSteps: 500, maxArtifactTextPageBytes: 262_144 },
      publicArtifactAccess: Boolean(process.env.SCRY_PUBLIC_API_BASE_URL),
      missionContext: {
        requiredForWrites: true,
        transport: "explicit",
        phases: [
          "identity",
          "objectives",
          "reports",
          "mcp-enforcement",
          "core-orchestration",
          "capability-grounding",
          "authoring-compilation",
        ],
      },
      authoring: {
        drafts: true,
        probeLevels: ["inspection", "reversible", "calibration_transaction"],
        compilationRequiredForRuns: false,
        candidateRunBudget: 0,
        encryptedSessionReuse: "project-policy-opt-in",
      },
      orchestration: {
        enabled: true,
        projectConcurrencyLimit: 3,
        readinessAuthoritative: true,
      },
    } as const;
  }

  async readiness() {
    return { ...(await this.admission.status()), ...this.capabilities() };
  }

  async validate(principal: Principal, input: ValidatePlanInput) {
    await this.admission.assertAcceptingWork();
    return this.validateWith(
      (text, values) => this.database.query(text, values),
      principal,
      input,
    );
  }

  async createFlow(principal: Principal, projectId: string, input: CreateFlowInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      await this.requireMissionContext(
        query,
        principal,
        projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
      );
      const replay = await this.claimIdempotency(
        query,
        `flow:create:${projectId}`,
        input.idempotencyKey,
        hash(input),
      );
      if (replay) return replay;
      const validation = await this.validateWith(
        query,
        principal,
        { projectId, environmentId: input.environmentId, plan: input.plan },
      );
      this.requireValid(validation);
      const flowId = randomUUID();
      const revisionId = randomUUID();
      await query(
        `INSERT INTO flows(
           id,project_id,name,description,latest_revision_id,visibility,purpose,
           origin_mission_id,origin_objective_id,owner_mission_id,owner_objective_id,
           created_by_agent_session_id,publication_state
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,'published')`,
        [
          flowId,
          projectId,
          input.name,
          input.description,
          revisionId,
          input.visibility,
          input.purpose,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
        ],
      );
      await query(
        `INSERT INTO flow_revisions(
           id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason,
           publication_state
         ) VALUES($1,$2,1,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,'published')`,
        [
          revisionId,
          flowId,
          JSON.stringify(input.content),
          JSON.stringify(input.plan),
          JSON.stringify(validation),
          input.agentSessionId,
          input.reason,
        ],
      );
      await query(
        `INSERT INTO mission_flow_links(
           mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.missionId,
          input.objectiveId,
          flowId,
          input.visibility,
          input.purpose,
          input.reason,
          input.agentSessionId,
        ],
      );
      const response = { flowId, revisionId, revision: 1, validation, replayed: false };
      await this.completeIdempotency(
        query,
        `flow:create:${projectId}`,
        input.idempotencyKey,
        response,
      );
      return response;
    });
  }

  async listFlows(principal: Principal, projectId: string, visibility = "reusable") {
    return (this.reads ?? new FlowReadRepository(this.database)).list(
      principal,
      projectId,
      visibility,
    );
  }

  async getFlow(principal: Principal, flowId: string) {
    return (this.reads ?? new FlowReadRepository(this.database)).getPublished(principal, flowId);
  }

  async reviseFlow(principal: Principal, flowId: string, input: CreateFlowRevisionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      const flow = await this.requireFlow(query, principal, flowId, true);
      await this.requireMissionContext(
        query,
        principal,
        flow.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        flowId,
      );
      const replay = await this.claimIdempotency(
        query,
        `flow:revise:${flowId}`,
        input.idempotencyKey,
        hash(input),
      );
      if (replay) return replay;
      if (flow.latestRevisionId !== input.expectedRevisionId)
        throw new ConflictException({
          code: "FLOW_REVISION_CONFLICT",
          message: "The Flow changed after it was read.",
          actualRevisionId: flow.latestRevisionId,
        });
      const validation = await this.validateWith(
        query,
        principal,
        { projectId: flow.projectId, environmentId: input.environmentId, plan: input.plan },
      );
      this.requireValid(validation);
      const revisionId = randomUUID();
      const revision = flow.revision + 1;
      await query(
        `INSERT INTO flow_revisions(
           id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason,
           publication_state
         ) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,'published')`,
        [
          revisionId,
          flowId,
          revision,
          JSON.stringify(input.content),
          JSON.stringify(input.plan),
          JSON.stringify(validation),
          input.agentSessionId,
          input.reason,
        ],
      );
      await query(
        `UPDATE flows SET latest_revision_id=$2,name=COALESCE($3,name),
           description=COALESCE($4,description),publication_state='published',updated_at=now()
         WHERE id=$1`,
        [flowId, revisionId, input.name ?? null, input.description ?? null],
      );
      const response = { flowId, revisionId, revision, validation, replayed: false };
      await this.completeIdempotency(
        query,
        `flow:revise:${flowId}`,
        input.idempotencyKey,
        response,
      );
      return response;
    });
  }

  async bindCalibration(principal: Principal, flowId: string, input: BindCalibrationInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      const flow = await this.requireFlow(query, principal, flowId, true);
      await this.requireMissionContext(
        query,
        principal,
        flow.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        flowId,
      );
      const replay = await this.claimIdempotency(
        query,
        `flow:calibration:${flowId}`,
        input.idempotencyKey,
        hash(input),
      );
      if (replay) return replay;
      if (flow.latestRevisionId !== input.expectedRevisionId)
        throw new ConflictException({
          code: "FLOW_REVISION_CONFLICT",
          message: "The Flow changed after it was read.",
          actualRevisionId: flow.latestRevisionId,
        });
      const current = await query<{ content: unknown; plan: CurrentPlan }>(
        `SELECT content,plan FROM flow_revisions WHERE id=$1 AND flow_id=$2`,
        [flow.latestRevisionId, flowId],
      );
      let matches = 0;
      const plan: CurrentPlan = {
        ...current.rows[0]!.plan,
        steps: current.rows[0]!.plan.steps.map((step) => {
          if (
            step.action.type !== "protectedTransaction" ||
            step.action.operationId !== input.operationId
          )
            return step;
          matches += 1;
          return {
            ...step,
            action: { ...step.action, calibrationAttestationId: input.attestationId },
          };
        }),
      };
      if (matches !== 1)
        throw new ConflictException({
          code: matches ? "CALIBRATION_OPERATION_AMBIGUOUS" : "CALIBRATION_OPERATION_MISMATCH",
          message: "The Flow must contain exactly one matching protected operation.",
        });
      const validation = await this.validateWith(
        query,
        principal,
        { projectId: flow.projectId, environmentId: input.environmentId, plan },
      );
      this.requireValid(validation);
      const revisionId = randomUUID();
      const nextRevision = flow.revision + 1;
      await query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`,
        [
          revisionId,
          flowId,
          nextRevision,
          JSON.stringify(current.rows[0]!.content),
          JSON.stringify(plan),
          JSON.stringify(validation),
          input.agentSessionId,
          input.reason,
        ],
      );
      await query(`UPDATE flows SET latest_revision_id=$2,updated_at=now() WHERE id=$1`, [
        flowId,
        revisionId,
      ]);
      const response = {
        flowId,
        revisionId,
        revision: nextRevision,
        attestationId: input.attestationId,
        validation,
        replayed: false,
      };
      await this.completeIdempotency(
        query,
        `flow:calibration:${flowId}`,
        input.idempotencyKey,
        response,
      );
      return response;
    });
  }

  async createRun(principal: Principal, projectId: string, input: CreateFlowRunInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.database.transaction(async (client) => {
      const query = bindQuery(client);
      await this.requireMissionContext(
        query,
        principal,
        projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
      );
      const replay = await this.claimIdempotency(
        query,
        `run:create:${projectId}`,
        input.idempotencyKey,
        hash(input),
      );
      if (replay) return replay;
      const unknownMutation = await query(
        `SELECT 1 FROM adaptive_operations operation JOIN adaptive_sessions session ON session.id=operation.session_id
         WHERE session.mission_id=$1 AND operation.mutation_outcome='unknown' AND adaptive_operation_unknown_unresolved(operation.session_id,operation.operation_id) LIMIT 1`,
        [input.missionId],
      );
      if (unknownMutation.rowCount)
        throw new ConflictException({
          code: "MISSION_RECONCILIATION_REQUIRED",
          mutationOutcome: "unknown",
          safeActions: ["get_flow_authoring"],
        });
      await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [projectId]);
      const active = await query<{ count: string }>(
        `SELECT count(*)::text count FROM mission_objective_orchestration x JOIN missions m ON m.id=x.mission_id WHERE m.project_id=$1 AND x.state IN ('queued','running')`,
        [projectId],
      );
      if (Number(active.rows[0]!.count) >= 3)
        throw new ConflictException({ code: "PROJECT_CONCURRENCY_LIMIT", limit: 3 });
      const revision = await query<{ plan: CurrentPlan; flowId: string }>(
        `SELECT fr.plan, fr.flow_id AS "flowId"
         FROM flow_revisions fr JOIN flows f ON f.id = fr.flow_id
         JOIN projects p ON p.id = f.project_id
         WHERE fr.id = $1 AND f.project_id = $2
           AND ($3::uuid IS NULL OR p.workspace_id = $3)`,
        [input.flowRevisionId, projectId, workspaceId(principal)],
      );
      if (!revision.rowCount) throw new NotFoundException("Flow revision not found");
      const protectedOperations = revision.rows[0]!.plan.steps.flatMap((step) =>
        step.action.type === "protectedTransaction" ? [step.action.operationId] : [],
      );
      const authorizationByOperation = new Map(
        input.protectedAuthorizations.map((binding) => [binding.operationId, binding.authorizationId]),
      );
      for (const operationId of protectedOperations) {
        const authorizationId = authorizationByOperation.get(operationId);
        if (!authorizationId)
          throw new ConflictException({ code: "PROTECTED_OPERATION_AUTHORIZATION_REQUIRED", operationId });
        const authorized = await query(
          `SELECT 1 FROM mission_authorizations
           WHERE id=$1 AND mission_id=$2 AND objective_id=$3 AND environment_id=$4
             AND kind='protected_mutation' AND operation_id=$5 AND status='approved'
             AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
          [authorizationId, input.missionId, input.objectiveId, input.environmentId, operationId],
        );
        if (!authorized.rowCount)
          throw new ConflictException({ code: "PROTECTED_OPERATION_AUTHORIZATION_INVALID", operationId });
      }
      const runtime = browserObservationRuntimeHealth();
      if (!runtime.healthy)
        throw new ServiceUnavailableException({
          code: "BROWSER_RUNTIME_UNHEALTHY",
          diagnostics: runtime.diagnostics,
        });
      const validation = await this.validateWith(
        query,
        principal,
        {
          projectId,
          environmentId: input.environmentId,
          plan: revision.rows[0]!.plan,
        },
      );
      this.requireValid(validation);
      const environment = await query<{
        name: string;
        baseOrigin: string;
        policy: unknown;
        secretRefs: string[];
        veilPreferences: import("@scry/contracts").VeilPolicyPreferences | null;
      }>(
        `SELECT environment.name,environment.base_origin AS "baseOrigin",environment.policy,environment.secret_refs AS "secretRefs",veil.preferences AS "veilPreferences"
         FROM environments environment LEFT JOIN veil_environment_preferences veil ON veil.environment_id=environment.id
         WHERE environment.id = $1 AND environment.project_id = $2 FOR SHARE OF environment`,
        [input.environmentId, projectId],
      );
      const executionPolicy = executionPolicySchema.parse(environment.rows[0]!.policy);
      const veilPolicySnapshot = snapshotVeilPolicy(
        executionPolicy,
        environment.rows[0]!.veilPreferences,
      );
      const run = await query<{ id: string; state: string }>(
        `INSERT INTO runs(project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,compiled_contract_id,compiled_contract_digest,state,phase,
                          plan_snapshot, environment_snapshot, policy_snapshot,veil_policy_snapshot, execution_snapshot, idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','queued',$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14)
         RETURNING id, state`,
        [
          projectId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          input.environmentId,
          input.flowRevisionId,
          input.compiledContractId,
          null,
          JSON.stringify(revision.rows[0]!.plan),
          JSON.stringify({
            id: input.environmentId,
            ...environment.rows[0],
            veilPreferences: undefined,
          }),
          JSON.stringify(executionPolicy),
          JSON.stringify(veilPolicySnapshot),
          JSON.stringify({
            browser: input.browser,
            viewport: input.viewport,
            seed: input.seed,
            executionModel: input.executionModel,
            protectedAuthorizations: Object.fromEntries(authorizationByOperation),
          }),
          input.idempotencyKey,
        ],
      );
      await query(
        `INSERT INTO mission_run_links(run_id,mission_id,objective_id,role,reason,classified_by_agent_session_id) VALUES($1,$2,$3,$4,'Run created',$5)`,
        [run.rows[0]!.id, input.missionId, input.objectiveId, input.role, input.agentSessionId],
      );
      await query(
        `UPDATE mission_objective_orchestration SET state='queued',active_run_id=$2,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE objective_id=$1`,
        [input.objectiveId, run.rows[0]!.id],
      );
      await query(
        `UPDATE mission_objectives SET latest_candidate_run_id=$2,status=CASE WHEN status='pending' THEN 'running' ELSE status END,updated_at=now() WHERE id=$1`,
        [input.objectiveId, run.rows[0]!.id],
      );
      await query(
        `UPDATE missions SET status=CASE WHEN status='planning' THEN 'running' ELSE status END,updated_at=now(),revision=revision+1 WHERE id=$1`,
        [input.missionId],
      );
      await query(
        `INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata) VALUES($1,$2,$3,'run_started','Run queued',$4::jsonb)`,
        [
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          JSON.stringify({
            runId: run.rows[0]!.id,
            flowRevisionId: input.flowRevisionId,
            role: input.role,
          }),
        ],
      );
      await query(
        `INSERT INTO run_outbox(run_id, release_id, schema_fingerprint) VALUES ($1, $2, $3)`,
        [
          run.rows[0]!.id,
          process.env.SCRY_RELEASE_ID ?? "development",
          process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline",
        ],
      );
      const response = {
        runId: run.rows[0]!.id,
        state: run.rows[0]!.state,
        validation,
        replayed: false,
      };
      await this.completeIdempotency(
        query,
        `run:create:${projectId}`,
        input.idempotencyKey,
        response,
      );
      return response;
    });
  }

  private async validateWith(
    query: Query,
    principal: Principal,
    input: ValidatePlanInput,
  ) {
    await this.requireProject(query, principal, input.projectId);
    const environment = await query<{ policy: unknown; secretRefs: string[] }>(
      `SELECT policy, secret_refs AS "secretRefs" FROM environments WHERE id = $1 AND project_id = $2`,
      [input.environmentId, input.projectId],
    );
    if (!environment.rowCount) throw new NotFoundException("Environment not found");
    const mechanical: Diagnostic[] = [];
    const quality: Diagnostic[] = [];
    const observer = browserObservationRuntimeHealth();
    if (!observer.healthy) {
      mechanical.push({
        severity: "error",
        code: "FLOW_CAPABILITY_UNAVAILABLE",
        message: "The Browser Observation Runtime failed its self-contained artifact check.",
        suggestion: "Deploy a healthy capability-grounding worker before accepting Flows.",
      });
    }
    const policy = executionPolicySchema.parse(environment.rows[0]!.policy);
    mechanical.push(
      ...validatePlanAgainstPolicy(input.plan, policy).map((item) => ({
        severity: "error" as const,
        ...item,
      })),
    );
    const requestedAdapters = adapterReferences(input.plan);
    if (requestedAdapters.length) {
      const registered = await query<{ id: string; permittedOrigins: string[] }>(
        `SELECT id,permitted_origins AS "permittedOrigins" FROM adapter_registrations WHERE id=ANY($1::text[])`,
        [requestedAdapters],
      );
      const byId = new Map(registered.rows.map((item) => [item.id, item]));
      for (const id of requestedAdapters) {
        const adapter = byId.get(id);
        if (
          !adapter ||
          input.plan.allowedOrigins.some((origin) => !adapter.permittedOrigins.includes(origin))
        )
          mechanical.push({
            severity: "error",
            code: "FLOW_CAPABILITY_UNAVAILABLE",
            message: `Reviewed adapter ${id} is unavailable for every allowed origin.`,
            suggestion: "Use a registered origin-bound adapter or remove the adapter request.",
          });
      }
    }
    const refs = secretReferences(input.plan);
    quality.push(
      ...analyzePlanRisks(input.plan).errors.map((item) => ({
        ...item,
      })),
      ...analyzePlanRisks(input.plan).warnings.map((item) => ({
        ...item,
      })),
    );
    const allowed = new Set(environment.rows[0]!.secretRefs);
    for (const reference of refs.filter((item) => !allowed.has(item))) {
      mechanical.push({
        severity: "error",
        code: "CREDENTIAL_NOT_AUTHORIZED",
        message: `Credential ${reference} is not authorized in this environment.`,
      });
    }
    if (refs.length) {
      const active = await query<{ id: string }>(
        `SELECT id::text FROM project_credentials WHERE project_id = $1 AND deleted_at IS NULL AND security_status = 'active' AND id = ANY($2::uuid[])`,
        [input.projectId, refs],
      ).catch((error) => {
        throw new ServiceUnavailableException({
          code: "CREDENTIAL_STORAGE_FAILURE",
          message: "Credential storage could not be validated.",
          cause: error instanceof Error ? error.message : String(error),
        });
      });
      const ids = new Set(active.rows.map(({ id }) => String(id)));
      for (const reference of refs.filter((item) => !ids.has(item))) {
        mechanical.push({
          severity: "error",
          code: "CREDENTIAL_UNAVAILABLE",
          message: `Credential ${reference} is missing or deleted.`,
        });
      }
    }
    return {
      correlationId: randomUUID(),
      valid: !mechanical.some(({ severity }) => severity === "error"),
      mechanical,
      quality,
      errors: mechanical.concat(quality).filter(({ severity }) => severity === "error"),
      warnings: mechanical.concat(quality).filter(({ severity }) => severity === "warning"),
      validatedAt: new Date().toISOString(),
    };
  }

  private requireValid(validation: { valid: boolean; errors: Diagnostic[] }) {
    if (!validation.valid)
      throw new ConflictException({
        code: "PLAN_VALIDATION_FAILED",
        message: "Plan validation failed",
        ...validation,
      });
  }

  private async requireProject(query: Query, principal: Principal, projectId: string) {
    const result = await query(
      `SELECT 1 FROM projects WHERE id = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`,
      [projectId, workspaceId(principal)],
    );
    if (!result.rowCount) throw new NotFoundException("Project not found");
  }

  private async requireMissionContext(
    query: Query,
    principal: Principal,
    projectId: string,
    missionId: string,
    objectiveId: string,
    agentSessionId: string,
    flowId?: string,
  ) {
    const context = await query(
      `SELECT 1 FROM missions m
       JOIN projects p ON p.id=m.project_id
       JOIN mission_objectives o ON o.mission_id=m.id AND o.id=$3
       JOIN agent_sessions s ON s.mission_id=m.id AND s.id=$4 AND s.status='active'
       WHERE m.id=$2 AND m.project_id=$1 AND ($5::uuid IS NULL OR p.workspace_id=$5)`,
      [projectId, missionId, objectiveId, agentSessionId, workspaceId(principal)],
    );
    if (!context.rowCount)
      throw new ConflictException({
        code: "MISSION_CONTEXT_INVALID",
        message:
          "Mission, objective, and active agent session must belong to the selected project.",
      });
    if (flowId) {
      const linked = await query(
        `SELECT 1 FROM mission_flow_links WHERE mission_id=$1 AND flow_id=$2`,
        [missionId, flowId],
      );
      if (!linked.rowCount)
        throw new ConflictException({
          code: "FLOW_NOT_ATTACHED_TO_MISSION",
          message: "Attach the Flow before revising it in this Mission.",
        });
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
    await query(
      `INSERT INTO idempotency_records(scope, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [scope, key, requestHash],
    );
    const record = await query<{ requestHash: string; response?: unknown }>(
      `SELECT request_hash AS "requestHash", response FROM idempotency_records WHERE scope = $1 AND key = $2 FOR UPDATE`,
      [scope, key],
    );
    if (record.rows[0]!.requestHash !== requestHash)
      throw new ConflictException({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency key was used with a different request.",
      });
    return record.rows[0]!.response as Record<string, unknown> | undefined;
  }

  private completeIdempotency(query: Query, scope: string, key: string, response: unknown) {
    return query(
      `UPDATE idempotency_records SET response = $3::jsonb, completed_at = now() WHERE scope = $1 AND key = $2`,
      [scope, key, JSON.stringify(response)],
    );
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer")
      throw new ForbiddenException("Workspace viewers have read-only access");
  }
}

export function readImmutableFlowContractVersion(
  contractVersion: string,
  flowRevisionId: string | null,
) {
  if (contractVersion === "v2-learned-interactions") return contractVersion;
  if (contractVersion === "v1-existing" && flowRevisionId) return contractVersion;
  throw new ConflictException({ code: "UNSUPPORTED_FLOW_CONTRACT_VERSION" });
}

function adapterReferences(plan: CurrentPlan) {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (step.action.type === "capturePublicValue" && step.action.capture.acquisition.adapter)
      ids.add(step.action.capture.acquisition.adapter.id);
    if (step.action.type !== "protectedTransaction") continue;
    for (const output of step.action.extraction.outputs)
      if (output.acquisition.adapter) ids.add(output.acquisition.adapter.id);
    const reconciliation = step.action.mutation.reconciliation;
    if (reconciliation.strategy === "adapter" || reconciliation.strategy === "public_api_state")
      ids.add(reconciliation.adapterId);
    if (step.action.revocationAdapter) ids.add(step.action.revocationAdapter.adapterId);
  }
  return [...ids];
}

function bindQuery(client: PoolClient): Query {
  return (text, values = []) => client.query(text, values);
}
function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function secretReferences(plan: CurrentPlan) {
  return [
    ...new Set(
      plan.steps.flatMap(({ action }) => {
        if (action.type === "fill" && action.secretRef) return [action.secretRef];
        if (action.type === "protectedTransaction")
          return Object.values(action.inputs).flatMap((input) =>
            input.classification === "known_secret" ? [input.credentialRef] : [],
          );
        return [];
      }),
    ),
  ];
}
