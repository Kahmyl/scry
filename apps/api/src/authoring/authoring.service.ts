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
  type CompileFlowDraftInput,
  type CreateAuthenticationContractInput,
  type CreateFlowDraftInput,
  type CurrentPlan,
  type PublishFlowDraftInput,
  type StartProbeSessionInput,
  type UpdateFlowDraftInput,
} from "@scry/contracts";
import { browserObservationRuntimeHealth } from "@scry/praxis";

import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";

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
          content,
          state,
          version,
          plan,
          created_by_agent_session_id
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,
          'editing',1,$10::jsonb,$11
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
          JSON.stringify(input.content),
          JSON.stringify(input.plan),
          input.agentSessionId,
        ],
      );

      await this.event(q, id, 1, "created", input.agentSessionId, "Flow draft created", {
        idempotencyKey: input.idempotencyKey,
      });

      await this.activity(q, input, "Flow draft created", {
        draftId: id,
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

      const blockers: Array<Record<string, unknown>> = [];
      const warnings: Array<Record<string, unknown>> = [];
      const qualityFindings: Array<Record<string, unknown>> = [];

      if (!runtime.healthy) {
        blockers.push(...runtime.diagnostics);
      }

      if (!probe.rowCount) {
        blockers.push({
          code: "PROBE_REQUIRED",
          message: "Compile from a completed Probe Session.",
        });
      } else if (probe.rows[0]!.state !== "completed") {
        blockers.push({
          code: "PROBE_INCOMPLETE",
          message: "Probe Session is not complete.",
        });
      } else {
        const classified = classifyProbeCompilationInput(
          probe.rows[0]!.result,
        );

        blockers.push(...classified.blockers);
        warnings.push(...classified.warnings);
        qualityFindings.push(...classified.qualityFindings);
      }

      const diagnostics = [
        ...blockers,
        ...warnings,
      ];

      const status =
        !runtime.healthy
          ? "runtime_unhealthy"
          : blockers.length
            ? "calibration_required"
            : "execution_ready";

      const probeResult = probe.rows[0]?.result ?? null;

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
        planDigest,
        targetContracts: probeResult?.targets ?? [],
        readinessContracts: probeResult?.readiness ?? [],
        runtimeHash: runtime.runtimeHash,
        capabilityManifestHash: runtime.capabilityManifestHash,
        authorizationDigest,
        calibrationDigest,
      };

      const digest = hash(contract);
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
          authentication_contract_revision_id,
          status,
          compiled_plan,
          plan_digest,
          compiled_contract_digest,
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
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11::jsonb,$12,$13,$14,$15,$16,$17,
          $18::jsonb,$19::jsonb,$20::jsonb,
          $21,$22,$23,$24,now()
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
          input.authenticationContractRevisionId ?? null,
          status,
          JSON.stringify(compiledPlan),
          planDigest,
          digest,
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
      }>(
        `SELECT
           id,
           status,
           draft_version AS "draftVersion",
           compiled_plan AS "compiledPlan",
           plan_digest AS "planDigest"
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
            created_by_agent_session_id
          )
          VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
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
         SET flow_revision_id=$2
         WHERE id=$1`,
        [input.compilationId, revisionId],
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
      };
    });
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

  private async requireDraft(q: Query, principal: Principal, id: string, lock: boolean) {
    const result = await q<{
      id: string;
      projectId: string;
      missionId: string;
      objectiveId: string;
      environmentId: string;
      flowId: string | null;
      name: string;
      description: string;
      content: unknown;
      plan: CurrentPlan;
      state: string;
      version: number;
    }>(
      `SELECT
         d.id,
         d.project_id AS "projectId",
         d.mission_id AS "missionId",
         d.objective_id AS "objectiveId",
         d.environment_id AS "environmentId",
         d.flow_id AS "flowId",
         d.name,
         d.description,
         d.content,
         d.plan,
         d.state,
         d.version
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

type ProbeResult = {
  targets?: unknown;
  readiness?: Array<Record<string, unknown>>;
  diagnostics?: Array<Record<string, unknown>>;
  blockers?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  qualityFindings?: Array<Record<string, unknown>>;
  pageFingerprint?: string;
  authenticationFingerprint?: string;
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

export function classifyProbeCompilationInput(
  result: ProbeResult | null | undefined,
): {
  blockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  qualityFindings: Array<Record<string, unknown>>;
} {
  const blockers = [...(result?.blockers ?? [])];
  const warnings = [...(result?.warnings ?? [])];
  const qualityFindings = [...(result?.qualityFindings ?? [])];

  for (const diagnostic of result?.diagnostics ?? []) {
    const code =
      typeof diagnostic.code === "string"
        ? diagnostic.code
        : "";

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
