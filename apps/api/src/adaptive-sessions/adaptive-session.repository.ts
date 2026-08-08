import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  AdaptiveSessionEventType,
  AdaptiveSessionState,
  AdaptiveSessionOperationInput,
  AgentDecisionBoundary,
  OperationOutcome,
  StartAdaptiveSessionInput,
  ExecutionPolicy,
} from "@scry/contracts";
import { executionPolicySchema } from "@scry/contracts";

import { decryptCredential } from "../access/index.js";
import { Database } from "../infrastructure/index.js";

type Query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
) => Promise<{ rowCount: number | null; rows: T[] }>;

const transitions: Readonly<Record<AdaptiveSessionState, readonly AdaptiveSessionState[]>> = {
  created: ["provisioning", "cancelled"],
  provisioning: ["active", "failed", "cancelled", "recovery_required"],
  active: ["suspended", "completed", "failed", "cancelled", "recovery_required"],
  suspended: ["active", "cancelled", "failed", "recovery_required"],
  recovery_required: ["active", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

@Injectable()
export class AdaptiveSessionRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  create(workspaceId: string | null, input: StartAdaptiveSessionInput) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      await this.requireProjectEnvironment(q, workspaceId, input.projectId, input.environmentId);
      await this.validateControlPlaneLinks(q, input);
      const replay = await q<{ id: string }>(
        `SELECT id FROM adaptive_sessions WHERE project_id=$1 AND idempotency_key=$2`,
        [input.projectId, input.idempotencyKey],
      );
      if (replay.rowCount) return { id: replay.rows[0]!.id, replayed: true };

      const id = randomUUID();
      await q(
        `INSERT INTO adaptive_sessions(
           id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
           mission_id,objective_id,flow_draft_id,idempotency_key
         ) VALUES($1,$2,$3,$4,'created',$5,$6::jsonb,$7,$8,$9,$10)`,
        [
          id,
          input.projectId,
          input.environmentId,
          input.correlationId ?? randomUUID(),
          input.objective,
          JSON.stringify(input.allowedOrigins),
          input.controlPlaneLink?.missionId ?? null,
          input.controlPlaneLink?.objectiveId ?? null,
          input.controlPlaneLink?.flowDraftId ?? null,
          input.idempotencyKey,
        ],
      );
      await this.appendEvent(q, id, "session_created", {}, input.idempotencyKey);
      await this.transitionLocked(q, id, "created", "provisioning", "provisioning_started", {});
      await this.transitionLocked(q, id, "provisioning", "active", "session_activated", {});
      return { id, replayed: false };
    });
  }

  get(workspaceId: string | null, sessionId: string) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, workspaceId, sessionId, false);
      const [events, operations] = await Promise.all([
        q(
          `SELECT sequence,type,safe_facts AS "safeFacts",occurred_at AS "occurredAt"
           FROM adaptive_session_events WHERE session_id=$1 ORDER BY sequence`,
          [sessionId],
        ),
        q(
          `SELECT operation_id AS "operationId",sequence,mode,state,
                  semantic_intent AS action,expected_effect AS "expectedEffect",
                  observation_epoch AS "observationEpoch",
                  candidate_decision_digest AS "candidateDecisionDigest",
                  capability_manifest_digest AS "capabilityManifestDigest",
                  dispatch_boundary AS "dispatchBoundary",safe_outcome AS outcome,
                  decision_boundary AS "decisionBoundary",started_at AS "startedAt",
                  completed_at AS "completedAt"
           FROM adaptive_operations WHERE session_id=$1 ORDER BY sequence`,
          [sessionId],
        ),
      ]);
      return { ...session, operations: operations.rows, events: events.rows };
    });
  }

  transition(input: {
    workspaceId: string | null;
    sessionId: string;
    expectedVersion: number;
    target: AdaptiveSessionState;
    eventType: AdaptiveSessionEventType;
    reason: string;
    idempotencyKey: string;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, input.workspaceId, input.sessionId, true);
      const replay = await q(
        `SELECT 1 FROM adaptive_session_events WHERE session_id=$1 AND idempotency_key=$2`,
        [input.sessionId, input.idempotencyKey],
      );
      if (replay.rowCount)
        return {
          id: input.sessionId,
          state: session.state,
          version: session.version,
          replayed: true,
        };
      if (session.version !== input.expectedVersion) {
        throw new ConflictException({
          code: "ADAPTIVE_SESSION_VERSION_CONFLICT",
          actualVersion: session.version,
        });
      }
      await this.transitionLocked(
        q,
        input.sessionId,
        session.state,
        input.target,
        input.eventType,
        { reason: input.reason },
        input.idempotencyKey,
      );
      return {
        id: input.sessionId,
        state: input.target,
        version: session.version + 1,
        replayed: false,
      };
    });
  }

  beginOperation(
    workspaceId: string | null,
    sessionId: string,
    input: AdaptiveSessionOperationInput,
  ) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, workspaceId, sessionId, true);
      if (session.state !== "active") {
        throw new ConflictException({ code: "ADAPTIVE_SESSION_NOT_ACTIVE", state: session.state });
      }
      const existing = await q<{
        operationId: string;
        state: string;
        outcome: OperationOutcome | null;
        dispatchBoundary: string;
      }>(
        `SELECT operation_id AS "operationId",state,safe_outcome AS outcome,
                dispatch_boundary AS "dispatchBoundary"
         FROM adaptive_operations WHERE session_id=$1 AND idempotency_key=$2`,
        [sessionId, input.idempotencyKey],
      );
      if (existing.rowCount) return { ...existing.rows[0]!, replayed: true };
      const runtime = await this.runtimeContext(q, sessionId);
      const sequence = await this.nextOperationSequence(q, sessionId);
      await q(
        `INSERT INTO adaptive_operations(
           session_id,operation_id,sequence,mode,state,semantic_intent,expected_effect,
           policy_digest,observation_epoch,candidate_decision_digest,idempotency_key
         ) VALUES($1,$2,$3,$4,'running',$5::jsonb,$6::jsonb,$7,$8,$9,$10)`,
        [
          sessionId,
          input.operationId,
          sequence,
          input.mode,
          JSON.stringify(input.action),
          JSON.stringify(sanitize(input.expectedEffect)),
          policyDigest(runtime.policy),
          runtime.lastObservation?.documentEpoch ?? null,
          null,
          input.idempotencyKey,
        ],
      );
      await this.appendEvent(q, sessionId, "operation_started", {
        operationId: input.operationId,
        operationSequence: sequence,
      });
      return { operationId: input.operationId, state: "running", outcome: null, replayed: false };
    });
  }

  async runtimeContextFor(sessionId: string) {
    return this.database.transaction((client) => this.runtimeContext(bind(client), sessionId));
  }

  async recordVerifiedObservation(input: {
    sessionId: string;
    operationId: string;
    documentEpoch: number;
    url: string;
  }) {
    await this.database.query(
      `INSERT INTO adaptive_observations(session_id,operation_id,document_epoch,safe_summary)
       VALUES($1,$2,$3,$4::jsonb)`,
      [input.sessionId, input.operationId, input.documentEpoch, JSON.stringify({ url: input.url })],
    );
  }

  async resolveCredential(sessionId: string, reference: string) {
    const result = await this.database.query<{
      ciphertext: string;
      initializationVector: string;
      authenticationTag: string;
    }>(
      `SELECT credential.ciphertext,
              credential.initialization_vector AS "initializationVector",
              credential.authentication_tag AS "authenticationTag"
       FROM adaptive_sessions session
       JOIN environments environment
         ON environment.id=session.environment_id
        AND environment.project_id=session.project_id
       JOIN project_credentials credential
         ON credential.project_id=session.project_id
        AND credential.id=$2
       WHERE session.id=$1
         AND credential.security_status='active'
         AND credential.deleted_at IS NULL
         AND environment.secret_refs ? ($2::uuid)::text`,
      [sessionId, reference],
    );
    if (!result.rowCount) throw new ConflictException({ code: "ADAPTIVE_CREDENTIAL_UNAVAILABLE" });
    const encrypted = result.rows[0]!;
    return decryptCredential({
      ciphertext: Buffer.from(encrypted.ciphertext, "base64"),
      initializationVector: Buffer.from(encrypted.initializationVector, "base64"),
      authenticationTag: Buffer.from(encrypted.authenticationTag, "base64"),
    });
  }

  async markRunningOperationRecoveryRequired(sessionId: string, operationId: string) {
    await this.database.transaction(async (client) => {
      const q = bind(client);
      const boundary = {
        type: "mutation_reconciliation_required",
        reasonCode: "ADAPTIVE_OPERATION_INTERRUPTED",
        safeActions: ["reconcile_operation", "resume_session"],
      };
      const updated = await q(
        `UPDATE adaptive_operations SET state='failed',mutation_outcome='unknown',
           functional_result='inconclusive',decision_boundary=$3::jsonb,completed_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND state='running'`,
        [sessionId, operationId, JSON.stringify(boundary)],
      );
      if (!updated.rowCount) return;
      await q(
        `UPDATE adaptive_sessions SET state='recovery_required',version=version+1,
           decision_boundary=$2::jsonb,updated_at=now() WHERE id=$1 AND state='active'`,
        [sessionId, JSON.stringify(boundary)],
      );
      await this.appendEvent(q, sessionId, "operation_failed", {
        operationId,
        reasonCode: "ADAPTIVE_OPERATION_INTERRUPTED",
      });
      await this.appendEvent(q, sessionId, "recovery_required", {
        reasonCode: "ADAPTIVE_OPERATION_INTERRUPTED",
      });
    });
  }

  async replayDisposition(sessionId: string, operationId: string) {
    const result = await this.database.query<{
      state: string;
      dispatchBoundary: string;
      leaseHealthy: boolean;
    }>(
      `SELECT operation.state,operation.dispatch_boundary AS "dispatchBoundary",
              COALESCE(lease.lease_expires_at>now(),false) AS "leaseHealthy"
       FROM adaptive_operations operation
       LEFT JOIN adaptive_session_runtime_leases lease ON lease.session_id=operation.session_id
       WHERE operation.session_id=$1 AND operation.operation_id=$2`,
      [sessionId, operationId],
    );
    if (!result.rowCount) throw new NotFoundException("Adaptive operation not found");
    const row = result.rows[0]!;
    return {
      ...row,
      requiresReconciliation:
        row.state === "running" &&
        !row.leaseHealthy &&
        row.dispatchBoundary !== "not_dispatched",
      canResume:
        row.state === "running" &&
        !row.leaseHealthy &&
        row.dispatchBoundary === "not_dispatched",
    };
  }

  async markOperationDispatching(input: {
    sessionId: string;
    operationId: string;
    ownerId: string;
    fencingToken: number;
  }) {
    const result = await this.database.query(
      `UPDATE adaptive_operations operation SET dispatch_boundary='dispatching'
       FROM adaptive_session_runtime_leases lease
       WHERE operation.session_id=$1 AND operation.operation_id=$2
         AND operation.state='running' AND operation.dispatch_boundary='not_dispatched'
         AND lease.session_id=operation.session_id AND lease.owner_id=$3
         AND lease.fencing_token=$4 AND lease.lease_expires_at>now()
       RETURNING operation.operation_id`,
      [input.sessionId, input.operationId, input.ownerId, input.fencingToken],
    );
    if (!result.rowCount) {
      throw new ConflictException({ code: "ADAPTIVE_OPERATION_DISPATCH_FENCE_LOST" });
    }
  }

  settleOperation(input: {
    sessionId: string;
    operationId: string;
    outcome: OperationOutcome;
    capabilityManifestDigest: string;
    decisionBoundary: AgentDecisionBoundary;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      await this.requireSession(q, null, input.sessionId, true);
      const state = input.outcome.functionalResult === "succeeded" ? "completed" : "failed";
      const updated = await q(
        `UPDATE adaptive_operations SET
           state=$3,capability_manifest_digest=$4,dispatch_boundary=$5,
           mutation_outcome=$6,functional_result=$7,privacy_result=$8,
           evidence_result=$9::jsonb,quality_findings=$10::jsonb,safe_outcome=$11::jsonb,
           decision_boundary=$12::jsonb,completed_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND state='running'`,
        [
          input.sessionId,
          input.operationId,
          state,
          input.capabilityManifestDigest,
          input.outcome.mutationOutcome === "not_applied" ? "not_dispatched" : "acknowledged",
          input.outcome.mutationOutcome,
          input.outcome.functionalResult,
          input.outcome.privacyResult,
          JSON.stringify(input.outcome.evidenceResult),
          JSON.stringify(input.outcome.qualityFindings),
          JSON.stringify(input.outcome),
          JSON.stringify(input.decisionBoundary),
        ],
      );
      if (!updated.rowCount)
        throw new ConflictException({ code: "ADAPTIVE_OPERATION_NOT_RUNNING" });
      await q(
        `UPDATE adaptive_sessions SET decision_boundary=$2::jsonb,updated_at=now(),version=version+1
         WHERE id=$1`,
        [input.sessionId, JSON.stringify(input.decisionBoundary)],
      );
      await this.appendEvent(
        q,
        input.sessionId,
        state === "completed" ? "operation_completed" : "operation_failed",
        {
          operationId: input.operationId,
          functionalResult: input.outcome.functionalResult,
          mutationOutcome: input.outcome.mutationOutcome,
        },
      );
      await this.appendEvent(q, input.sessionId, "decision_boundary_reached", {
        operationId: input.operationId,
        type: input.decisionBoundary.type,
        reasonCode: input.decisionBoundary.reasonCode,
      });
      await q(
        `INSERT INTO adaptive_decision_boundaries(session_id,operation_id,sequence,boundary)
         SELECT $1,$2,COALESCE(max(sequence),0)+1,$3::jsonb
         FROM adaptive_decision_boundaries WHERE session_id=$1`,
        [input.sessionId, input.operationId, JSON.stringify(input.decisionBoundary)],
      );
      return { state, outcome: input.outcome, decisionBoundary: input.decisionBoundary };
    });
  }

  async markOperationFailed(sessionId: string, operationId: string, reasonCode: string) {
    await this.database.transaction(async (client) => {
      const q = bind(client);
      const operation = await q<{ dispatchBoundary: string }>(
        `SELECT dispatch_boundary AS "dispatchBoundary" FROM adaptive_operations
         WHERE session_id=$1 AND operation_id=$2 AND state='running' FOR UPDATE`,
        [sessionId, operationId],
      );
      if (!operation.rowCount) return;
      const crossedDispatch = operation.rows[0]!.dispatchBoundary !== "not_dispatched";
      const boundary = crossedDispatch
        ? {
            type: "mutation_reconciliation_required",
            reasonCode: "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN",
            safeActions: ["reconcile_operation", "resume_session"],
          }
        : {
            type: "environment_unavailable",
            reasonCode,
            safeActions: ["resume_session"],
          };
      const failed = await q(
        `UPDATE adaptive_operations SET state='failed',functional_result='failed',
           mutation_outcome=CASE WHEN $4 THEN 'unknown' ELSE 'not_applied' END,
           completed_at=now(),decision_boundary=$3::jsonb
         WHERE session_id=$1 AND operation_id=$2 AND state='running'`,
        [sessionId, operationId, JSON.stringify(boundary), crossedDispatch],
      );
      if (failed.rowCount) {
        await q(
          `UPDATE adaptive_sessions SET state='recovery_required',version=version+1,
             decision_boundary=$2::jsonb,updated_at=now() WHERE id=$1 AND state='active'`,
          [sessionId, JSON.stringify(boundary)],
        );
        await this.appendEvent(q, sessionId, "operation_failed", { operationId, reasonCode });
        await this.appendEvent(q, sessionId, "recovery_required", { reasonCode });
      }
    });
  }

  claimRuntimeLease(input: { sessionId: string; ownerId: string; leaseDurationMs: number }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      await this.requireSession(q, null, input.sessionId, true);
      await q(
        `INSERT INTO adaptive_session_runtime_leases(
           session_id,owner_id,fencing_token,lease_expires_at
         ) VALUES($1,$2,1,now()+($3::text || ' milliseconds')::interval)
         ON CONFLICT(session_id) DO UPDATE SET
           owner_id=EXCLUDED.owner_id,
           fencing_token=adaptive_session_runtime_leases.fencing_token+1,
           lease_expires_at=EXCLUDED.lease_expires_at,
           claimed_at=now(),heartbeat_at=now()
         WHERE adaptive_session_runtime_leases.lease_expires_at<=now()
            OR adaptive_session_runtime_leases.owner_id=EXCLUDED.owner_id`,
        [input.sessionId, input.ownerId, input.leaseDurationMs],
      );
      const lease = await q<{ ownerId: string; fencingToken: number; leaseExpiresAt: string }>(
        `SELECT owner_id AS "ownerId",fencing_token AS "fencingToken",
                lease_expires_at AS "leaseExpiresAt"
         FROM adaptive_session_runtime_leases WHERE session_id=$1`,
        [input.sessionId],
      );
      if (!lease.rowCount || lease.rows[0]!.ownerId !== input.ownerId) {
        throw new ConflictException({ code: "ADAPTIVE_SESSION_RUNTIME_LEASE_HELD" });
      }
      return lease.rows[0]!;
    });
  }

  heartbeatRuntimeLease(input: {
    sessionId: string;
    ownerId: string;
    fencingToken: number;
    leaseDurationMs: number;
  }) {
    return this.database
      .query(
        `UPDATE adaptive_session_runtime_leases SET
           lease_expires_at=now()+($4::text || ' milliseconds')::interval,heartbeat_at=now()
         WHERE session_id=$1 AND owner_id=$2 AND fencing_token=$3 AND lease_expires_at>now()
         RETURNING fencing_token`,
        [input.sessionId, input.ownerId, input.fencingToken, input.leaseDurationMs],
      )
      .then((result) => {
        if (!result.rowCount)
          throw new ConflictException({ code: "ADAPTIVE_SESSION_RUNTIME_LEASE_LOST" });
      });
  }

  releaseRuntimeLease(input: { sessionId: string; ownerId: string; fencingToken: number }) {
    return this.database
      .query(
        `UPDATE adaptive_session_runtime_leases SET lease_expires_at=now(),heartbeat_at=now()
         WHERE session_id=$1 AND owner_id=$2 AND fencing_token=$3 RETURNING fencing_token`,
        [input.sessionId, input.ownerId, input.fencingToken],
      )
      .then((result) => Boolean(result.rowCount));
  }

  private async transitionLocked(
    q: Query,
    sessionId: string,
    current: AdaptiveSessionState,
    target: AdaptiveSessionState,
    eventType: AdaptiveSessionEventType,
    safeFacts: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    if (!transitions[current].includes(target)) {
      throw new ConflictException({ code: "ADAPTIVE_SESSION_TRANSITION_INVALID", current, target });
    }
    await q(
      `UPDATE adaptive_sessions SET state=$2,version=version+1,updated_at=now(),
         completed_at=CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE completed_at END
       WHERE id=$1`,
      [sessionId, target],
    );
    await this.appendEvent(q, sessionId, eventType, safeFacts, idempotencyKey);
  }

  private async appendEvent(
    q: Query,
    sessionId: string,
    type: AdaptiveSessionEventType,
    safeFacts: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    await q(
      `INSERT INTO adaptive_session_events(session_id,sequence,type,safe_facts,idempotency_key)
       SELECT $1,COALESCE(max(sequence),0)+1,$2,$3::jsonb,$4
       FROM adaptive_session_events WHERE session_id=$1`,
      [sessionId, type, JSON.stringify(sanitize(safeFacts)), idempotencyKey ?? null],
    );
  }

  private async nextOperationSequence(q: Query, sessionId: string) {
    const result = await q<{ sequence: number }>(
      `UPDATE adaptive_sessions SET next_operation_sequence=next_operation_sequence+1
       WHERE id=$1 RETURNING next_operation_sequence-1 AS sequence`,
      [sessionId],
    );
    return Number(result.rows[0]!.sequence);
  }

  private async requireSession(q: Query, workspaceId: string | null, id: string, lock: boolean) {
    const result = await q<{
      id: string;
      projectId: string;
      environmentId: string;
      correlationId: string;
      state: AdaptiveSessionState;
      version: number;
      objective: string;
      allowedOrigins: string[];
      decisionBoundary: AgentDecisionBoundary | null;
      createdAt: string;
      updatedAt: string;
    }>(
      `SELECT s.id,s.project_id AS "projectId",s.environment_id AS "environmentId",
              s.correlation_id AS "correlationId",s.state,s.version,s.objective,
              s.allowed_origins AS "allowedOrigins",s.decision_boundary AS "decisionBoundary",
              s.created_at AS "createdAt",s.updated_at AS "updatedAt"
       FROM adaptive_sessions s JOIN projects p ON p.id=s.project_id
       WHERE s.id=$1 AND ($2::uuid IS NULL OR p.workspace_id=$2)
       ${lock ? "FOR UPDATE OF s" : ""}`,
      [id, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Adaptive session not found");
    return result.rows[0]!;
  }

  private async runtimeContext(q: Query, sessionId: string) {
    const result = await q<{
      sessionId: string;
      environmentId: string;
      correlationId: string;
      allowedOrigins: string[];
      baseOrigin: string;
      policy: unknown;
      lastOperationId: string | null;
      lastDocumentEpoch: number | null;
      lastUrl: string | null;
    }>(
      `SELECT session.id AS "sessionId",session.environment_id AS "environmentId",
              session.correlation_id AS "correlationId",session.allowed_origins AS "allowedOrigins",
              environment.base_origin AS "baseOrigin",environment.policy,
              observation.operation_id AS "lastOperationId",
              observation.document_epoch AS "lastDocumentEpoch",
              observation.safe_summary->>'url' AS "lastUrl"
       FROM adaptive_sessions session
       JOIN environments environment ON environment.id=session.environment_id
       LEFT JOIN LATERAL (
         SELECT operation_id,document_epoch,safe_summary
         FROM adaptive_observations WHERE session_id=session.id ORDER BY id DESC LIMIT 1
       ) observation ON true
       WHERE session.id=$1`,
      [sessionId],
    );
    if (!result.rowCount) throw new NotFoundException("Adaptive session not found");
    const row = result.rows[0]!;
    const environmentPolicy = executionPolicySchema.parse(row.policy);
    const allowedOrigins = row.allowedOrigins.filter((origin) =>
      environmentPolicy.allowedOrigins.includes(origin),
    );
    if (!allowedOrigins.length || !allowedOrigins.includes(new URL(row.baseOrigin).origin)) {
      throw new ConflictException({ code: "ADAPTIVE_SESSION_POLICY_INVALID" });
    }
    const policy = executionPolicySchema.parse({ ...environmentPolicy, allowedOrigins });
    return {
      sessionId: row.sessionId,
      environmentId: row.environmentId,
      correlationId: row.correlationId,
      baseOrigin: row.baseOrigin,
      policy,
      lastObservation:
        row.lastOperationId && row.lastDocumentEpoch !== null && row.lastUrl
          ? {
              operationId: row.lastOperationId,
              documentEpoch: row.lastDocumentEpoch,
              url: row.lastUrl,
            }
          : null,
    };
  }

  private async requireProjectEnvironment(
    q: Query,
    workspaceId: string | null,
    projectId: string,
    environmentId: string,
  ) {
    const result = await q(
      `SELECT 1 FROM projects p JOIN environments e ON e.project_id=p.id
       WHERE p.id=$1 AND e.id=$2 AND ($3::uuid IS NULL OR p.workspace_id=$3)`,
      [projectId, environmentId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException("Project environment not found");
  }

  private async validateControlPlaneLinks(q: Query, input: StartAdaptiveSessionInput) {
    const link = input.controlPlaneLink;
    if (!link) return;
    if (link.missionId) {
      const mission = await q(`SELECT 1 FROM missions WHERE id=$1 AND project_id=$2`, [
        link.missionId,
        input.projectId,
      ]);
      if (!mission.rowCount)
        throw new ConflictException({ code: "ADAPTIVE_CONTROL_PLANE_LINK_INVALID" });
    }
    if (link.objectiveId) {
      const objective = await q(
        `SELECT 1 FROM mission_objectives o JOIN missions m ON m.id=o.mission_id
         WHERE o.id=$1 AND m.project_id=$2 AND ($3::uuid IS NULL OR m.id=$3)`,
        [link.objectiveId, input.projectId, link.missionId ?? null],
      );
      if (!objective.rowCount)
        throw new ConflictException({ code: "ADAPTIVE_CONTROL_PLANE_LINK_INVALID" });
    }
    if (link.flowDraftId) {
      const draft = await q(`SELECT 1 FROM flow_drafts WHERE id=$1 AND project_id=$2`, [
        link.flowDraftId,
        input.projectId,
      ]);
      if (!draft.rowCount)
        throw new ConflictException({ code: "ADAPTIVE_CONTROL_PLANE_LINK_INVALID" });
    }
  }
}

function policyDigest(policy: ExecutionPolicy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function bind(client: PoolClient): Query {
  return (text, values = []) => client.query(text, values);
}

const forbiddenKeys =
  /selector|candidateHandle|rawDom|coordinate|screenshot|password|secret|credential|token/i;
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !forbiddenKeys.test(key))
      .map(([key, nested]) => [key, sanitize(nested)]),
  );
}
