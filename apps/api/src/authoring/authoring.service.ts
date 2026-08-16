import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  currentPlanSchema,
  executionPolicySchema,
  learnedInteractionRecordSchema,
  protectedAcquisitionEvidenceSchema,
  type CompileFlowDraftInput,
  type CompileAndCertifyFlowInput,
  type CreateAuthenticationContractInput,
  type CreateFlowDraftInput,
  type CurrentPlan,
  type PublishFlowDraftInput,
  type StartProbeSessionInput,
  type UpdateFlowDraftInput,
  validatePlanAgainstPolicy,
} from "@scry/contracts";
import { browserObservationRuntimeHealth } from "@scry/praxis";

import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { snapshotVeilPolicy } from "../veil/index.js";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

@Injectable()
export class AuthoringService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ReleaseAdmissionService)
    private readonly admission: ReleaseAdmissionService,
  ) {}

  async createDraft(principal: Principal, input: CreateFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);

      await this.requireContext(
        q,
        principal,
        input.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );

      const replay = await q<{
        id: string;
        version: number;
        state: string;
      }>(
        `SELECT d.id,d.version,d.state
         FROM flow_drafts d
         JOIN flow_draft_events e ON e.draft_id=d.id
         WHERE d.project_id=$1
           AND e.safe_metadata->>'idempotencyKey'=$2
         LIMIT 1`,
        [input.projectId, input.idempotencyKey],
      );

      if (replay.rowCount) {
        return {
          ...replay.rows[0],
          replayed: true,
        };
      }

      const unknownMutation = await q(
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

      const priorRuns = await q(
        `SELECT 1 FROM runs
         WHERE mission_id=$1
           AND COALESCE((execution_snapshot->>'certificationCandidate')::boolean,false)=false
         LIMIT 1`,
        [input.missionId],
      );
      if (!priorRuns.rowCount && input.predecessorRunId) {
        throw new ConflictException({ code: "FIRST_FLOW_PREDECESSOR_FORBIDDEN" });
      }
      if (priorRuns.rowCount && !input.predecessorRunId) {
        throw new ConflictException({
          code: "SUCCESSOR_PREDECESSOR_RUN_REQUIRED",
          safeActions: ["get_mission"],
        });
      }
      if (input.predecessorRunId) {
        const predecessor = await q(
          `SELECT 1 FROM runs run
           JOIN run_successor_checkpoints checkpoint ON checkpoint.run_id=run.id
           WHERE run.id=$1 AND run.mission_id=$2
             AND run.environment_id=$3 AND run.state='passed'
             AND COALESCE((run.execution_snapshot->>'certificationCandidate')::boolean,false)=false
             AND run.outcome_classification='passed'
             AND checkpoint.state='available' AND checkpoint.expires_at>now()
             AND checkpoint.claimed_by_authoring_session_id IS NULL`,
          [input.predecessorRunId, input.missionId, input.environmentId],
        );
        if (!predecessor.rowCount)
          throw new ConflictException({
            code: "SUCCESSOR_CHECKPOINT_UNAVAILABLE",
            safeActions: ["get_mission"],
          });
      }

      const id = randomUUID();

      await q(
        `INSERT INTO flow_drafts(
          id,
          project_id,
          mission_id,
          objective_id,
          environment_id,
          flow_id,
          name,
          description,
          purpose,
          content,
          state,
          version,
          plan,
          predecessor_run_id,
          created_by_agent_session_id
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
          'editing',1,$11::jsonb,$12,$13
        )`,
        [
          id,
          input.projectId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.flowId ?? null,
          input.name,
          input.description,
          input.purpose ?? "primary",
          JSON.stringify(input.content),
          JSON.stringify(input.plan),
          input.predecessorRunId ?? null,
          input.agentSessionId,
        ],
      );

      await this.event(q, id, 1, "created", input.agentSessionId, "Flow draft created", {
        idempotencyKey: input.idempotencyKey,
      });

      await this.activity(q, input, "Flow draft created", {
        draftId: id,
        ...(input.predecessorRunId ? { predecessorRunId: input.predecessorRunId } : {}),
      });

      return {
        id,
        version: 1,
        state: "editing",
        replayed: false,
      };
    });
  }

  async updateDraft(principal: Principal, draftId: string, input: UpdateFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);

      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );

      if (d.version !== input.expectedVersion) {
        throw new ConflictException({
          code: "FLOW_DRAFT_VERSION_CONFLICT",
          actualVersion: d.version,
        });
      }

      if (["published", "abandoned"].includes(d.state)) {
        throw new ConflictException({
          code: "FLOW_DRAFT_IMMUTABLE",
          state: d.state,
        });
      }

      const updated = await q<{
        version: number;
        state: string;
      }>(
        `UPDATE flow_drafts
         SET name=COALESCE($2,name),
             description=COALESCE($3,description),
             content=COALESCE($4::jsonb,content),
             plan=COALESCE($5::jsonb,plan),
             version=version+1,
             state='editing',
             updated_at=now()
         WHERE id=$1
         RETURNING version,state`,
        [
          draftId,
          input.name ?? null,
          input.description ?? null,
          input.content ? JSON.stringify(input.content) : null,
          input.plan ? JSON.stringify(input.plan) : null,
        ],
      );

      await q(
        `UPDATE flow_compilations
         SET status='stale',
             invalidated_at=now()
         WHERE draft_id=$1
           AND status IN (
             'pending',
             'execution_ready',
             'calibration_required'
           )`,
        [draftId],
      );

      await this.event(
        q,
        draftId,
        updated.rows[0]!.version,
        "updated",
        input.agentSessionId,
        input.reason,
        {},
      );

      return {
        id: draftId,
        ...updated.rows[0],
      };
    });
  }

  async getDraft(principal: Principal, draftId: string) {
    const d = await this.requireDraft(
      (text, values) => this.db.query(text, values),
      principal,
      draftId,
      false,
    );

    const [events, probes, compilations] = await Promise.all([
      this.db.query(
        `SELECT
             version,
             type,
             summary,
             safe_metadata AS "safeMetadata",
             occurred_at AS "occurredAt"
           FROM flow_draft_events
           WHERE draft_id=$1
           ORDER BY id`,
        [draftId],
      ),
      this.db.query(
        `SELECT
             id,
             draft_version AS "draftVersion",
             level,
             state,
             result,
             failure_provenance AS "failureProvenance",
             reason_code AS "reasonCode",
             created_at AS "createdAt",
             completed_at AS "completedAt"
           FROM probe_sessions
           WHERE draft_id=$1
           ORDER BY created_at DESC`,
        [draftId],
      ),
      this.db.query(
        `SELECT
             id,
             draft_version AS "draftVersion",
             flow_revision_id AS "flowRevisionId",
             status,
             compiled_plan AS "compiledPlan",
             diagnostics,
             compiled_contract_digest AS "compiledContractDigest",
             created_at AS "createdAt"
           FROM flow_compilations
           WHERE draft_id=$1
           ORDER BY created_at DESC`,
        [draftId],
      ),
    ]);

    return {
      ...d,
      events: events.rows,
      probes: probes.rows,
      compilations: compilations.rows,
    };
  }

  async listDrafts(principal: Principal, missionId: string) {
    await this.requireMission((text, values) => this.db.query(text, values), principal, missionId);

    return (
      await this.db.query(
        `SELECT
           id,
           project_id AS "projectId",
           mission_id AS "missionId",
           objective_id AS "objectiveId",
           environment_id AS "environmentId",
           flow_id AS "flowId",
           name,
           description,
           purpose,
           state,
           version,
           published_revision_id AS "publishedRevisionId",
           updated_at AS "updatedAt"
         FROM flow_drafts
         WHERE mission_id=$1
         ORDER BY updated_at DESC`,
        [missionId],
      )
    ).rows;
  }

  async abandonDraft(
    principal: Principal,
    draftId: string,
    input: {
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
      expectedVersion: number;
      reason: string;
    },
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);

      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );

      if (d.version !== input.expectedVersion) {
        throw new ConflictException({
          code: "FLOW_DRAFT_VERSION_CONFLICT",
          actualVersion: d.version,
        });
      }

      if (d.state === "published") {
        throw new ConflictException({
          code: "PUBLISHED_DRAFT_CANNOT_BE_ABANDONED",
        });
      }

      const result = await q<{
        version: number;
        state: string;
      }>(
        `UPDATE flow_drafts
         SET state='abandoned',
             version=version+1,
             updated_at=now()
         WHERE id=$1
         RETURNING version,state`,
        [draftId],
      );

      await q(
        `UPDATE flow_compilations
         SET status='superseded',
             invalidated_at=now()
         WHERE draft_id=$1
           AND status NOT IN ('superseded','stale')`,
        [draftId],
      );

      await this.event(
        q,
        draftId,
        result.rows[0]!.version,
        "abandoned",
        input.agentSessionId,
        input.reason,
        {},
      );

      return {
        id: draftId,
        ...result.rows[0],
      };
    });
  }

  async getProbe(principal: Principal, probeId: string) {
    const result = await this.db.query(
      `SELECT
         p.id,
         p.draft_id AS "draftId",
         p.mission_id AS "missionId",
         p.objective_id AS "objectiveId",
         p.draft_version AS "draftVersion",
         p.mode,
         p.level,
         p.state,
         p.result,
         p.failure_provenance AS "failureProvenance",
         p.reason_code AS "reasonCode",
         p.created_at AS "createdAt",
         p.started_at AS "startedAt",
         p.completed_at AS "completedAt",
         CASE
           WHEN authoring.probe_session_id IS NULL THEN NULL
           ELSE jsonb_build_object(
             'status', authoring.status,
             'activePageId', authoring.active_page_id,
             'activeFrameId', authoring.active_frame_id,
             'currentUrl', authoring.current_url,
             'documentEpoch', authoring.document_epoch,
             'actionsUsed', authoring.actions_used,
             'actionBudget', authoring.action_budget,
             'durationBudgetMs', authoring.duration_budget_ms::text,
             'deadlineAt', authoring.deadline_at,
             'veilState', authoring.veil_state,
             'resumePointer', authoring.resume_pointer,
             'lastObservationId', authoring.last_observation_id,
             'pendingInteraction', authoring.pending_interaction,
             'createdAt', authoring.created_at,
             'updatedAt', authoring.updated_at,
             'completedAt', authoring.completed_at
           )
         END AS authoring,
         CASE
           WHEN lease.id IS NULL THEN NULL
           ELSE jsonb_build_object(
             'id', lease.id,
             'state', lease.state,
             'runtimeOwnerId', lease.runtime_owner_id,
             'heartbeatAt', lease.heartbeat_at,
             'expiresAt', lease.expires_at,
             'createdAt', lease.created_at,
             'updatedAt', lease.updated_at,
             'releasedAt', lease.released_at
           )
         END AS "browserLease"
       FROM probe_sessions p
       JOIN missions m
         ON m.id=p.mission_id
       JOIN projects project
         ON project.id=m.project_id
       LEFT JOIN probe_authoring_sessions authoring
         ON authoring.probe_session_id=p.id
       LEFT JOIN authoring_browser_leases lease
         ON lease.id=authoring.browser_lease_id
       WHERE p.id=$1
         AND (
           $2::uuid IS NULL
           OR project.workspace_id=$2
         )`,
      [probeId, workspace(principal)],
    );

    if (!result.rowCount) {
      throw new NotFoundException("Probe Session not found");
    }

    return result.rows[0];
  }

  async startProbe(principal: Principal, draftId: string, input: StartProbeSessionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);

      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );

      if (d.version !== input.draftVersion) {
        throw new ConflictException({
          code: "STALE_DRAFT_VERSION",
          actualVersion: d.version,
        });
      }

      if (input.level === "calibration_transaction") {
        const auth = await q(
          `SELECT 1
           FROM mission_authorizations
           WHERE id=$1
             AND mission_id=$2
             AND objective_id=$3
             AND environment_id=$4
             AND kind='authentication_calibration'
             AND status='approved'
             AND (
               expires_at IS NULL
               OR expires_at>now()
             )`,
          [input.authorizationId, input.missionId, input.objectiveId, input.environmentId],
        );

        if (!auth.rowCount) {
          throw new ConflictException({
            code: "PROBE_AUTHORIZATION_REQUIRED",
          });
        }
      }

      const existing = await q<{
        id: string;
        state: string;
        mode: "queued" | "interactive";
      }>(
        `SELECT id,state,mode
         FROM probe_sessions
         WHERE draft_id=$1
           AND idempotency_key=$2`,
        [draftId, input.idempotencyKey],
      );

      if (existing.rowCount) {
        return {
          ...existing.rows[0],
          replayed: true,
        };
      }

      if (input.authenticationContractRevisionId) {
        const contract = await q(
          `SELECT 1
           FROM authentication_contract_revisions r
           JOIN authentication_contracts c
             ON c.id=r.contract_id
           WHERE r.id=$1
             AND c.project_id=$2
             AND c.environment_id=$3
             AND r.revoked_at IS NULL
             AND (
               r.expires_at IS NULL
               OR r.expires_at>now()
             )`,
          [input.authenticationContractRevisionId, d.projectId, input.environmentId],
        );

        if (!contract.rowCount) {
          throw new ConflictException({
            code: "AUTHENTICATION_CONTRACT_INVALID",
          });
        }
      }

      if (input.mode === "interactive") {
        const active = await q(
          `SELECT 1
           FROM probe_sessions p
           JOIN probe_authoring_sessions authoring
             ON authoring.probe_session_id=p.id
           WHERE p.draft_id=$1
             AND p.mode='interactive'
             AND authoring.status IN (
               'starting',
               'active',
               'suspended',
               'completing'
             )
           LIMIT 1`,
          [draftId],
        );

        if (active.rowCount) {
          throw new ConflictException({
            code: "INTERACTIVE_PROBE_ALREADY_ACTIVE",
          });
        }
      }

      const plan = currentPlanSchema.parse(d.plan);
      const id = randomUUID();

      await q(
        `INSERT INTO probe_sessions(
          id,
          draft_id,
          mission_id,
          objective_id,
          environment_id,
          draft_version,
          mode,
          level,
          authorization_id,
          disposable_data_confirmed,
          authentication_contract_revision_id,
          created_by_agent_session_id,
          idempotency_key
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
        )`,
        [
          id,
          draftId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.draftVersion,
          input.mode,
          input.level,
          input.authorizationId ?? null,
          input.disposableDataConfirmed,
          input.authenticationContractRevisionId ?? null,
          input.agentSessionId,
          input.idempotencyKey,
        ],
      );

      await q(
        `UPDATE flow_drafts
         SET state='probing',
             updated_at=now()
         WHERE id=$1`,
        [draftId],
      );

      let authoring:
        | {
            status: string;
            documentEpoch: number;
            actionsUsed: number;
            actionBudget: number;
            durationBudgetMs: string;
            deadlineAt: Date;
            veilState: Record<string, unknown>;
          }
        | undefined;

      let browserLease:
        | {
            id: string;
            state: string;
            expiresAt: Date;
          }
        | undefined;

      if (input.mode === "queued") {
        await q(
          `INSERT INTO probe_outbox(
            probe_session_id,
            release_id,
            schema_fingerprint
          )
          VALUES($1,$2,$3)`,
          [id, releaseId(), schemaFingerprint()],
        );
      } else {
        const leaseId = randomUUID();

        const lease = await q<{
          id: string;
          state: string;
          expiresAt: Date;
        }>(
          `INSERT INTO authoring_browser_leases(
             id,
             probe_session_id,
             state,
             expires_at
           )
           VALUES(
             $1,
             $2,
             'provisioning',
             now() + make_interval(secs => $3::double precision / 1000)
           )
           RETURNING
             id,
             state,
             expires_at AS "expiresAt"`,
          [leaseId, id, plan.budgets.maxDurationMs],
        );

        const session = await q<{
          status: string;
          documentEpoch: number;
          actionsUsed: number;
          actionBudget: number;
          durationBudgetMs: string;
          deadlineAt: Date;
          veilState: Record<string, unknown>;
        }>(
          `INSERT INTO probe_authoring_sessions(
             probe_session_id,
             browser_lease_id,
             status,
             action_budget,
             duration_budget_ms,
             deadline_at,
             veil_state
           )
           VALUES(
             $1,
             $2,
             'starting',
             $3,
             $4,
             now() + make_interval(secs => ($6::double precision) / 1000),
             $5::jsonb
           )
           RETURNING
             status,
             document_epoch AS "documentEpoch",
             actions_used AS "actionsUsed",
             action_budget AS "actionBudget",
             duration_budget_ms::text AS "durationBudgetMs",
             deadline_at AS "deadlineAt",
             veil_state AS "veilState"`,
          [
            id,
            leaseId,
            plan.budgets.maxActions,
            plan.budgets.maxDurationMs,
            JSON.stringify({ status: "initializing" }),
            plan.budgets.maxDurationMs,
          ],
        );

        await q(
          `INSERT INTO probe_events(
             probe_session_id,
             sequence,
             type,
             safe_payload
           )
           VALUES
             (
               $1,
               1,
               'authoring_session_started',
               $2::jsonb
             ),
             (
               $1,
               2,
               'browser_lease_attached',
               $3::jsonb
             )`,
          [
            id,
            JSON.stringify({
              actionBudget: plan.budgets.maxActions,
              durationBudgetMs: plan.budgets.maxDurationMs,
              documentEpoch: 0,
            }),
            JSON.stringify({
              browserLeaseId: leaseId,
              state: "provisioning",
            }),
          ],
        );

        authoring = session.rows[0]!;
        browserLease = lease.rows[0]!;
      }

      await this.event(
        q,
        draftId,
        d.version,
        "probe_started",
        input.agentSessionId,
        input.mode === "interactive"
          ? "Interactive Probe Session starting"
          : "Probe Session queued",
        {
          probeSessionId: id,
          mode: input.mode,
          level: input.level,
        },
      );

      return {
        id,
        state: "queued",
        mode: input.mode,
        replayed: false,
        ...(authoring ? { authoring } : {}),
        ...(browserLease ? { browserLease } : {}),
      };
    });
  }

  async cancelProbe(
    principal: Principal,
    probeId: string,
    missionId: string,
    agentSessionId: string,
  ) {
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);

      const owned = await q<{
        id: string;
        draftId: string;
        mode: "queued" | "interactive";
        state: string;
      }>(
        `SELECT
           p.id,
           p.draft_id AS "draftId",
           p.mode,
           p.state
         FROM probe_sessions p
         JOIN missions m
           ON m.id=p.mission_id
         JOIN agent_sessions s
           ON s.id=$3
          AND s.mission_id=p.mission_id
         WHERE p.id=$1
           AND p.mission_id=$2
           AND (
             $4::uuid IS NULL
             OR m.project_id IN (
               SELECT project_id
               FROM projects
               WHERE workspace_id=$4
             )
           )
         FOR UPDATE OF p`,
        [probeId, missionId, agentSessionId, workspace(principal)],
      );

      if (!owned.rowCount) {
        throw new NotFoundException("Probe Session not found");
      }

      const probe = owned.rows[0]!;

      await q(
        `UPDATE probe_sessions
         SET cancellation_requested_at=now(),
             state=CASE
               WHEN state='queued' THEN 'cancelled'
               ELSE state
             END,
             completed_at=CASE
               WHEN state='queued' THEN now()
               ELSE completed_at
             END
         WHERE id=$1`,
        [probeId],
      );

      if (probe.mode === "interactive") {
        await q(
          `UPDATE probe_authoring_sessions
           SET status='cancelled',
               completed_at=COALESCE(completed_at,now()),
               updated_at=now(),
               pending_interaction=NULL
           WHERE probe_session_id=$1
             AND status IN (
               'starting',
               'active',
               'suspended',
               'completing'
             )`,
          [probeId],
        );

        await q(
          `UPDATE authoring_browser_leases
           SET state='released',
               released_at=now(),
               updated_at=now()
           WHERE probe_session_id=$1
             AND state IN (
               'provisioning',
               'active',
               'suspended',
               'releasing'
             )`,
          [probeId],
        );

        await q(
          `INSERT INTO probe_events(
             probe_session_id,
             sequence,
             type,
             safe_payload
           )
           SELECT
             $1,
             COALESCE(max(sequence),0)+1,
             'authoring_session_cancelled',
             '{}'::jsonb
           FROM probe_events
           WHERE probe_session_id=$1`,
          [probeId],
        );
      }

      await q(
        `UPDATE flow_drafts
         SET state='editing',
             updated_at=now()
         WHERE id=$1
           AND state='probing'`,
        [probe.draftId],
      );

      return {
        id: probeId,
        state: probe.state === "queued" ? "cancelled" : probe.state,
        mode: probe.mode,
      };
    });
  }

  async compile(principal: Principal, draftId: string, input: CompileFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);

      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );

      if (d.version !== input.draftVersion) {
        throw new ConflictException({
          code: "STALE_DRAFT_VERSION",
          actualVersion: d.version,
        });
      }

      const replay = await q<{
        id: string;
        status: string;
        diagnostics: Array<Record<string, unknown>>;
        contractVersion: string;
        compiledContractDigest: string;
        missionId: string;
        objectiveId: string;
        environmentId: string;
        probeSessionId: string | null;
        authoringSessionId: string | null;
        authenticationContractRevisionId: string | null;
        agentSessionId: string;
      }>(
        `SELECT id,status,diagnostics,
                contract_version AS "contractVersion",
                compiled_contract_digest AS "compiledContractDigest",
                mission_id AS "missionId",
                objective_id AS "objectiveId",
                environment_id AS "environmentId",
                probe_session_id AS "probeSessionId",
                adaptive_session_id AS "authoringSessionId",
                authentication_contract_revision_id AS "authenticationContractRevisionId",
                created_by_agent_session_id AS "agentSessionId"
         FROM flow_compilations
         WHERE draft_id=$1
           AND draft_version=$2
           AND idempotency_key=$3
         FOR UPDATE`,
        [draftId, d.version, input.idempotencyKey],
      );

      if (replay.rowCount) {
        const existing = replay.rows[0]!;
        if (
          existing.missionId !== input.missionId ||
          existing.objectiveId !== input.objectiveId ||
          existing.environmentId !== input.environmentId ||
          existing.probeSessionId !== (input.probeSessionId ?? null) ||
          existing.authoringSessionId !== (input.authoringSessionId ?? null) ||
          existing.authenticationContractRevisionId !==
            (input.authenticationContractRevisionId ?? null) ||
          existing.agentSessionId !== input.agentSessionId
        ) {
          throw new ConflictException({
            code: "IDEMPOTENCY_KEY_REUSED",
            safeActions: ["retry_with_original_request", "use_new_idempotency_key"],
          });
        }

        return {
          id: existing.id,
          status: existing.status,
          diagnostics: existing.diagnostics,
          blockers: [],
          warnings: [],
          qualityFindings: [],
          contractVersion: existing.contractVersion,
          compiledContractDigest: existing.compiledContractDigest,
          replayed: true,
        };
      }

      const current = await q<{
        id: string;
        status: string;
        diagnostics: Array<Record<string, unknown>>;
        contractVersion: string;
        compiledContractDigest: string;
        missionId: string;
        objectiveId: string;
        environmentId: string;
        probeSessionId: string | null;
        authoringSessionId: string | null;
        authenticationContractRevisionId: string | null;
        agentSessionId: string;
      }>(
        `SELECT id,status,diagnostics,contract_version AS "contractVersion",
                compiled_contract_digest AS "compiledContractDigest",
                mission_id AS "missionId",objective_id AS "objectiveId",
                environment_id AS "environmentId",probe_session_id AS "probeSessionId",
                adaptive_session_id AS "authoringSessionId",
                authentication_contract_revision_id AS "authenticationContractRevisionId",
                created_by_agent_session_id AS "agentSessionId"
         FROM flow_compilations
         WHERE draft_id=$1 AND draft_version=$2 AND status='execution_ready'
         FOR UPDATE`,
        [draftId, d.version],
      );
      if (current.rowCount) {
        const existing = current.rows[0]!;
        if (
          existing.missionId !== input.missionId ||
          existing.objectiveId !== input.objectiveId ||
          existing.environmentId !== input.environmentId ||
          existing.probeSessionId !== (input.probeSessionId ?? null) ||
          existing.authoringSessionId !== (input.authoringSessionId ?? null) ||
          existing.authenticationContractRevisionId !==
            (input.authenticationContractRevisionId ?? null) ||
          existing.agentSessionId !== input.agentSessionId
        ) {
          throw new ConflictException({
            code: "CERTIFICATION_COMPILATION_CONFLICT",
            mutationOutcome: "not_applied",
            safeActions: ["get_flow_draft"],
          });
        }
        return {
          id: existing.id,
          status: existing.status,
          diagnostics: existing.diagnostics,
          blockers: [],
          warnings: [],
          qualityFindings: [],
          contractVersion: existing.contractVersion,
          compiledContractDigest: existing.compiledContractDigest,
          replayed: true,
        };
      }

      const runtime = browserObservationRuntimeHealth();

      const probe = input.probeSessionId
        ? await q<{
            state: string;
            result: ProbeResult | null;
          }>(
            `SELECT state,result
             FROM probe_sessions
             WHERE id=$1
               AND draft_id=$2
               AND draft_version=$3`,
            [input.probeSessionId, draftId, d.version],
          )
        : {
            rowCount: 0,
            rows: [],
          };

      if (input.probeSessionId && !probe.rowCount) {
        throw new ConflictException({
          code: "PROBE_SESSION_INVALID",
          mutationOutcome: "not_applied",
          safeActions: ["get_flow_draft"],
        });
      }

      const adaptive = input.authoringSessionId
        ? await q<{
          state: string;
          decisionBoundary: Record<string, unknown> | null;
          completedAt: Date | null;
          qualifiedFlowDraftVersion: number | null;
          }>(
            `SELECT state,decision_boundary AS "decisionBoundary",completed_at AS "completedAt",
                    qualified_flow_draft_version AS "qualifiedFlowDraftVersion"
             FROM adaptive_sessions
             WHERE id=$1
               AND project_id=$2
               AND mission_id=$3
               AND active_objective_id=$4
               AND active_flow_draft_id=$5
               AND environment_id=$6
             FOR SHARE`,
            [
              input.authoringSessionId,
              d.projectId,
              input.missionId,
              input.objectiveId,
              draftId,
              input.environmentId,
            ],
          )
        : { rowCount: 0, rows: [] };

      if (input.authoringSessionId) {
        const source = adaptive.rows[0];
        if (
          !source ||
          source.state !== "completed" ||
          source.decisionBoundary?.type !== "objective_completed" ||
          !source.completedAt ||
          source.qualifiedFlowDraftVersion !== d.version
        ) {
          throw new ConflictException({
            code: "AUTHORING_QUALIFICATION_SESSION_NOT_COMPLETED",
            mutationOutcome: "not_applied",
            safeActions: ["get_flow_authoring"],
          });
        }
        const uncertain = await q(
          `SELECT 1 FROM adaptive_operations
           WHERE session_id=$1 AND mutation_outcome='unknown' AND adaptive_operation_unknown_unresolved(session_id,operation_id) LIMIT 1`,
          [input.authoringSessionId],
        );
        if (uncertain.rowCount) {
          throw new ConflictException({
            code: "MISSION_RECONCILIATION_REQUIRED",
            mutationOutcome: "unknown",
            safeActions: ["get_flow_authoring"],
          });
        }
      }

      const blockers: Array<Record<string, unknown>> = [];
      const warnings: Array<Record<string, unknown>> = [];
      const qualityFindings: Array<Record<string, unknown>> = [];

      if (!runtime.healthy) {
        blockers.push(...runtime.diagnostics);
      }

      if (!probe.rowCount && !adaptive.rowCount) {
        blockers.push({
          code: "PROBE_REQUIRED",
          message: "Compile from a completed Probe Session.",
        });
      } else if (probe.rowCount && probe.rows[0]!.state !== "completed") {
        blockers.push({
          code: "PROBE_INCOMPLETE",
          message: "Probe Session is not complete.",
        });
      } else if (probe.rowCount) {
        const classified = classifyProbeCompilationInput(probe.rows[0]!.result);

        blockers.push(...classified.blockers);
        warnings.push(...classified.warnings);
        qualityFindings.push(...classified.qualityFindings);
      }

      const adaptiveEvidence = adaptive.rowCount
        ? await q<{
            operationId: string;
            functionalResult: string | null;
            mutationOutcome: string | null;
            privacyResult: string | null;
            targetDigest: string | null;
            capabilityDigest: string | null;
            intent: Record<string, unknown>;
            operation: Record<string, unknown>;
            expectedEffect: Record<string, unknown>;
            qualityFindings: Array<Record<string, unknown>>;
          }>(
            `SELECT operation_id AS "operationId",
                    CASE WHEN EXISTS(SELECT 1 FROM adaptive_operation_reconciliations reconciliation
                      WHERE reconciliation.session_id=adaptive_operations.session_id
                        AND reconciliation.operation_id=adaptive_operations.operation_id
                        AND reconciliation.result='proven_applied') THEN 'succeeded' ELSE functional_result END AS "functionalResult",
                    CASE WHEN EXISTS(SELECT 1 FROM adaptive_operation_reconciliations reconciliation
                      WHERE reconciliation.session_id=adaptive_operations.session_id
                        AND reconciliation.operation_id=adaptive_operations.operation_id
                        AND reconciliation.result='proven_applied') THEN 'applied'
                      WHEN EXISTS(SELECT 1 FROM adaptive_operation_reconciliations reconciliation
                        WHERE reconciliation.session_id=adaptive_operations.session_id
                          AND reconciliation.operation_id=adaptive_operations.operation_id
                          AND reconciliation.result='proven_not_applied') THEN 'not_applied'
                      ELSE mutation_outcome END AS "mutationOutcome",privacy_result AS "privacyResult",
                    safe_outcome->'resolvedTarget'->>'digest' AS "targetDigest",
                    safe_outcome->'resolvedTarget'->>'capabilityDigest' AS "capabilityDigest",
                    authoring_intent AS intent,derived_action AS operation,
                    expected_effect AS "expectedEffect",
                    COALESCE(quality_findings,'[]'::jsonb) AS "qualityFindings"
             FROM adaptive_operations
             WHERE session_id=$1 AND flow_draft_id=$2
             ORDER BY sequence`,
            [input.authoringSessionId, draftId],
          )
        : { rowCount: 0, rows: [] };
      const probeResult: ProbeResult | null = probe.rows[0]?.result ??
        (adaptive.rowCount
          ? {
              targets: [],
              readiness: [],
              learnedContracts: adaptiveEvidence.rows
                .filter(
                  (operation) =>
                    operation.functionalResult === "succeeded" &&
                    operation.mutationOutcome !== "unknown" &&
                    ["verified", "sealed"].includes(operation.privacyResult ?? "") &&
                    adaptiveOperationDeterministic(operation),
                )
                .map((operation) => ({
                  schemaVersion: 1,
                  interactionId: operation.operationId,
                  stepId: operation.operationId,
                  intent: operation.intent,
                  operation: operation.operation,
                  functionalResult: "passed",
                  mutationOutcome: operation.mutationOutcome ?? "not_applied",
                  successfulEvidenceFamilies: [
                    "runtime",
                    ...(operation.targetDigest ? ["accessibility" as const] : []),
                    "effect",
                  ],
                  scope: { kind: "adaptive_authoring_session" },
                  relationships: [],
                  capabilityProfile: {
                    targetDigest: operation.targetDigest,
                    capabilityDigest: operation.capabilityDigest,
                  },
                  expectedEffect: operation.expectedEffect,
                  sanitizedFingerprint: {
                    digest: hash({
                      operationId: operation.operationId,
                      targetDigest: operation.targetDigest,
                      capabilityDigest: operation.capabilityDigest,
                    }),
                  },
                  qualityFindings: operation.qualityFindings,
                  usedSelectorHint: false,
                  unresolvedMutation: false,
                  veilPolicyViolated: false,
                  veilEvidenceClosed: ["verified", "sealed"].includes(
                    operation.privacyResult ?? "",
                  ),
                  expectedEffectVerified: operation.functionalResult === "succeeded",
                  deterministic: adaptiveOperationDeterministic(operation),
                })),
              diagnostics: [],
              pageFingerprint: hash({
                authoringSessionId: input.authoringSessionId,
                operations: adaptiveEvidence.rows,
              }),
              authoringTrajectory: {
                source: "adaptive_authoring_session",
                operationCount: adaptiveEvidence.rowCount,
              },
            }
          : null);
      const transcript = compileSuccessfulInteractions(probeResult);
      blockers.push(...transcript.blockers);
      warnings.push(...transcript.warnings);

      const diagnostics = [...blockers, ...warnings];

      const status = !runtime.healthy
        ? "runtime_unhealthy"
        : blockers.length
          ? "calibration_required"
          : "execution_ready";

      const compiledPlan = deriveCompiledPlan(
        currentPlanSchema.parse(d.plan),
        probeResult?.targets ?? [],
      );

      const planDigest = hash(compiledPlan);

      const authorizationDigest = await stateDigest(
        q,
        `SELECT id,kind,status,expires_at
           FROM mission_authorizations
           WHERE mission_id=$1
             AND objective_id=$2
           ORDER BY id`,
        [input.missionId, input.objectiveId],
      );

      const calibrationDigest = await stateDigest(
        q,
        `SELECT
           c.id,
           a.id AS attestation_id
         FROM calibration_contracts c
         LEFT JOIN calibration_contract_revisions r
           ON r.contract_id=c.id
         LEFT JOIN calibration_attestations a
           ON a.contract_revision_id=r.id
         WHERE c.project_id=$1
         ORDER BY c.id,a.id`,
        [d.projectId],
      );

      const contract = {
        version: transcript.contractVersion,
        planDigest,
        targetContracts: probeResult?.targets ?? [],
        readinessContracts: probeResult?.readiness ?? [],
        learnedInteractionRecords: transcript.learnedRecords,
        protectedAcquisitionEvidence: transcript.protectedAcquisitionEvidence,
        runtimeHash: runtime.runtimeHash,
        capabilityManifestHash: runtime.capabilityManifestHash,
        authorizationDigest,
        calibrationDigest,
      };

      const digest = compiledContractDigest(contract);
      const id = randomUUID();

      await q(
        `UPDATE flow_compilations
         SET status='superseded',
             invalidated_at=now()
         WHERE draft_id=$1
           AND draft_version=$2
           AND status IN (
             'execution_ready',
             'calibration_required'
           )`,
        [draftId, d.version],
      );

      await q(
        `INSERT INTO flow_compilations(
          id,
          draft_id,
          draft_version,
          project_id,
          mission_id,
          objective_id,
          environment_id,
          probe_session_id,
          adaptive_session_id,
          authentication_contract_revision_id,
          status,
          compiled_plan,
          plan_digest,
          compiled_contract_digest,
          contract_version,
          learned_interaction_records,
          protected_acquisition_evidence,
          publication_gate,
          capability_manifest_hash,
          runtime_hash,
          page_fingerprint,
          authentication_fingerprint,
          target_contracts,
          readiness_contracts,
          diagnostics,
          authorization_digest,
          calibration_digest,
          created_by_agent_session_id,
          idempotency_key,
          completed_at
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12::jsonb,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,
          $22,$23::jsonb,$24::jsonb,$25::jsonb,
          $26,$27,$28,$29,now()
        )`,
        [
          id,
          draftId,
          d.version,
          d.projectId,
          input.missionId,
          input.objectiveId,
          input.environmentId,
          input.probeSessionId ?? null,
          input.authoringSessionId ?? null,
          input.authenticationContractRevisionId ?? null,
          status,
          JSON.stringify(compiledPlan),
          planDigest,
          digest,
          transcript.contractVersion,
          JSON.stringify(transcript.learnedRecords),
          JSON.stringify(transcript.protectedAcquisitionEvidence),
          JSON.stringify(publicationGateFor(status, transcript.contractVersion)),
          runtime.capabilityManifestHash,
          runtime.runtimeHash,
          probeResult?.pageFingerprint ?? null,
          probeResult?.authenticationFingerprint ?? null,
          JSON.stringify(contract.targetContracts),
          JSON.stringify(contract.readinessContracts),
          JSON.stringify(diagnostics),
          authorizationDigest,
          calibrationDigest,
          input.agentSessionId,
          input.idempotencyKey,
        ],
      );

      await q(
        `UPDATE flow_drafts
         SET state=$2,
             updated_at=now()
         WHERE id=$1`,
        [draftId, status === "execution_ready" ? "publishable" : "editing"],
      );

      await recordReleaseMetric(q, {
        projectId: d.projectId,
        missionId: input.missionId,
        objectiveId: input.objectiveId,
        compilationId: id,
        category: "compiler",
        name:
          status === "execution_ready"
            ? "transcript_compilation_succeeded"
            : "transcript_compilation_rejected",
        safeDimensions: {
          status,
          contractVersion: transcript.contractVersion,
          blockerCodes: blockers.flatMap((item) =>
            typeof item.code === "string" ? [item.code] : [],
          ),
        },
      });
      if (qualityFindings.length) {
        await recordReleaseMetric(q, {
          projectId: d.projectId,
          missionId: input.missionId,
          objectiveId: input.objectiveId,
          compilationId: id,
          category: "quality",
          name: "functional_compilation_with_quality_findings",
          value: qualityFindings.length,
          safeDimensions: {
            findingCodes: qualityFindings.flatMap((item) =>
              typeof item.code === "string" ? [item.code] : [],
            ),
          },
        });
      }

      await this.event(
        q,
        draftId,
        d.version,
        "compilation_completed",
        input.agentSessionId,
        `Compilation ${status}`,
        {
          compilationId: id,
          status,
          removedStepIds: redundantStepIds(probeResult?.targets ?? []),
        },
      );

      return {
        id,
        status,
        diagnostics,
        blockers,
        warnings,
        qualityFindings,
        contractVersion: transcript.contractVersion,
        compiledContractDigest: digest,
      };
    });
  }

  async publish(principal: Principal, draftId: string, input: PublishFlowDraftInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );

      const replay = await q<{ flowId: string; revisionId: string; revision: number }>(
        `SELECT revision.flow_id AS "flowId",revision.id AS "revisionId",revision.revision
         FROM flow_draft_events event
         JOIN flow_drafts draft ON draft.id=event.draft_id
         JOIN flow_revisions revision ON revision.id=draft.published_revision_id
         WHERE event.draft_id=$1 AND event.type='published'
           AND event.safe_metadata->>'idempotencyKey'=$2`,
        [draftId, input.idempotencyKey],
      );
      if (replay.rowCount) return { ...replay.rows[0]!, replayed: true };
      if (d.version !== input.expectedVersion) {
        throw new ConflictException({ code: "STALE_DRAFT_VERSION", actualVersion: d.version });
      }
      if (d.state !== "editing" && d.state !== "publishable") {
        throw new ConflictException({ code: "FLOW_DRAFT_NOT_EDITABLE", state: d.state });
      }

      const environment = await q<{ policy: unknown }>(
        `SELECT policy FROM environments WHERE id=$1 AND project_id=$2`,
        [d.environmentId, d.projectId],
      );
      if (!environment.rowCount) throw new NotFoundException("Environment not found");
      const plan = currentPlanSchema.parse(d.plan);
      const policy = executionPolicySchema.parse(environment.rows[0]!.policy);
      const diagnostics = validatePlanAgainstPolicy(plan, policy);
      if (diagnostics.length) {
        throw new ConflictException({ code: "FLOW_MECHANICAL_VALIDATION_FAILED", diagnostics });
      }

      const legacyCandidate = !d.flowId
        ? await q<{ flowId: string }>(
            `SELECT revision.flow_id AS "flowId" FROM flow_compilations compilation
             JOIN flow_revisions revision ON revision.id=compilation.flow_revision_id
             JOIN flows flow ON flow.id=revision.flow_id
             WHERE compilation.draft_id=$1 AND flow.project_id=$2
             ORDER BY compilation.created_at DESC LIMIT 1 FOR UPDATE OF flow`,
            [draftId, d.projectId],
          )
        : { rowCount: 0, rows: [] as Array<{ flowId: string }> };
      const existingFlowId = d.flowId ?? legacyCandidate.rows[0]?.flowId;
      const flowId = existingFlowId ?? randomUUID();
      const revisionId = randomUUID();
      let revision = 1;
      if (existingFlowId) {
        const current = await q<{ revision: number }>(
          `SELECT revision.revision FROM flows flow
           JOIN flow_revisions revision ON revision.id=flow.latest_revision_id
           WHERE flow.id=$1 AND flow.project_id=$2 FOR UPDATE OF flow`,
          [existingFlowId, d.projectId],
        );
        if (!current.rowCount) throw new NotFoundException("Flow not found");
        revision = current.rows[0]!.revision + 1;
      } else {
        await q(
          `INSERT INTO flows(
             id,project_id,name,description,latest_revision_id,visibility,purpose,
             origin_mission_id,origin_objective_id,owner_mission_id,owner_objective_id,
             created_by_agent_session_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10)`,
          [flowId,d.projectId,d.name,d.description,revisionId,input.visibility,input.purpose,
           input.missionId,input.objectiveId,input.agentSessionId],
        );
      }

      await q(
        `INSERT INTO flow_revisions(
           id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`,
        [revisionId,flowId,revision,JSON.stringify(d.content),JSON.stringify(plan),
         JSON.stringify({ valid: true, representationOnly: true, sourceDraftVersion: d.version,
           sourcePlanDigest: hash(d.plan) }),input.agentSessionId,input.reason],
      );
      await q(
        `UPDATE flows SET latest_revision_id=$2,publication_state='published',visibility=$3,
           purpose=$4,name=$5,description=$6,updated_at=now() WHERE id=$1`,
        [flowId,revisionId,input.visibility,input.purpose,d.name,d.description],
      );
      await q(
        `INSERT INTO mission_flow_links(
           mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [input.missionId,input.objectiveId,flowId,input.visibility,input.purpose,input.reason,
         input.agentSessionId],
      );
      await q(
        `UPDATE flow_drafts SET flow_id=$2,state='published',published_revision_id=$3,
           updated_at=now() WHERE id=$1`,
        [draftId,flowId,revisionId],
      );
      await this.event(q,draftId,d.version,"published",input.agentSessionId,
        `Published representation-only Flow revision ${revision}`,
        { flowId,revisionId,idempotencyKey: input.idempotencyKey });
      return { flowId, revisionId, revision, replayed: false };
    });
  }

  private async publishWithCompilationLegacy(
    principal: Principal,
    draftId: string,
    input: PublishFlowDraftInput & { compilationId: string },
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);

      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        d.environmentId,
      );

      if (d.version !== input.expectedVersion) {
        throw new ConflictException({
          code: "STALE_DRAFT_VERSION",
          actualVersion: d.version,
        });
      }

      const c = await q<{
        id: string;
        status: string;
        draftVersion: number;
        compiledPlan: CurrentPlan;
        planDigest: string;
        contractVersion: string;
        publicationGate: Record<string, unknown>;
        flowRevisionId: string | null;
      }>(
        `SELECT
           id,
           status,
           draft_version AS "draftVersion",
           compiled_plan AS "compiledPlan",
           plan_digest AS "planDigest",
           contract_version AS "contractVersion",
           publication_gate AS "publicationGate",
           flow_revision_id AS "flowRevisionId"
         FROM flow_compilations
         WHERE id=$1
           AND draft_id=$2
         FOR UPDATE`,
        [input.compilationId, draftId],
      );

      const compilation = c.rows[0];

      if (
        !c.rowCount ||
        !compilation ||
        compilation.status !== "execution_ready" ||
        compilation.draftVersion !== d.version ||
        compilation.planDigest !== hash(compilation.compiledPlan)
      ) {
        throw new ConflictException({
          code: "EXECUTION_READY_COMPILATION_REQUIRED",
        });
      }

      if (
        compilation.contractVersion === "v2-learned-interactions" ||
        certificationPublicationGateEnabled()
      ) {
        const certified = await certificationSatisfied(q, compilation.id);
        if (!certified) {
          await q(
            `UPDATE flow_compilations
             SET publication_gate=$2::jsonb
             WHERE id=$1`,
            [
              compilation.id,
              JSON.stringify({
                status: "certification_required",
                rejectionReasons: ["CERTIFICATION_RUN_REQUIRED"],
                requiredOutcome: "application_pass",
              }),
            ],
          );
          throw new ConflictException({
            code: "CERTIFICATION_RUN_REQUIRED",
          });
        }
      }

      if (compilation.flowRevisionId) {
        const candidate = await q<{ flowId: string; revision: number }>(
          `SELECT fr.flow_id AS "flowId",fr.revision
           FROM flow_revisions fr
           JOIN flows f ON f.id=fr.flow_id
           WHERE fr.id=$1
             AND fr.publication_state='candidate'
             AND f.project_id=$2
           FOR UPDATE OF fr,f`,
          [compilation.flowRevisionId, d.projectId],
        );
        if (!candidate.rowCount) {
          throw new ConflictException({ code: "CERTIFICATION_CANDIDATE_REQUIRED" });
        }
        const { flowId, revision } = candidate.rows[0]!;
        await q(
          `UPDATE flows
           SET latest_revision_id=$2,publication_state='published',visibility=$3,purpose=$4,
               name=$5,description=$6,updated_at=now()
           WHERE id=$1`,
          [
            flowId,
            compilation.flowRevisionId,
            input.visibility,
            input.purpose,
            d.name,
            d.description,
          ],
        );
        await q(
          `INSERT INTO mission_flow_links(
             mission_id,objective_id,flow_id,visibility,purpose,reason,created_by_agent_session_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING`,
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
        await q(
          `UPDATE flow_compilations
           SET publication_gate=jsonb_build_object(
                 'status','certified','certificationRunId',certification_run_id::text,
                 'rejectionReasons','[]'::jsonb,'requiredOutcome','application_pass'
               )
           WHERE id=$1`,
          [compilation.id],
        );
        await q(
          `UPDATE flow_drafts
           SET flow_id=$2,state='published',published_revision_id=$3,updated_at=now()
           WHERE id=$1`,
          [draftId, flowId, compilation.flowRevisionId],
        );
        await recordReleaseMetric(q, {
          projectId: d.projectId,
          missionId: input.missionId,
          objectiveId: input.objectiveId,
          compilationId: compilation.id,
          category: "publication",
          name: "certified_revision_published",
        });
        await this.event(
          q,
          draftId,
          d.version,
          "published",
          input.agentSessionId,
          `Published certified Flow revision ${revision}`,
          { flowId, revisionId: compilation.flowRevisionId, compilationId: compilation.id },
        );
        return {
          flowId,
          revisionId: compilation.flowRevisionId,
          revision,
          compilationId: compilation.id,
          compiledContractId: compilation.id,
        };
      }

      const compiledPlan = currentPlanSchema.parse(compilation.compiledPlan);

      const flowId = d.flowId ?? randomUUID();
      const revisionId = randomUUID();
      let revision = 1;

      if (d.flowId) {
        const current = await q<{
          revision: number;
        }>(
          `SELECT fr.revision
           FROM flows f
           JOIN flow_revisions fr
             ON fr.id=f.latest_revision_id
           WHERE f.id=$1
             AND f.project_id=$2
           FOR UPDATE`,
          [d.flowId, d.projectId],
        );

        if (!current.rowCount) {
          throw new NotFoundException("Flow not found");
        }

        revision = current.rows[0]!.revision + 1;
      } else {
        await q(
          `INSERT INTO flows(
            id,
            project_id,
            name,
            description,
            latest_revision_id,
            visibility,
            purpose,
            origin_mission_id,
            origin_objective_id,
            owner_mission_id,
            owner_objective_id,
            created_by_agent_session_id
          )
          VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10
          )`,
          [
            flowId,
            d.projectId,
            d.name,
            d.description,
            revisionId,
            input.visibility,
            input.purpose,
            input.missionId,
            input.objectiveId,
            input.agentSessionId,
          ],
        );
      }

      await q(
        `INSERT INTO flow_revisions(
          id,
          flow_id,
          revision,
          content,
          plan,
          validation,
          created_by_agent_session_id,
          reason
        )
        VALUES(
          $1,$2,$3,$4::jsonb,$5::jsonb,
          $6::jsonb,$7,$8
        )`,
        [
          revisionId,
          flowId,
          revision,
          JSON.stringify(d.content),
          JSON.stringify(compiledPlan),
          JSON.stringify({
            valid: true,
            compiled: true,
            compilationId: input.compilationId,
            sourceDraftVersion: d.version,
            sourcePlanDigest: hash(d.plan),
            compiledPlanDigest: compilation.planDigest,
          }),
          input.agentSessionId,
          input.reason,
        ],
      );

      if (d.flowId) {
        await q(
          `UPDATE flows
           SET latest_revision_id=$2,
               name=$3,
               description=$4,
               updated_at=now()
           WHERE id=$1`,
          [flowId, revisionId, d.name, d.description],
        );
      } else {
        await q(
          `INSERT INTO mission_flow_links(
            mission_id,
            objective_id,
            flow_id,
            visibility,
            purpose,
            reason,
            created_by_agent_session_id
          )
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
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
      }

      await q(
        `UPDATE flow_compilations
         SET flow_revision_id=$2,
             publication_gate=$3::jsonb,
             certification_run_id=COALESCE(certification_run_id, (
               SELECT id
               FROM runs
               WHERE compiled_contract_id=$1
                 AND state='passed'
                 AND result_classification='application_pass'
               ORDER BY created_at DESC
               LIMIT 1
             ))
         WHERE id=$1`,
        [
          input.compilationId,
          revisionId,
          JSON.stringify({
            status: certificationPublicationGateEnabled() ? "certified" : "not_required",
            rejectionReasons: [],
            requiredOutcome: "application_pass",
          }),
        ],
      );

      await q(
        `UPDATE flow_drafts
         SET flow_id=$2,
             state='published',
             published_revision_id=$3,
             updated_at=now()
         WHERE id=$1`,
        [draftId, flowId, revisionId],
      );

      await this.event(
        q,
        draftId,
        d.version,
        "published",
        input.agentSessionId,
        `Published Flow revision ${revision}`,
        {
          flowId,
          revisionId,
          compilationId: input.compilationId,
        },
      );

      return {
        flowId,
        revisionId,
        revision,
        compilationId: input.compilationId,
        compiledContractId: input.compilationId,
      };
    });
  }

  async compileAndCertify(
    principal: Principal,
    draftId: string,
    input: CompileAndCertifyFlowInput,
  ) {
    const compilation = await this.compile(principal, draftId, input);
    if (compilation.status !== "execution_ready") {
      return {
        compiledContractId: compilation.id,
        compilation,
        certification: {
          status: "rejected",
          rejectionReasons: ["COMPILATION_NOT_EXECUTION_READY"],
          safeActions: ["get_flow_draft", "revise_flow"],
          decisionBoundary: {
            type: "compilation_rejected",
            terminal: true,
          },
        },
      };
    }

    const certification = await this.db.transaction(async (client) => {
      const q = bind(client);
      const d = await this.requireDraft(q, principal, draftId, true);
      this.requireDraftContext(d, input);
      await this.requireContext(
        q,
        principal,
        d.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );

      const certificationLock = await q(
        `SELECT 1 FROM flow_compilations
         WHERE id=$1 AND draft_id=$2 AND status='execution_ready'
         FOR UPDATE`,
        [compilation.id, draftId],
      );
      if (!certificationLock.rowCount) {
        throw new ConflictException({
          code: "EXECUTION_READY_COMPILATION_REQUIRED",
          mutationOutcome: "not_applied",
          safeActions: ["get_flow_draft"],
        });
      }
      const existing = await q<{
        runId: string;
        state: string;
        resultClassification: string | null;
        candidateRevisionId: string | null;
      }>(
        `SELECT r.id AS "runId",r.state,r.result_classification AS "resultClassification",
                fc.flow_revision_id AS "candidateRevisionId"
         FROM flow_compilations fc
         JOIN runs r ON r.id=fc.certification_run_id
         WHERE fc.id=$1`,
        [compilation.id],
      );
      if (existing.rowCount) {
        const run = existing.rows[0]!;
        const certified = run.state === "passed" && run.resultClassification === "application_pass";
        const rejected = ["failed", "cancelled", "timed_out", "infrastructure_error"].includes(
          run.state,
        );
        return {
          status: certified ? "certified" : rejected ? "rejected" : "certification_pending",
          certificationRunId: run.runId,
          candidateRevisionId: run.candidateRevisionId,
          rejectionReasons: rejected ? ["CERTIFICATION_RUN_DID_NOT_PASS"] : [],
          safeActions: certified
            ? ["publish_flow_draft"]
            : rejected
              ? ["get_run", "revise_flow"]
              : [],
          ...(certified || rejected
            ? {
                decisionBoundary: {
                  type: certified ? "certification_succeeded" : "certification_rejected",
                  terminal: true,
                },
              }
            : {}),
          replayed: true,
        };
      }

      await this.requireCertificationLineage(q, d, input.authoringSessionId ?? null);

      const contract = await q<{
        contractVersion: string;
        compiledContractDigest: string;
        compiledPlan: CurrentPlan;
      }>(
        `SELECT contract_version AS "contractVersion",
                compiled_contract_digest AS "compiledContractDigest",
                compiled_plan AS "compiledPlan"
         FROM flow_compilations
         WHERE id=$1 AND draft_id=$2 AND status='execution_ready'
         FOR UPDATE`,
        [compilation.id, draftId],
      );
      if (!contract.rowCount) {
        throw new ConflictException({ code: "EXECUTION_READY_COMPILATION_REQUIRED" });
      }

      const environment = await q<{
        name: string;
        baseOrigin: string;
        policy: unknown;
        secretRefs: string[];
        veilPreferences: import("@scry/contracts").VeilPolicyPreferences | null;
      }>(
        `SELECT e.name,e.base_origin AS "baseOrigin",e.policy,e.secret_refs AS "secretRefs",
                veil.preferences AS "veilPreferences"
         FROM environments e
         LEFT JOIN veil_environment_preferences veil ON veil.environment_id=e.id
         WHERE e.id=$1 AND e.project_id=$2
         FOR SHARE OF e`,
        [input.environmentId, d.projectId],
      );
      if (!environment.rowCount) throw new NotFoundException("Environment not found");

      const flowId = d.flowId ?? randomUUID();
      const revisionId = randomUUID();
      const currentRevision = d.flowId
        ? await q<{ revision: number }>(
            `SELECT COALESCE(max(revision),0)::integer AS revision
             FROM flow_revisions WHERE flow_id=$1`,
            [flowId],
          )
        : { rows: [{ revision: 0 }], rowCount: 1 };
      const revision = currentRevision.rows[0]!.revision + 1;

      if (!d.flowId) {
        await q(
          `INSERT INTO flows(
             id,project_id,name,description,latest_revision_id,visibility,purpose,
             origin_mission_id,origin_objective_id,owner_mission_id,owner_objective_id,
             created_by_agent_session_id,publication_state
           ) VALUES($1,$2,$3,$4,$5,'internal','verification',$6,$7,$6,$7,$8,'candidate')`,
          [
            flowId,
            d.projectId,
            d.name,
            d.description,
            revisionId,
            input.missionId,
            input.objectiveId,
            input.agentSessionId,
          ],
        );
      }

      await q(
        `INSERT INTO flow_revisions(
           id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason,
           publication_state
         ) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,'candidate')`,
        [
          revisionId,
          flowId,
          revision,
          JSON.stringify(d.content),
          JSON.stringify(contract.rows[0]!.compiledPlan),
          JSON.stringify({
            valid: true,
            compiled: true,
            certificationCandidate: true,
            compilationId: compilation.id,
            sourceDraftVersion: d.version,
          }),
          input.agentSessionId,
          "Immutable certification candidate",
        ],
      );

      const policy = executionPolicySchema.parse(environment.rows[0]!.policy);
      const veilPolicy = snapshotVeilPolicy(policy, environment.rows[0]!.veilPreferences);
      const runId = randomUUID();
      await q(
        `INSERT INTO runs(
           id,project_id,mission_id,objective_id,agent_session_id,environment_id,
           flow_revision_id,compiled_contract_id,compiled_contract_digest,state,phase,
           plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,
           execution_snapshot,idempotency_key
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,'queued','queued',$10::jsonb,$11::jsonb,
           $12::jsonb,$13::jsonb,$14::jsonb,$15
         )`,
        [
          runId,
          d.projectId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          input.environmentId,
          revisionId,
          compilation.id,
          contract.rows[0]!.compiledContractDigest,
          JSON.stringify(contract.rows[0]!.compiledPlan),
          JSON.stringify({
            id: input.environmentId,
            ...environment.rows[0],
            veilPreferences: undefined,
          }),
          JSON.stringify(policy),
          JSON.stringify(veilPolicy),
          JSON.stringify({
            browser: "chromium",
            viewport: input.viewport,
            seed: input.seed,
            certificationCandidate: true,
          }),
          `certification:${compilation.id}`,
        ],
      );
      await q(
        `INSERT INTO mission_run_links(
           run_id,mission_id,objective_id,role,reason,classified_by_agent_session_id
         ) VALUES($1,$2,$3,'candidate','Fresh authoring certification Run',$4)`,
        [runId, input.missionId, input.objectiveId, input.agentSessionId],
      );
      await q(
        `INSERT INTO run_outbox(run_id,release_id,schema_fingerprint)
         VALUES($1,$2,$3)`,
        [runId, releaseId(), schemaFingerprint()],
      );
      await q(
        `UPDATE flow_compilations
         SET flow_revision_id=$2,
             certification_run_id=$3,
             publication_gate=$4::jsonb
         WHERE id=$1`,
        [
          compilation.id,
          revisionId,
          runId,
          JSON.stringify({
            status: "certification_pending",
            certificationRunId: runId,
            rejectionReasons: [],
            requiredOutcome: "application_pass",
          }),
        ],
      );
      await recordReleaseMetric(q, {
        projectId: d.projectId,
        missionId: input.missionId,
        objectiveId: input.objectiveId,
        compilationId: compilation.id,
        category: "certification",
        name: "certification_run_queued",
      });
      return {
        status: "certification_pending",
        certificationRunId: runId,
        candidateRevisionId: revisionId,
        rejectionReasons: [],
      };
    });

    const resolvedCertification =
      certification.status === "certification_pending"
        ? await this.waitForCertificationTerminal(certification)
        : certification;
    const publishableMetadata =
      resolvedCertification.status === "certified"
        ? {
            compiledContractId: compilation.id,
            compilationId: compilation.id,
            certificationRunId: resolvedCertification.certificationRunId,
            candidateRevisionId: resolvedCertification.candidateRevisionId,
          }
        : undefined;

    return {
      compiledContractId: compilation.id,
      compilation,
      certification: resolvedCertification,
      ...(publishableMetadata ? { publishableMetadata } : {}),
    };
  }

  private async waitForCertificationTerminal(certification: {
    status: string;
    certificationRunId: string;
    candidateRevisionId?: string | null;
    rejectionReasons: string[];
    replayed?: boolean;
  }) {
    const timeoutMs = certificationWaitTimeoutMs();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await delay(Math.min(250, Math.max(1, deadline - Date.now())));
      const current = await this.db.query<{
        state: string;
        resultClassification: string | null;
      }>(
        `SELECT state,result_classification AS "resultClassification"
         FROM runs
         WHERE id=$1`,
        [certification.certificationRunId],
      );
      if (!current.rowCount) {
        return {
          ...certification,
          status: "rejected",
          rejectionReasons: ["CERTIFICATION_RUN_NOT_FOUND"],
          safeActions: ["get_flow_draft", "get_mission"],
          decisionBoundary: {
            type: "certification_rejected",
            terminal: true,
          },
        };
      }

      const run = current.rows[0]!;
      if (run.state === "passed" && run.resultClassification === "application_pass") {
        return {
          ...certification,
          status: "certified",
          rejectionReasons: [],
          safeActions: ["publish_flow_draft"],
          decisionBoundary: {
            type: "certification_succeeded",
            terminal: true,
          },
        };
      }
      if (["failed", "cancelled", "timed_out", "infrastructure_error"].includes(run.state)) {
        return {
          ...certification,
          status: "rejected",
          rejectionReasons: ["CERTIFICATION_RUN_DID_NOT_PASS"],
          safeActions: ["get_run", "revise_flow"],
          decisionBoundary: {
            type: "certification_rejected",
            terminal: true,
          },
        };
      }
    }

    return {
      ...certification,
      safeActions: ["compile_and_certify_flow"],
      decisionBoundary: {
        type: "certification_wait_timeout",
        terminal: false,
        resumeWithSameIdempotencyKey: true,
      },
    };
  }

  async createAuthenticationContract(
    principal: Principal,
    input: CreateAuthenticationContractInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);

    return this.db.transaction(async (client) => {
      const q = bind(client);

      await this.requireContext(
        q,
        principal,
        input.projectId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.environmentId,
      );

      if (input.selectedMethodIndex >= input.submissionMethods.length) {
        throw new ConflictException({
          code: "AUTH_SUBMISSION_METHOD_INVALID",
        });
      }

      const contractId = randomUUID();
      const revisionId = randomUUID();

      const payload = {
        entryUrl: input.entryUrl,
        usernameTarget: input.usernameTarget,
        passwordTarget: input.passwordTarget,
        submissionMethods: input.submissionMethods,
        selectedMethodIndex: input.selectedMethodIndex,
        success: input.success,
        failureSignals: input.failureSignals,
        sessionReuse: input.sessionReuse,
      };

      await q(
        `INSERT INTO authentication_contracts(
          id,
          project_id,
          environment_id,
          application_origin,
          name,
          latest_revision_id
        )
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          contractId,
          input.projectId,
          input.environmentId,
          input.applicationOrigin,
          input.name,
          revisionId,
        ],
      );

      await q(
        `INSERT INTO authentication_contract_revisions(
          id,
          contract_id,
          revision,
          contract,
          created_by_agent_session_id,
          expires_at
        )
        VALUES(
          $1,$2,1,$3::jsonb,$4,$5
        )`,
        [
          revisionId,
          contractId,
          JSON.stringify(payload),
          input.agentSessionId,
          input.expiresAt ?? null,
        ],
      );

      return {
        contractId,
        revisionId,
        revision: 1,
      };
    });
  }

  async listAuthenticationContracts(principal: Principal, projectId: string) {
    return (
      await this.db.query(
        `SELECT
           c.id,
           c.project_id AS "projectId",
           c.environment_id AS "environmentId",
           c.application_origin AS "applicationOrigin",
           c.name,
           c.latest_revision_id AS "latestRevisionId",
           r.revision,
           r.structural_fingerprint AS "structuralFingerprint",
           r.expires_at AS "expiresAt",
           r.revoked_at AS "revokedAt"
         FROM authentication_contracts c
         JOIN authentication_contract_revisions r
           ON r.id=c.latest_revision_id
         JOIN projects p
           ON p.id=c.project_id
         WHERE c.project_id=$1
           AND (
             $2::uuid IS NULL
             OR p.workspace_id=$2
           )
         ORDER BY c.updated_at DESC`,
        [projectId, workspace(principal)],
      )
    ).rows;
  }

  async listSessionLeases(principal: Principal, projectId: string) {
    return (
      await this.db.query(
        `SELECT
           l.id,
           l.project_id AS "projectId",
           l.environment_id AS "environmentId",
           l.authentication_contract_revision_id
             AS "authenticationContractRevisionId",
           l.origin,
           l.runtime_hash AS "runtimeHash",
           l.structural_fingerprint
             AS "structuralFingerprint",
           l.state,
           l.expires_at AS "expiresAt",
           l.last_validated_at AS "lastValidatedAt",
           l.created_at AS "createdAt"
         FROM authenticated_session_leases l
         JOIN projects p
           ON p.id=l.project_id
         WHERE l.project_id=$1
           AND (
             $2::uuid IS NULL
             OR p.workspace_id=$2
           )
         ORDER BY l.created_at DESC`,
        [projectId, workspace(principal)],
      )
    ).rows;
  }

  async revokeSessionLease(principal: Principal, leaseId: string) {
    this.requireWrite(principal);

    const result = await this.db.query(
      `UPDATE authenticated_session_leases l
       SET state='revoked',
           revoked_at=now()
       FROM projects p
       WHERE l.id=$1
         AND p.id=l.project_id
         AND (
           $2::uuid IS NULL
           OR p.workspace_id=$2
         )
       RETURNING
         l.id,
         l.state,
         l.revoked_at AS "revokedAt"`,
      [leaseId, workspace(principal)],
    );

    if (!result.rowCount) {
      throw new NotFoundException("Authenticated session lease not found");
    }

    return result.rows[0];
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Write access required");
    }
  }

  private requireDraftContext(
    draft: { missionId: string; objectiveId: string; environmentId: string },
    input: { missionId: string; objectiveId: string; environmentId?: string },
  ) {
    if (
      draft.missionId !== input.missionId ||
      draft.objectiveId !== input.objectiveId ||
      (input.environmentId !== undefined && draft.environmentId !== input.environmentId)
    ) {
      throw new ConflictException({
        code: "AUTHORING_DRAFT_CONTEXT_MISMATCH",
        safeActions: ["use_draft_objective_context", "create_objective_scoped_draft"],
      });
    }
  }

  private async requireContext(
    q: Query,
    principal: Principal,
    projectId: string,
    missionId: string,
    objectiveId: string,
    sessionId: string,
    environmentId: string,
  ) {
    const result = await q(
      `SELECT 1
       FROM missions m
       JOIN mission_objectives o
         ON o.mission_id=m.id
       JOIN agent_sessions s
         ON s.mission_id=m.id
       JOIN environments e
         ON e.project_id=m.project_id
       WHERE m.id=$1
         AND m.project_id=$2
         AND o.id=$3
         AND s.id=$4
         AND s.status='active'
         AND e.id=$5
         AND (
           $6::uuid IS NULL
           OR m.project_id IN (
             SELECT id
             FROM projects
             WHERE workspace_id=$6
           )
         )`,
      [missionId, projectId, objectiveId, sessionId, environmentId, workspace(principal)],
    );

    if (!result.rowCount) {
      throw new ConflictException({
        code: "AUTHORING_CONTEXT_MISMATCH",
      });
    }
  }

  private async requireCertificationLineage(
    q: Query,
    draft: {
      id: string;
      missionId: string;
      environmentId: string;
      predecessorRunId: string | null;
    },
    authoringSessionId: string | null,
  ) {
    const adaptiveUnknown = await q(
      `SELECT 1 FROM adaptive_operations operation
       JOIN adaptive_sessions session ON session.id=operation.session_id
       WHERE session.mission_id=$1 AND operation.mutation_outcome='unknown' AND adaptive_operation_unknown_unresolved(operation.session_id,operation.operation_id)
       LIMIT 1`,
      [draft.missionId],
    );
    if (adaptiveUnknown.rowCount) {
      throw new ConflictException({
        code: "MISSION_RECONCILIATION_REQUIRED",
        mutationOutcome: "unknown",
        safeActions: ["get_flow_authoring"],
      });
    }
    const protectedUnknown = await q(
      `SELECT 1 FROM protected_transactions transaction
       JOIN runs run ON run.id=transaction.run_id
       WHERE run.mission_id=$1
         AND (transaction.mutation_outcome_status='unknown'
           OR transaction.reconciliation_status='unknown')
       LIMIT 1`,
      [draft.missionId],
    );
    if (protectedUnknown.rowCount) {
      throw new ConflictException({
        code: "MISSION_RECONCILIATION_REQUIRED",
        mutationOutcome: "unknown",
        safeActions: ["get_mission", "get_run"],
      });
    }

    const immediate = await q<{ id: string }>(
      `SELECT id FROM runs
       WHERE mission_id=$1
         AND COALESCE((execution_snapshot->>'certificationCandidate')::boolean,false)=false
       ORDER BY created_at DESC,id DESC
       LIMIT 1
       FOR SHARE`,
      [draft.missionId],
    );
    const immediateRunId = immediate.rows[0]?.id ?? null;
    if (!draft.predecessorRunId) {
      if (immediateRunId) {
        throw new ConflictException({
          code: "SUCCESSOR_PREDECESSOR_RUN_REQUIRED",
          mutationOutcome: "not_applied",
          safeActions: ["get_mission"],
        });
      }
      return;
    }
    if (immediateRunId !== draft.predecessorRunId) {
      throw new ConflictException({
        code: "FLOW_PREDECESSOR_STATE_STALE",
        mutationOutcome: "not_applied",
        safeActions: ["get_mission"],
      });
    }
    if (!authoringSessionId) {
      throw new ConflictException({
        code: "SUCCESSOR_AUTHORING_RESTORATION_REQUIRED",
        mutationOutcome: "not_applied",
        safeActions: ["get_mission", "get_flow_authoring"],
      });
    }
    const predecessor = await q(
      `SELECT 1
       FROM runs run
       JOIN run_successor_checkpoints checkpoint ON checkpoint.run_id=run.id
       JOIN adaptive_sessions session
         ON session.id=$4
        AND session.restored_successor_checkpoint_id=checkpoint.id
        AND session.active_flow_draft_id=$5
       WHERE run.id=$1
         AND run.mission_id=$2
         AND run.environment_id=$3
         AND run.state='passed'
         AND run.outcome_classification='passed'
         AND run.result_classification='application_pass'
         AND COALESCE((run.execution_snapshot->>'certificationCandidate')::boolean,false)=false
         AND checkpoint.state='verified'
         AND checkpoint.expires_at>now()
         AND checkpoint.claimed_by_authoring_session_id=session.id`,
      [
        draft.predecessorRunId,
        draft.missionId,
        draft.environmentId,
        authoringSessionId,
        draft.id,
      ],
    );
    if (!predecessor.rowCount) {
      throw new ConflictException({
        code: "SUCCESSOR_CHECKPOINT_UNAVAILABLE",
        mutationOutcome: "not_applied",
        safeActions: ["get_mission", "get_flow_authoring"],
      });
    }
  }

  private async requireDraft(q: Query, principal: Principal, id: string, lock: boolean) {
    const result = await q<{
      id: string;
      projectId: string;
      missionId: string;
      objectiveId: string;
      environmentId: string;
      flowId: string | null;
      predecessorRunId: string | null;
      name: string;
      description: string;
      purpose: string;
      content: unknown;
      plan: CurrentPlan;
      state: string;
      version: number;
      updatedAt: Date;
    }>(
      `SELECT
         d.id,
         d.project_id AS "projectId",
         d.mission_id AS "missionId",
         d.objective_id AS "objectiveId",
         d.environment_id AS "environmentId",
         d.flow_id AS "flowId",
         d.predecessor_run_id AS "predecessorRunId",
         d.name,
         d.description,
         d.purpose,
         d.content,
         d.plan,
         d.state,
         d.version,
         d.updated_at AS "updatedAt"
       FROM flow_drafts d
       JOIN projects p
         ON p.id=d.project_id
       WHERE d.id=$1
         AND (
           $2::uuid IS NULL
           OR p.workspace_id=$2
         )
       ${lock ? "FOR UPDATE" : ""}`,
      [id, workspace(principal)],
    );

    if (!result.rowCount) {
      throw new NotFoundException("Flow draft not found");
    }

    return result.rows[0]!;
  }

  private async requireMission(q: Query, principal: Principal, id: string) {
    const result = await q(
      `SELECT 1
       FROM missions m
       JOIN projects p
         ON p.id=m.project_id
       WHERE m.id=$1
         AND (
           $2::uuid IS NULL
           OR p.workspace_id=$2
         )`,
      [id, workspace(principal)],
    );

    if (!result.rowCount) {
      throw new NotFoundException("Mission not found");
    }
  }

  private event(
    q: Query,
    id: string,
    version: number,
    type: string,
    session: string,
    summary: string,
    meta: unknown,
  ) {
    return q(
      `INSERT INTO flow_draft_events(
        draft_id,
        version,
        type,
        agent_session_id,
        summary,
        safe_metadata
      )
      VALUES(
        $1,$2,$3,$4,$5,$6::jsonb
      )`,
      [id, version, type, session, summary, JSON.stringify(meta)],
    );
  }

  private activity(
    q: Query,
    input: {
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
    },
    summary: string,
    meta: unknown,
  ) {
    return q(
      `INSERT INTO mission_activities(
        mission_id,
        objective_id,
        agent_session_id,
        type,
        summary,
        safe_metadata,
        technical
      )
      VALUES(
        $1,$2,$3,'authoring',$4,$5::jsonb,true
      )`,
      [input.missionId, input.objectiveId, input.agentSessionId, summary, JSON.stringify(meta)],
    );
  }
}

type ProbeTargetContract = {
  stepId?: unknown;
  channel?: unknown;
  status?: unknown;
  reason?: unknown;
};

export type ProbeResult = {
  targets?: unknown;
  readiness?: Array<Record<string, unknown>>;
  learnedContracts?: Array<Record<string, unknown>>;
  diagnostics?: Array<Record<string, unknown>>;
  blockers?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  qualityFindings?: Array<Record<string, unknown>>;
  pageFingerprint?: string;
  authenticationFingerprint?: string;
  authoringTrajectory?: Record<string, unknown>;
  protectedAcquisitionEvidence?: Array<Record<string, unknown>>;
};

export type TranscriptCompilationResult = {
  learnedRecords: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  contractVersion: "v1-existing" | "v2-learned-interactions";
  protectedAcquisitionEvidence: Array<Record<string, unknown>>;
};

const PROBE_BLOCKER_CODES = new Set([
  "TARGET_AMBIGUOUS",
  "INSUFFICIENT_EVIDENCE",
  "NO_CAPABILITY_COMPATIBLE_CONTROL",
  "TARGET_SCOPE_INVALID",
  "TARGET_CHANGED_BEFORE_ACTION",
  "GROUNDING_DRIFT_REQUIRES_CALIBRATION",
  "OBSERVATION_RUNTIME_UNAVAILABLE",
  "OBSERVATION_FAILED",
  "FLOW_CAPABILITY_UNAVAILABLE",
]);

const PROBE_QUALITY_FINDING_CODES = new Set([
  "FIELD_HAS_NO_ASSOCIATED_LABEL",
  "INTERACTIVE_DIV_WITHOUT_ROLE",
  "DUPLICATE_ACCESSIBLE_NAME",
  "HIDDEN_DUPLICATE_CONTROL",
  "CONTROL_REQUIRES_COORDINATE_TARGETING",
  "ICON_CONTROL_HAS_NO_ACCESSIBLE_NAME",
  "FORM_HAS_NO_NATIVE_SUBMIT_PATH",
  "MISSING_SEMANTIC_IDENTITY",
  "CONFLICTING_ACCESSIBLE_NAME",
  "KEYBOARD_PATH_UNAVAILABLE",
  "LABEL_CONTROL_ASSOCIATION_FAILURE",
  "AMBIGUOUS_DUPLICATE_IDENTITY",
  "TARGET_OBSTRUCTED",
  "UNSTABLE_CONTROL_IDENTITY",
  "VISUAL_ACCESSIBILITY_MISMATCH",
  "STATE_CHANGE_WITHOUT_FEEDBACK",
  "INVALID_ARIA_PATTERN",
  "SPECIALIZED_CUSTOM_CONTROL",
  "UNSAFE_TARGET_GEOMETRY",
  "CANVAS_ONLY_INTERACTION",
]);

export function classifyProbeCompilationInput(result: ProbeResult | null | undefined): {
  blockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  qualityFindings: Array<Record<string, unknown>>;
} {
  const blockers = [...(result?.blockers ?? [])];
  const warnings = [...(result?.warnings ?? [])];
  const qualityFindings = [...(result?.qualityFindings ?? [])];

  for (const diagnostic of result?.diagnostics ?? []) {
    const code = typeof diagnostic.code === "string" ? diagnostic.code : "";

    if (PROBE_BLOCKER_CODES.has(code)) {
      blockers.push(diagnostic);
    } else if (PROBE_QUALITY_FINDING_CODES.has(code)) {
      qualityFindings.push(diagnostic);
    } else {
      warnings.push(diagnostic);
    }
  }

  return {
    blockers,
    warnings,
    qualityFindings,
  };
}

export function deriveCompiledPlan(plan: CurrentPlan, targetContracts: unknown): CurrentPlan {
  const removed = new Set(redundantStepIds(targetContracts));

  if (!removed.size) {
    return plan;
  }

  return currentPlanSchema.parse({
    ...plan,
    steps: plan.steps.filter((step) => !removed.has(step.id)),
  });
}

export function compileSuccessfulInteractions(
  result: ProbeResult | null | undefined,
): TranscriptCompilationResult {
  const rawRecords = Array.isArray(result?.learnedContracts) ? result.learnedContracts : [];
  const learnedRecords: Array<Record<string, unknown>> = [];
  const blockers: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const protectedAcquisitionEvidence = sanitizeProtectedAcquisitionEvidence(
    result?.protectedAcquisitionEvidence,
  );

  if (!transcriptCompilerEnabled()) {
    return {
      learnedRecords: [],
      blockers,
      warnings,
      contractVersion: "v2-learned-interactions",
      protectedAcquisitionEvidence,
    };
  }

  for (const [index, raw] of rawRecords.entries()) {
    const unsafeReason = unsafeTranscriptReason(raw);
    if (unsafeReason) {
      blockers.push({
        code: unsafeReason,
        index,
        message: "Learned interaction contains forbidden authoring or protected evidence.",
      });
      continue;
    }
    const sanitized = sanitizeLearnedRecord(raw);
    const parsed = learnedInteractionRecordSchema.safeParse(sanitized);
    if (!parsed.success) {
      blockers.push({
        code: "LEARNED_INTERACTION_INVALID",
        index,
        message: "Learned interaction record cannot be represented as a deterministic contract.",
      });
      continue;
    }

    const record = parsed.data;
    const rejection = transcriptRejection(record);
    if (rejection) {
      blockers.push({
        code: rejection,
        index,
        message: `Learned interaction ${record.interactionId} is not compilable.`,
      });
      continue;
    }

    learnedRecords.push(record);
  }

  if (learnedRecords.length === 0) {
    blockers.push({
      code: "SUCCESSFUL_AUTHORING_TRAJECTORY_REQUIRED",
      message: "New publication requires at least one successful learned interaction.",
    });
  }

  return {
    learnedRecords,
    blockers,
    warnings,
    contractVersion: "v2-learned-interactions",
    protectedAcquisitionEvidence,
  };
}

export function sanitizeProtectedAcquisitionEvidence(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    const parsed = protectedAcquisitionEvidenceSchema.safeParse({
      reference: candidate.reference,
      adapter: candidate.adapter,
      objective: candidate.objective,
      outcome: candidate.outcome,
      capsule: candidate.capsule,
      evidenceClosure: candidate.evidenceClosure,
    });
    return parsed.success ? [parsed.data] : [];
  });
}

export function compiledContractDigest(contract: Record<string, unknown>) {
  return hash(contract);
}

export function sanitizeLearnedRecord(raw: unknown): Record<string, unknown> {
  const safe = deepSanitize(raw) as Record<string, unknown>;
  return safe && typeof safe === "object" ? safe : {};
}

export function protectedAcquisitionAdapterRegistry() {
  return {
    input_value: { requiresCopyExperience: false, protectedCapable: true },
    text_content: { requiresCopyExperience: false, protectedCapable: true },
    selected_text: { requiresCopyExperience: false, protectedCapable: true },
    keyboard_copy: { requiresCopyExperience: true, protectedCapable: true },
    copy_control: { requiresCopyExperience: true, protectedCapable: true },
    clipboard_event: { requiresCopyExperience: true, protectedCapable: true },
    download_content: { requiresCopyExperience: false, protectedCapable: true },
    protected_network_value: { requiresCopyExperience: false, protectedCapable: true },
    ocr_region: { requiresCopyExperience: false, protectedCapable: true },
  } as const;
}

function transcriptRejection(record: {
  functionalResult: string;
  mutationOutcome: string;
  usedSelectorHint: boolean;
  unresolvedMutation: boolean;
  veilPolicyViolated: boolean;
  veilEvidenceClosed: boolean;
  ephemeralHandleExpiresAt?: string | undefined;
  expectedEffectVerified: boolean;
  deterministic: boolean;
}) {
  if (record.functionalResult !== "passed") return "AUTHORING_INTERACTION_NOT_SUCCESSFUL";
  if (record.unresolvedMutation || record.mutationOutcome === "unknown")
    return "MUTATION_STATE_UNRESOLVED";
  if (record.usedSelectorHint) return "SELECTOR_HINT_ONLY_CONTRACT_REJECTED";
  if (record.ephemeralHandleExpiresAt && Date.parse(record.ephemeralHandleExpiresAt) <= Date.now())
    return "EPHEMERAL_HANDLE_EXPIRED";
  if (!record.expectedEffectVerified) return "EXPECTED_EFFECT_REQUIRED";
  if (record.veilPolicyViolated) return "VEIL_POLICY_VIOLATION";
  if (!record.veilEvidenceClosed) return "VEIL_EVIDENCE_NOT_CLOSED";
  if (!record.deterministic) return "NON_DETERMINISTIC_CONTRACT";
  return undefined;
}

function deepSanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (unsafeTranscriptKey(key)) continue;
    sanitized[key] = deepSanitize(nested);
  }
  return sanitized;
}

function unsafeTranscriptKey(key: string) {
  if (key === "usedSelectorHint") return false;
  return /selector|candidateHandle|rawDom|html|plaintext|clipboardValue|secretValue|tokenValue|coordinate|\b(?:x|y)\b|screenshot|imageData|canvasData/i.test(
    key,
  );
}

function unsafeTranscriptReason(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = unsafeTranscriptReason(item);
      if (reason) return reason;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && secretShapedString(value)
      ? "ENCODED_PROTECTED_VALUE_REJECTED"
      : undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (unsafeTranscriptKey(key)) return "FORBIDDEN_LEARNED_EVIDENCE";
    const reason = unsafeTranscriptReason(nested);
    if (reason) return reason;
  }
  return undefined;
}

function secretShapedString(value: string) {
  const compact = value.trim();
  return (
    /^data:image\//i.test(compact) ||
    /^base64:/i.test(compact) ||
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(compact) ||
    /^[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}$/.test(compact) ||
    (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(compact) && decodesToSensitiveText(compact))
  );
}

function decodesToSensitiveText(value: string) {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return /password|secret|token|api[_-]?key|credential/i.test(decoded);
  } catch {
    return false;
  }
}

function transcriptCompilerEnabled() {
  return true;
}

function certificationPublicationGateEnabled() {
  return true;
}

function publicationGateFor(status: string, contractVersion: string) {
  if (status !== "execution_ready") {
    return {
      status: "rejected",
      rejectionReasons: ["COMPILATION_NOT_EXECUTION_READY"],
      requiredOutcome: "application_pass",
    };
  }
  if (contractVersion === "v1-existing" && !certificationPublicationGateEnabled()) {
    return {
      status: "not_required",
      rejectionReasons: [],
      requiredOutcome: "application_pass",
    };
  }
  return {
    status: "certification_required",
    rejectionReasons: ["CERTIFICATION_RUN_REQUIRED"],
    requiredOutcome: "application_pass",
  };
}

async function certificationSatisfied(q: Query, compilationId: string) {
  const certified = await q(
    `SELECT 1
     FROM flow_compilations fc
     JOIN runs r ON r.id=fc.certification_run_id
     WHERE fc.id=$1
       AND r.compiled_contract_id=fc.id
       AND r.flow_revision_id=fc.flow_revision_id
       AND r.state='passed'
       AND r.result_classification='application_pass'
       AND fc.publication_gate->>'status'='certified'
       AND EXISTS(
         SELECT 1 FROM attempts evidence_attempt
         JOIN step_results evidence_step ON evidence_step.attempt_id=evidence_attempt.id
         WHERE evidence_attempt.run_id=r.id
           AND evidence_step.action_status='passed'
       )
       AND NOT EXISTS(
         SELECT 1 FROM credential_incidents ci WHERE ci.run_id=r.id
       )
       AND NOT EXISTS(
         SELECT 1 FROM protected_transactions transaction
         WHERE transaction.run_id=r.id
           AND (transaction.capsule_status NOT IN ('destroyed','force_terminated')
             OR transaction.evidence_status NOT IN ('resumed','permanently_suppressed'))
       )
       AND NOT EXISTS(
         SELECT 1
         FROM attempts attempt
         LEFT JOIN artifacts artifact ON artifact.attempt_id=attempt.id
         LEFT JOIN artifact_timeline_entries timeline ON timeline.attempt_id=attempt.id
         LEFT JOIN privacy_intervals privacy ON privacy.attempt_id=attempt.id
         WHERE attempt.run_id=r.id
           AND attempt.attempt_number=(
             SELECT max(latest.attempt_number) FROM attempts latest WHERE latest.run_id=r.id
           )
           AND (artifact.availability IN ('failed','incomplete','quarantined')
             OR timeline.entry_type IN ('unavailable_interval','quarantine_record')
             OR (privacy.id IS NOT NULL AND privacy.ended_at IS NULL))
       )
     LIMIT 1`,
    [compilationId],
  );
  return Boolean(certified.rowCount);
}

async function recordReleaseMetric(
  q: Query,
  input: {
    projectId: string;
    missionId: string;
    objectiveId: string;
    compilationId: string;
    category:
      | "authoring"
      | "praxis"
      | "compiler"
      | "quality"
      | "protected_acquisition"
      | "certification"
      | "publication";
    name: string;
    value?: number;
    unit?: "count" | "ratio" | "ms";
    safeDimensions?: Record<string, unknown>;
  },
) {
  await q(
    `INSERT INTO release_gate_metrics(
       project_id,mission_id,objective_id,compilation_id,category,name,value,unit,safe_dimensions
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      input.projectId,
      input.missionId,
      input.objectiveId,
      input.compilationId,
      input.category,
      input.name,
      input.value ?? 1,
      input.unit ?? "count",
      JSON.stringify(input.safeDimensions ?? {}),
    ],
  );
}

function redundantStepIds(targetContracts: unknown): string[] {
  if (!Array.isArray(targetContracts)) {
    return [];
  }

  return targetContracts.flatMap((candidate: ProbeTargetContract) => {
    if (
      typeof candidate?.stepId === "string" &&
      candidate.channel === "action" &&
      candidate.status === "redundant" &&
      candidate.reason === "expected_effect_already_satisfied"
    ) {
      return [candidate.stepId];
    }

    return [];
  });
}

function bind(client: PoolClient): Query {
  return (text, values) => client.query(text, values);
}

function workspace(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}

function adaptiveOperationDeterministic(operation: {
  targetDigest: string | null;
  capabilityDigest: string | null;
  operation: Record<string, unknown>;
}) {
  if (operation.targetDigest && operation.capabilityDigest) return true;
  const action = operation.operation.action;
  if (!action || typeof action !== "object") return false;
  const type = (action as Record<string, unknown>).type;
  return type === "navigate" || type === "sameOriginRequest";
}

function hash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

async function stateDigest(q: Query, sql: string, values: unknown[]) {
  return hash((await q(sql, values)).rows);
}

function releaseId() {
  return process.env.SCRY_RELEASE_ID ?? "development";
}

function schemaFingerprint() {
  return process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline";
}

function certificationWaitTimeoutMs() {
  const configured = Number(process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS ?? 20_000);
  if (!Number.isFinite(configured)) return 20_000;
  return Math.min(30_000, Math.max(0, Math.trunc(configured)));
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}
