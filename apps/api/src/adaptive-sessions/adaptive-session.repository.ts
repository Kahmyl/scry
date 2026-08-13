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
  MissionAuthoringIntent,
  MissionAuthoringTurnResult,
} from "@scry/contracts";
import {
  executionPolicySchema,
  missionAuthoringIntentSchema,
  missionAuthoringTurnResultSchema,
  operationOutcomeSchema,
} from "@scry/contracts";

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
      const environment = await this.requireProjectEnvironment(
        q,
        workspaceId,
        input.projectId,
        input.environmentId,
      );
      const allowedOrigins = requireEnvironmentCapabilities(environment, input);
      await this.requireActiveProtectedReferences(
        q,
        input.projectId,
        input.environmentId,
        input.initialProtectedReferenceIds ?? [],
      );
      const initialFlow = await this.validateControlPlaneLinks(q, input);
      const replay = await q<{ id: string }>(
        `SELECT id FROM adaptive_sessions WHERE project_id=$1 AND idempotency_key=$2`,
        [input.projectId, input.idempotencyKey],
      );
      if (replay.rowCount) return { id: replay.rows[0]!.id, replayed: true };

      const id = randomUUID();
      await q(
        `INSERT INTO adaptive_sessions(
           id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
           mission_id,objective_id,flow_draft_id,active_objective_id,active_flow_draft_id,
           agent_session_id,idempotency_key,authoring_turn_budgets,protected_reference_allowlist
         ) VALUES($1,$2,$3,$4,'created',$5,$6::jsonb,$7,$8,$9,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
        [
          id,
          input.projectId,
          input.environmentId,
          input.correlationId ?? randomUUID(),
          input.objective,
          JSON.stringify(allowedOrigins),
          input.missionId,
          input.objectiveId,
          input.flowDraftId,
          input.agentSessionId,
          input.idempotencyKey,
          JSON.stringify(input.turnBudgets ?? { maxOperations: 20, maxDurationMs: 60_000 }),
          JSON.stringify(input.initialProtectedReferenceIds ?? []),
        ],
      );
      await q(
        `INSERT INTO mission_authoring_session_flows(
           session_id,mission_id,objective_id,flow_draft_id,purpose,sequence
         ) VALUES($1,$2,$3,$4,$5,1)`,
        [id, input.missionId, input.objectiveId, input.flowDraftId, initialFlow.purpose],
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
      const events = await q(
          `SELECT sequence,type,safe_facts AS "safeFacts",occurred_at AS "occurredAt"
           FROM adaptive_session_events WHERE session_id=$1 ORDER BY sequence`,
          [sessionId],
        );
      const operations = await q(
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
        );
      const linkedFlows = await q(
          `SELECT objective_id AS "objectiveId",flow_draft_id AS "flowDraftId",purpose,sequence
           FROM mission_authoring_session_flows WHERE session_id=$1 ORDER BY sequence`, [sessionId],
        );
      const latestTurn = await q<{ safeResponse: MissionAuthoringTurnResult | null }>(
          `SELECT safe_response AS "safeResponse" FROM mission_authoring_turns
           WHERE session_id=$1 AND safe_response IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [sessionId],
        );
      return { ...session, operations: operations.rows, events: events.rows, linkedFlows: linkedFlows.rows,
        latestTurn: latestTurn.rows[0]?.safeResponse ?? null };
    });
  }

  beginTurn(input: {
    workspaceId: string | null;
    sessionId: string;
    idempotencyKey: string;
    inputDigest: string;
    budgets: { maxOperations: number; maxDurationMs: number };
    intents: MissionAuthoringIntent[];
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, input.workspaceId, input.sessionId, true);
      if (session.state !== "active") throw new ConflictException({ code: "ADAPTIVE_SESSION_NOT_ACTIVE" });
      const existing = await q<{ id: string; inputDigest: string; state: string; safeResponse: MissionAuthoringTurnResult | null; currentPhase: string }>(
        `SELECT id,input_digest AS "inputDigest",state,safe_response AS "safeResponse",current_phase AS "currentPhase"
         FROM mission_authoring_turns WHERE session_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.sessionId, input.idempotencyKey],
      );
      if (existing.rowCount) {
        const turn = existing.rows[0]!;
        if (turn.inputDigest !== input.inputDigest) {
          throw new ConflictException({ code: "MISSION_AUTHORING_TURN_IDEMPOTENCY_CONFLICT" });
        }
        return { turnId: turn.id, replayed: true, state: turn.state, response: turn.safeResponse, phase: turn.currentPhase };
      }
      const active = await q<{ id: string; state: "running" | "pending"; currentPhase: string }>(
        `SELECT id,state,current_phase AS "currentPhase" FROM mission_authoring_turns
         WHERE session_id=$1 AND state IN ('running','pending') FOR UPDATE`,
        [input.sessionId],
      );
      if (active.rowCount) {
        const current = active.rows[0]!;
        throw new ConflictException({
          code: "MISSION_AUTHORING_TURN_IN_PROGRESS",
          turnId: current.id,
          phase: current.currentPhase,
        });
      }
      const turnId = randomUUID();
      await q(
        `INSERT INTO mission_authoring_turns(
           id,session_id,idempotency_key,input_digest,safe_input,state,budgets,current_phase
         ) VALUES($1,$2,$3,$4,$5::jsonb,'running',$6::jsonb,'resolve')`,
        [turnId, input.sessionId, input.idempotencyKey, input.inputDigest, JSON.stringify({ intents: input.intents }), JSON.stringify(input.budgets)],
      );
      await this.appendEvent(q, input.sessionId, "turn_started", { turnId, maxOperations: input.budgets.maxOperations });
      return { turnId, replayed: false, state: "running" as const, response: null, phase: "resolve" };
    });
  }

  continueTurn(input: { workspaceId: string | null; sessionId: string; turnId: string; idempotencyKey: string; budgets: { maxOperations: number; maxDurationMs: number } }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      await this.requireSession(q, input.workspaceId, input.sessionId, true);
      const turn = await q<{ id: string; state: string; safeInput: { intents?: MissionAuthoringIntent[] }; safeResponse: MissionAuthoringTurnResult | null; currentPhase: string; nextIntentIndex: number }>(
        `SELECT id,state,safe_input AS "safeInput",safe_response AS "safeResponse",current_phase AS "currentPhase",
                next_intent_index AS "nextIntentIndex"
         FROM mission_authoring_turns WHERE id=$1 AND session_id=$2 FOR UPDATE`, [input.turnId, input.sessionId],
      );
      if (!turn.rowCount) throw new NotFoundException("Mission authoring turn not found");
      const current = turn.rows[0]!;
      const continuationInputDigest = stableDigest({ turnId: input.turnId, budgets: input.budgets });
      const replay = await q<{ id: string; state: string; safeResponse: MissionAuthoringTurnResult | null; currentPhase: string; safeInput: { intents?: MissionAuthoringIntent[] }; continuationInputDigest: string; nextIntentIndex: number }>(
        `SELECT id,state,safe_response AS "safeResponse",current_phase AS "currentPhase",safe_input AS "safeInput",
                continuation_input_digest AS "continuationInputDigest",next_intent_index AS "nextIntentIndex"
         FROM mission_authoring_turns WHERE session_id=$1 AND continuation_idempotency_key=$2`,
        [input.sessionId, input.idempotencyKey],
      );
      if (replay.rowCount) {
        const stored = replay.rows[0]!;
        if (stored.id !== current.id || stored.continuationInputDigest !== continuationInputDigest)
          throw new ConflictException({ code: "MISSION_AUTHORING_CONTINUATION_IDEMPOTENCY_CONFLICT" });
        return { ...stored, replayed: true };
      }
      if (current.state !== "pending") throw new ConflictException({ code: "MISSION_AUTHORING_TURN_NOT_PENDING" });
      await q(
        `UPDATE mission_authoring_turns SET state='running',budgets=$3::jsonb,current_phase='resume',updated_at=now(),safe_response=NULL,
           continuation_idempotency_key=$4,continuation_input_digest=$5 WHERE id=$1 AND session_id=$2`,
        [input.turnId, input.sessionId, JSON.stringify(input.budgets), input.idempotencyKey, continuationInputDigest],
      );
      return { ...current, state: "running", replayed: false };
    });
  }

  persistPending(input: {
    sessionId: string;
    turnId: string;
    result: MissionAuthoringTurnResult;
    phase: string;
    nextIntentIndex: number;
  }) {
    const result = missionAuthoringTurnResultSchema.parse(input.result);
    if (result.state !== "pending") throw new ConflictException({ code: "MISSION_AUTHORING_PENDING_RESULT_REQUIRED" });
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const updated = await q(
        `UPDATE mission_authoring_turns SET state='pending',safe_response=$3::jsonb,current_phase=$4,
           next_intent_index=$5,updated_at=now()
         WHERE id=$1 AND session_id=$2 AND state='running'`,
        [input.turnId, input.sessionId, JSON.stringify(result), input.phase, input.nextIntentIndex],
      );
      if (!updated.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_TURN_NOT_RUNNING" });
      await q(
        `UPDATE adaptive_sessions SET decision_boundary=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1`,
        [input.sessionId, JSON.stringify({ type: "turn_budget_exhausted", reasonCode: "MISSION_AUTHORING_TURN_PENDING", safeActions: [] })],
      );
      return result;
    });
  }

  settleTurn(input: { sessionId: string; turnId: string; result: MissionAuthoringTurnResult }) {
    const result = missionAuthoringTurnResultSchema.parse(input.result);
    if (result.state === "pending") throw new ConflictException({ code: "MISSION_AUTHORING_TERMINAL_RESULT_REQUIRED" });
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const settled = await q(
        `UPDATE mission_authoring_turns SET state=$3,safe_response=$4::jsonb,completed_at=now(),updated_at=now()
         WHERE id=$1 AND session_id=$2 AND state='running'`,
        [input.turnId, input.sessionId, result.state, JSON.stringify(result)],
      );
      if (!settled.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_TURN_NOT_RUNNING" });
      await q(
        `UPDATE adaptive_sessions SET decision_boundary=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1`,
        [input.sessionId, JSON.stringify(result.decisionBoundary ?? {
          type: "objective_completed", reasonCode: "MISSION_AUTHORING_TURN_COMPLETED", safeActions: [],
        })],
      );
      await this.appendEvent(q, input.sessionId, "turn_completed", { turnId: input.turnId, state: result.state });
      return result;
    });
  }

  async validateIntentAdmission(input: { sessionId: string; intent: MissionAuthoringIntent }) {
    const session = await this.database.query<{ environmentId: string; missionId: string; activeObjectiveId: string; protectedAllowlist: string[]; allowedOrigins: string[] }>(
      `SELECT environment_id AS "environmentId",mission_id AS "missionId",active_objective_id AS "activeObjectiveId",
              protected_reference_allowlist AS "protectedAllowlist",allowed_origins AS "allowedOrigins"
       FROM adaptive_sessions WHERE id=$1`, [input.sessionId],
    );
    if (!session.rowCount) throw new NotFoundException("Adaptive session not found");
    const current = session.rows[0]!;
    if (isAuthoringMutation(input.intent)) {
      const unresolved = await this.database.query(
        `SELECT 1 FROM protected_operations WHERE owner_kind='authoring_session'
           AND authoring_session_id=$1 AND state IN ('dispatching','dispatched','acquiring','persisting','persisted','reconciling','recovery_required','compromised')
           AND operation_id<>(SELECT COALESCE((SELECT operation_id FROM adaptive_operations WHERE session_id=$1 AND authoring_intent->>'intentId'=$2 LIMIT 1),'') )
         LIMIT 1`,
        [input.sessionId,input.intent.intentId],
      );
      if (unresolved.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_OPERATION_UNRESOLVED" });
    }
    if (input.intent.protectedInputReferences.some((reference) => !current.protectedAllowlist.includes(reference))) {
      throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED" });
    }
    const lifecycleReferences = input.intent.credentialLifecycle?.credentialReferenceIds ?? [];
    const statusCheckedReferences = [...new Set([
      ...input.intent.protectedInputReferences,
      ...lifecycleReferences,
    ])];
    if (lifecycleReferences.some((reference) => !current.protectedAllowlist.includes(reference))) {
      throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED" });
    }
    await this.requireActiveProtectedReferences(
      this.database.query.bind(this.database),
      undefined,
      current.environmentId,
      statusCheckedReferences,
      input.sessionId,
    );
    if (input.intent.expectedEffect.kind === "new_page" && input.intent.expectedEffect.origin) {
      let origin: string;
      try { origin = new URL(input.intent.expectedEffect.origin).origin; } catch { throw new ConflictException({ code: "MISSION_AUTHORING_NEW_PAGE_ORIGIN_INVALID" }); }
      if (!current.allowedOrigins.includes(origin)) {
        throw new ConflictException({ code: "MISSION_AUTHORING_NEW_PAGE_ORIGIN_NOT_ALLOWED" });
      }
    }
    if (input.intent.authorization.authorizationId) {
      const authorized = await this.database.query(
        `SELECT 1 FROM mission_authorizations WHERE id=$1 AND mission_id=$2 AND objective_id=$3
           AND environment_id=$4 AND status='approved' AND (expires_at IS NULL OR expires_at>now())`,
        [input.intent.authorization.authorizationId, current.missionId, input.intent.objectiveId, current.environmentId],
      );
      if (!authorized.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_AUTHORIZATION_INVALID" });
    }
  }

  async protectedPreparationFor(input: {
    sessionId: string;
    objectiveId: string;
    flowDraftId: string;
    intentIds: string[];
    entryUrl: string;
  }) {
    const referenced = await this.database.query<{ reference: string }>(
      `SELECT DISTINCT protected_reference.value AS reference
         FROM adaptive_operations operation
         CROSS JOIN LATERAL jsonb_array_elements_text(
           COALESCE(operation.authoring_intent->'protectedInputReferences','[]'::jsonb)
         ) protected_reference(value)
        WHERE operation.session_id=$1
          AND operation.authoring_intent->>'intentId'=ANY($2::text[])`,
      [input.sessionId, input.intentIds],
    );
    if (referenced.rowCount) {
      const session = await this.database.query<{ projectId: string; environmentId: string }>(
        `SELECT project_id AS "projectId",environment_id AS "environmentId"
           FROM adaptive_sessions WHERE id=$1`,
        [input.sessionId],
      );
      if (!session.rowCount) throw new NotFoundException("Adaptive session not found");
      await this.requireActiveProtectedReferences(
        this.database.query.bind(this.database),
        session.rows[0]!.projectId,
        session.rows[0]!.environmentId,
        referenced.rows.map(({ reference }) => reference),
        input.sessionId,
      );
    }
    const result = await this.database.query<{
      sequence: number;
      intentId: string;
      intent: MissionAuthoringIntent;
      observedUrl: string;
    }>(
      `SELECT operation.sequence,operation.authoring_intent->>'intentId' AS "intentId",
              operation.authoring_intent AS intent,observation.safe_summary->>'url' AS "observedUrl"
       FROM adaptive_operations operation
       JOIN adaptive_sessions session ON session.id=operation.session_id
       JOIN environments environment ON environment.id=session.environment_id
       JOIN LATERAL (
         SELECT safe_summary FROM adaptive_observations
         WHERE session_id=operation.session_id AND operation_id=operation.operation_id
         ORDER BY id DESC LIMIT 1
       ) observation ON true
       WHERE operation.session_id=$1 AND operation.mission_id=session.mission_id
         AND operation.objective_id=$2 AND operation.flow_draft_id=$3
         AND operation.state='completed' AND operation.functional_result='succeeded'
         AND operation.mutation_outcome IN ('not_applied','applied')
         AND operation.authoring_intent->'authorization'->>'kind' IN ('ordinary','authentication','live_read')
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(
             COALESCE(operation.authoring_intent->'protectedInputReferences','[]'::jsonb)
           ) AS protected_reference(value)
           WHERE NOT (environment.secret_refs ? protected_reference.value)
         )
       ORDER BY operation.sequence`,
      [input.sessionId, input.objectiveId, input.flowDraftId],
    );
    return selectProtectedReplayPreparation(result.rows, input.intentIds, input.entryUrl);
  }

  async reserveMissionProtectedOperation(input: {
    sessionId: string;
    operationId: string;
    intent: MissionAuthoringIntent;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, null, input.sessionId, true);
      const runtime = await this.runtimeContext(q, input.sessionId);
      const result = await q<{ id: string }>(
        `INSERT INTO protected_operations(
           operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,
           environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,
           authorization_id,program_digest,state,phase,safe_output_manifest
         ) VALUES($1,$1,'authoring_session',$2,$3,$4,$5,$6,$7,$8,$9,NULL,'reserved','reserved','[]'::jsonb)
         ON CONFLICT DO NOTHING RETURNING id`,
        [input.operationId,input.sessionId,runtime.projectId,runtime.environmentId,
         session.missionId,input.intent.objectiveId,runtime.agentSessionId,input.intent.flowDraftId,
         input.intent.authorization.authorizationId],
      );
      if (!result.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_OPERATION_ALREADY_RESERVED" });
      await q(
        `INSERT INTO protected_operation_transitions(protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics)
         VALUES($1,1,NULL,'reserved','reserved',0,'{}'::jsonb)`, [result.rows[0]!.id],
      );
      return { protectedOperationId: result.rows[0]!.id };
    });
  }

  async replayMissionOperation(input: { sessionId: string; operationId: string }) {
    const result = await this.database.query<{
      idempotencyKey: string;
      derivedAction: {
        action: AdaptiveSessionOperationInput["action"];
        expectedEffect: AdaptiveSessionOperationInput["expectedEffect"];
        mode: AdaptiveSessionOperationInput["mode"];
      };
    }>(
      `SELECT idempotency_key AS "idempotencyKey",derived_action AS "derivedAction"
         FROM adaptive_operations
        WHERE session_id=$1 AND operation_id=$2`,
      [input.sessionId, input.operationId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0]!;
    return {
      operationId: input.operationId,
      idempotencyKey: row.idempotencyKey,
      action: row.derivedAction.action,
      expectedEffect: row.derivedAction.expectedEffect,
      mode: row.derivedAction.mode,
      protectedInputReferences: [],
    } satisfies AdaptiveSessionOperationInput;
  }

  async closeReservedMissionProtectedOperation(input: { protectedOperationId: string; reasonCode: string }) {
    await this.database.transaction(async (client) => {
      const result = await client.query<{ version: string }>(
        `UPDATE protected_operations SET state='failed_not_applied',phase='compilation_failed',
           mutation_outcome='not_applied',failure_code=$2,recovery_class='do_not_retry',
           completed_at=now(),updated_at=now(),version=version+1
         WHERE id=$1 AND state='reserved' RETURNING version`, [input.protectedOperationId,input.reasonCode],
      );
      if (!result.rowCount) return;
      await client.query(
        `UPDATE operation_bound_protected_inputs SET ciphertext=NULL,initialization_vector=NULL,
           authentication_tag=NULL,lifecycle='destroyed',destroyed_at=now()
         WHERE protected_operation_id=$1 AND lifecycle='active'`, [input.protectedOperationId],
      );
      await client.query(
        `INSERT INTO protected_operation_transitions(protected_operation_id,sequence,from_state,to_state,phase,fencing_token,reason_code,safe_diagnostics)
         SELECT $1,COALESCE(max(sequence),0)+1,'reserved','failed_not_applied','compilation_failed',0,$2,'{}'::jsonb
         FROM protected_operation_transitions WHERE protected_operation_id=$1`, [input.protectedOperationId,input.reasonCode],
      );
    });
  }

  async protectedExecutionContext(sessionId: string, operationId: string) {
    const result = await this.database.query<{
      projectId: string; environmentId: string; missionId: string; objectiveId: string;
      agentSessionId: string; flowDraftId: string; authorizationId: string;
      dispatchDisposition: "execute" | "qualification_only";
    }>(
      `SELECT session.project_id AS "projectId",session.environment_id AS "environmentId",
              operation.mission_id AS "missionId",operation.objective_id AS "objectiveId",
              session.agent_session_id AS "agentSessionId",operation.flow_draft_id AS "flowDraftId",
              operation.authoring_intent->'authorization'->>'authorizationId' AS "authorizationId",
              session.trusted_dispatch_disposition AS "dispatchDisposition"
       FROM adaptive_operations operation
       JOIN adaptive_sessions session ON session.id=operation.session_id
       JOIN mission_authorizations mission_authorization
         ON mission_authorization.id=(operation.authoring_intent->'authorization'->>'authorizationId')::uuid
        AND mission_authorization.mission_id=operation.mission_id
        AND mission_authorization.objective_id=operation.objective_id
        AND mission_authorization.environment_id=session.environment_id
        AND mission_authorization.kind='protected_mutation'
        AND mission_authorization.status='approved'
        AND (mission_authorization.expires_at IS NULL OR mission_authorization.expires_at>now())
       WHERE operation.session_id=$1 AND operation.operation_id=$2
         AND operation.semantic_intent->>'type'='protectedTransaction'`,
      [sessionId, operationId],
    );
    if (!result.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" });
    return result.rows[0]!;
  }

  async authorizeQualificationOnlySession(sessionId: string) {
    const result = await this.database.query(
      `UPDATE adaptive_sessions SET trusted_dispatch_disposition='qualification_only',updated_at=now(),version=version+1
       WHERE id=$1 AND state='active' AND NOT EXISTS(
         SELECT 1 FROM adaptive_operations WHERE session_id=$1 AND dispatch_boundary<>'not_dispatched'
       ) RETURNING id`, [sessionId],
    );
    if (!result.rowCount) throw new ConflictException({ code: "QUALIFICATION_DISPOSITION_NOT_ADMISSIBLE" });
  }

  projectProtectedOperationForAuthoring(input: {
    sessionId: string;
    operationId: string;
    missingFailureCode?: string;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const adaptive = await q<{
        state: string;
        flowDraftId: string;
        missionId: string;
        objectiveId: string;
        environmentId: string;
        authorizationId: string | null;
        intent: MissionAuthoringIntent;
        action: AdaptiveSessionOperationInput["action"];
        outcome: OperationOutcome | null;
        decisionBoundary: AgentDecisionBoundary | null;
        dispatchBoundary: string;
      }>(
        `SELECT operation.state,operation.flow_draft_id AS "flowDraftId",
                operation.mission_id AS "missionId",operation.objective_id AS "objectiveId",
                session.environment_id AS "environmentId",
                operation.authoring_intent->'authorization'->>'authorizationId' AS "authorizationId",
                operation.authoring_intent AS intent,operation.semantic_intent AS action,
                operation.safe_outcome AS outcome,operation.decision_boundary AS "decisionBoundary",
                operation.dispatch_boundary AS "dispatchBoundary"
           FROM adaptive_operations operation
           JOIN adaptive_sessions session ON session.id=operation.session_id
          WHERE operation.session_id=$1 AND operation.operation_id=$2
            AND operation.semantic_intent->>'type'='protectedTransaction'
          FOR UPDATE OF operation,session`,
        [input.sessionId, input.operationId],
      );
      if (!adaptive.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_OPERATION_MISSING" });
      const owner = adaptive.rows[0]!;
      const protectedResult = await q<{
        id: string;
        state: import("@scry/contracts").ProtectedOperationState;
        leaseActive: boolean;
        dispatchState: "not_started" | "authorized" | "started" | "acknowledged";
        mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
        persistenceState: "not_started" | "running" | "committed" | "failed" | "uncertain";
        failureCode: string | null;
        persistedReferences: Record<string, { classification: "public" | "protected"; credentialId?: string; valueId?: string; scope: "project" }>;
      }>(
        `SELECT protected.id,protected.state,COALESCE(protected.lease_expires_at>now(),false) AS "leaseActive",
                protected.dispatch_state AS "dispatchState",protected.mutation_outcome AS "mutationOutcome",
                protected.persistence_state AS "persistenceState",protected.failure_code AS "failureCode",
                protected.persisted_references AS "persistedReferences"
           FROM protected_operations protected
          WHERE protected.owner_kind='authoring_session' AND protected.authoring_session_id=$1
            AND protected.operation_id=$2 AND protected.mission_id=$3 AND protected.objective_id=$4
            AND protected.flow_draft_id=$5 AND protected.environment_id=$6
            AND protected.authorization_id=$7::uuid
          FOR UPDATE`,
        [input.sessionId, input.operationId, owner.missionId, owner.objectiveId,
          owner.flowDraftId, owner.environmentId, owner.authorizationId],
      );
      if (!protectedResult.rowCount) {
        throw new ConflictException({
          code: "MISSION_AUTHORING_PROTECTED_RESERVATION_MISSING",
          safeActions: ["get_flow_authoring"],
        });
      }
      const durable = protectedResult.rows[0]!;
      const activeStates = new Set([
        "planned", "preparing", "ready_to_dispatch", "dispatching", "dispatched",
        "acquiring", "persisting", "persisted", "reconciling",
      ]);
      if (activeStates.has(durable.state)) {
        return { status: "pending" as const, state: durable.state, leaseActive: durable.leaseActive };
      }
      const generatedReferences = Object.entries(durable.persistedReferences).map(([reference, stored]) => ({
        reference,
        ...stored,
      }));
      let outcome: OperationOutcome;
      let decisionBoundary: AgentDecisionBoundary;
      if (durable.state === "completed") {
        outcome = operationOutcomeSchema.parse({
          operationId: input.operationId,
          functionalResult: "succeeded",
          mutationOutcome: "applied",
          privacyResult: "sealed",
          evidenceResult: [],
          qualityFindings: [],
          durationMs: 0,
          generatedReferences,
        });
        decisionBoundary = {
          type: "objective_completed",
          reasonCode: "PROTECTED_OPERATION_COMPLETED",
          safeActions: [],
        };
      } else if (durable.state === "failed_not_applied") {
        const reasonCode = safeReasonCode(durable.failureCode, "PROTECTED_OPERATION_FAILED_NOT_APPLIED");
        outcome = operationOutcomeSchema.parse({
          operationId: input.operationId,
          functionalResult: "failed",
          mutationOutcome: "not_applied",
          privacyResult: "sealed",
          evidenceResult: [],
          qualityFindings: [],
          durationMs: 0,
          reasonCode,
        });
        decisionBoundary = {
          type: "environment_unavailable",
          reasonCode,
          safeActions: ["get_flow_authoring", "advance_flow_authoring"],
        };
      } else {
        const reasonCode = safeReasonCode(durable.failureCode, "PROTECTED_OPERATION_RECOVERY_REQUIRED");
        outcome = operationOutcomeSchema.parse({
          operationId: input.operationId,
          functionalResult: "inconclusive",
          mutationOutcome: "unknown",
          privacyResult: "sealed",
          evidenceResult: [],
          qualityFindings: [],
          durationMs: 0,
          reasonCode,
        });
        decisionBoundary = {
          type: "mutation_reconciliation_required",
          reasonCode,
          safeActions: ["get_flow_authoring"],
        };
      }
      const adaptiveState = durable.state === "completed" ? "completed" : "failed";
      let generatedCredentialIds: string[] = [];
      if (durable.state === "completed") {
        generatedCredentialIds = [...new Set(generatedReferences.flatMap((reference) =>
          reference.classification === "protected" && reference.credentialId
            ? [reference.credentialId]
            : [],
        ))];
        if (generatedCredentialIds.length) {
          const admissible = await q<{ id: string }>(
            `SELECT credential.id::text
               FROM adaptive_sessions session
               JOIN environments environment
                 ON environment.id=session.environment_id
                AND environment.project_id=session.project_id
               JOIN project_credentials credential
                 ON credential.project_id=session.project_id
                AND credential.id=ANY($2::uuid[])
                AND credential.origin_protected_operation_id=$3
                AND credential.deleted_at IS NULL
                AND credential.security_status='active'
              WHERE session.id=$1
                AND environment.secret_refs ? credential.id::text`,
            [input.sessionId, generatedCredentialIds, durable.id],
          );
          if (
            admissible.rows.length !== generatedCredentialIds.length ||
            generatedCredentialIds.some(
              (credentialId) => !admissible.rows.some(({ id }) => id === credentialId),
            )
          ) {
            throw new ConflictException({
              code: "MISSION_AUTHORING_PROTECTED_REFERENCE_PROVENANCE_INVALID",
            });
          }
        }
      }
      await this.writeProtectedProjection(
        q, input, owner, outcome, decisionBoundary, adaptiveState, generatedCredentialIds,
      );
      return { status: "settled" as const, state: durable.state, outcome, decisionBoundary };
    });
  }

  handoff(input: {
    workspaceId: string | null;
    sessionId: string;
    objectiveId: string;
    flowDraftId: string;
    idempotencyKey: string;
    reason: string;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, input.workspaceId, input.sessionId, true);
      if (session.activeObjectiveId === input.objectiveId && session.activeFlowDraftId === input.flowDraftId) return { handedOff: false };
      const running = await q(
        `SELECT 1 FROM adaptive_operations WHERE session_id=$1 AND state='running'
           AND (objective_id<>$2 OR flow_draft_id<>$3) FOR UPDATE`,
        [input.sessionId, input.objectiveId, input.flowDraftId],
      );
      if (running.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_HANDOFF_OPERATION_RUNNING" });
      const target = await q<{ purpose: string }>(
        `SELECT d.purpose FROM flow_drafts d JOIN environments e ON e.id=d.environment_id
         WHERE d.id=$1 AND d.objective_id=$2 AND d.mission_id=$3 AND d.project_id=$4
           AND e.id=$5`,
        [input.flowDraftId, input.objectiveId, session.missionId, session.projectId, session.environmentId],
      );
      if (!target.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_HANDOFF_OWNERSHIP_INVALID" });
      const sequence = await q<{ sequence: number }>(
        `SELECT COALESCE(max(sequence),0)+1 AS sequence FROM mission_authoring_handoffs WHERE session_id=$1`, [input.sessionId],
      );
      const handoffId = randomUUID();
      await q(
        `INSERT INTO mission_authoring_handoffs(
           id,session_id,mission_id,sequence,idempotency_key,source_objective_id,source_flow_draft_id,
           target_objective_id,target_flow_draft_id,reason,state
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'started')`,
        [handoffId, input.sessionId, session.missionId, sequence.rows[0]!.sequence, input.idempotencyKey,
          session.activeObjectiveId, session.activeFlowDraftId, input.objectiveId, input.flowDraftId, input.reason],
      );
      await this.appendEvent(q, input.sessionId, "flow_handoff_started", { handoffId, targetObjectiveId: input.objectiveId, targetFlowDraftId: input.flowDraftId });
      const linkSequence = await q<{ sequence: number }>(
        `SELECT COALESCE(max(sequence),0)+1 AS sequence FROM mission_authoring_session_flows WHERE session_id=$1`, [input.sessionId],
      );
      await q(
        `INSERT INTO mission_authoring_session_flows(session_id,mission_id,objective_id,flow_draft_id,purpose,sequence)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,flow_draft_id) DO NOTHING`,
        [input.sessionId, session.missionId, input.objectiveId, input.flowDraftId, target.rows[0]!.purpose, linkSequence.rows[0]!.sequence],
      );
      await q(
        `UPDATE adaptive_sessions SET active_objective_id=$2,active_flow_draft_id=$3,updated_at=now(),version=version+1 WHERE id=$1`,
        [input.sessionId, input.objectiveId, input.flowDraftId],
      );
      await q(`UPDATE mission_authoring_handoffs SET state='completed',completed_at=now() WHERE id=$1`, [handoffId]);
      await this.appendEvent(q, input.sessionId, "flow_handoff_completed", { handoffId, targetObjectiveId: input.objectiveId, targetFlowDraftId: input.flowDraftId });
      await q(
        `INSERT INTO mission_activities(mission_id,objective_id,type,summary,safe_metadata,technical)
         VALUES($1,$2,'authoring','Flow handoff completed',$3::jsonb,true)`,
        [session.missionId, input.objectiveId, JSON.stringify({ sessionId: input.sessionId, flowDraftId: input.flowDraftId })],
      );
      return { handedOff: true };
    });
  }

  beginMissionOperation(input: {
    workspaceId: string | null;
    sessionId: string;
    operationId: string;
    idempotencyKey: string;
    intent: MissionAuthoringIntent;
    action: AdaptiveSessionOperationInput["action"];
    expectedEffect: AdaptiveSessionOperationInput["expectedEffect"];
    mode: AdaptiveSessionOperationInput["mode"];
    protectedReservation?: {
      mutationIdentity: string;
      dispatchSemantics?: "mutation" | "read_only";
      programDigest: string;
      safeOutputManifest: Array<{
        reference: string;
        classification: "public" | "protected";
        storageName: string;
      }>;
    };
    earlyProtectedOperationId?: string;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, input.workspaceId, input.sessionId, true);
      const existing = await q<{ operationId: string; state: string; outcome: OperationOutcome | null }>(
        `SELECT operation_id AS "operationId",state,safe_outcome AS outcome FROM adaptive_operations
         WHERE session_id=$1 AND idempotency_key=$2`, [input.sessionId, input.idempotencyKey],
      );
      if (existing.rowCount) return { ...existing.rows[0]!, replayed: true };
      const runtime = await this.runtimeContext(q, input.sessionId);
      const sequence = await this.nextOperationSequence(q, input.sessionId);
      await q(
        `INSERT INTO adaptive_operations(
           session_id,operation_id,sequence,mode,state,semantic_intent,expected_effect,policy_digest,
           observation_epoch,idempotency_key,mission_id,objective_id,flow_draft_id,authoring_intent,derived_action
         ) VALUES($1,$2,$3,$4,'running',$5::jsonb,$6::jsonb,$7,NULL,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
        [input.sessionId, input.operationId, sequence, input.mode, JSON.stringify(input.action), JSON.stringify(input.expectedEffect),
          policyDigest(runtime.policy), input.idempotencyKey,
          session.missionId, input.intent.objectiveId, input.intent.flowDraftId,
          JSON.stringify(input.intent), JSON.stringify({ action: input.action, expectedEffect: input.expectedEffect, mode: input.mode })],
      );
      if (input.protectedReservation) {
        if (
          input.action.type !== "protectedTransaction" ||
          input.intent.authorization.kind !== "protected_mutation" ||
          input.protectedReservation.mutationIdentity !== input.operationId
        ) {
          throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_RESERVATION_INVALID" });
        }
        const syntheticCommitments = input.earlyProtectedOperationId
          ? await q<{ semantic: string; commitment: string }>(
            `SELECT semantic,commitment FROM operation_bound_protected_inputs
             WHERE protected_operation_id=$1 AND lifecycle='active' ORDER BY semantic`,
            [input.earlyProtectedOperationId],
          ) : { rows: [] };
        const syntheticInputSetCommitment = syntheticCommitments.rows.length
          ? stableDigest(syntheticCommitments.rows)
          : null;
        const providerIdempotencyCommitment = syntheticCommitments.rows.find(
          (row) => row.semantic === "provider_idempotency_key",
        )?.commitment ?? null;
        const reserved = input.earlyProtectedOperationId
          ? await q<{ id: string }>(
          `UPDATE protected_operations SET program_digest=$2,dispatch_semantics=$3,
             state='planned',phase='planned',safe_output_manifest=$4::jsonb,
             synthetic_input_set_commitment=$5,payload_commitment=$6,
             provider_idempotency_commitment=$7,version=version+1,updated_at=now()
           WHERE id=$1 AND state='reserved' AND program_digest IS NULL RETURNING id`,
          [input.earlyProtectedOperationId,input.protectedReservation.programDigest,
           input.protectedReservation.dispatchSemantics ?? "mutation",
           JSON.stringify(input.protectedReservation.safeOutputManifest),syntheticInputSetCommitment,
           stableDigest({ programDigest: input.protectedReservation.programDigest, syntheticInputSetCommitment }),
           providerIdempotencyCommitment],
        ) : await q<{ id: string }>(
          `INSERT INTO protected_operations(
             operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,
             environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,
             authorization_id,program_digest,dispatch_semantics,state,phase,safe_output_manifest
           ) VALUES($1,$2,'authoring_session',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned','planned',$13::jsonb)
           RETURNING id`,
          [
            input.operationId,
            input.protectedReservation.mutationIdentity,
            input.sessionId,
            runtime.projectId,
            runtime.environmentId,
            session.missionId,
            input.intent.objectiveId,
            runtime.agentSessionId,
            input.intent.flowDraftId,
            input.intent.authorization.authorizationId,
            input.protectedReservation.programDigest,
            input.protectedReservation.dispatchSemantics ?? "mutation",
            JSON.stringify(input.protectedReservation.safeOutputManifest),
          ],
        );
        if (!reserved.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_RESERVATION_BIND_FAILED" });
        await q(
          `INSERT INTO protected_operation_transitions(
             protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics
           ) SELECT $1,COALESCE(max(sequence),0)+1,
                    CASE WHEN $2::boolean THEN 'reserved' ELSE NULL END,'planned','planned',0,'{}'::jsonb
             FROM protected_operation_transitions WHERE protected_operation_id=$1`,
          [reserved.rows[0]!.id,Boolean(input.earlyProtectedOperationId)],
        );
      }
      await this.appendEvent(q, input.sessionId, "operation_started", { operationId: input.operationId, objectiveId: input.intent.objectiveId, flowDraftId: input.intent.flowDraftId });
      return { operationId: input.operationId, state: "running" as const, replayed: false };
    });
  }

  private async writeProtectedProjection(
    q: Query,
    input: { sessionId: string; operationId: string },
    owner: {
      state: string;
      flowDraftId: string;
      missionId: string;
      objectiveId: string;
      intent: MissionAuthoringIntent;
      action: AdaptiveSessionOperationInput["action"];
      outcome: OperationOutcome | null;
      decisionBoundary?: AgentDecisionBoundary | null;
      dispatchBoundary?: string;
    },
    outcome: OperationOutcome,
    decisionBoundary: AgentDecisionBoundary,
    adaptiveState: "completed" | "failed",
    generatedCredentialIds: string[],
  ) {
    const capabilityManifestDigest = createHash("sha256").update("durable-protected-operation").digest("hex");
    const projected = await q(
      `UPDATE adaptive_operations SET state=$3,
         capability_manifest_digest=COALESCE(capability_manifest_digest,$4),
         dispatch_boundary=CASE
           WHEN $5='applied' THEN 'acknowledged'
           WHEN $5='unknown' AND dispatch_boundary='not_dispatched' THEN 'dispatching'
           ELSE dispatch_boundary
         END,
         mutation_outcome=$5,functional_result=$6,privacy_result=$7,
         evidence_result=$8::jsonb,quality_findings=$9::jsonb,safe_outcome=$10::jsonb,
         decision_boundary=$11::jsonb,completed_at=COALESCE(completed_at,now())
       WHERE session_id=$1 AND operation_id=$2
         AND (state IS DISTINCT FROM $3
           OR capability_manifest_digest IS DISTINCT FROM COALESCE(capability_manifest_digest,$4)
           OR dispatch_boundary IS DISTINCT FROM CASE
             WHEN $5='applied' THEN 'acknowledged'
             WHEN $5='unknown' AND dispatch_boundary='not_dispatched' THEN 'dispatching'
             ELSE dispatch_boundary
           END
           OR mutation_outcome IS DISTINCT FROM $5
           OR functional_result IS DISTINCT FROM $6
           OR privacy_result IS DISTINCT FROM $7
           OR evidence_result IS DISTINCT FROM $8::jsonb
           OR quality_findings IS DISTINCT FROM $9::jsonb
           OR safe_outcome IS DISTINCT FROM $10::jsonb
           OR decision_boundary IS DISTINCT FROM $11::jsonb)
       RETURNING operation_id`,
      [input.sessionId, input.operationId, adaptiveState,
        capabilityManifestDigest,
        outcome.mutationOutcome, outcome.functionalResult, outcome.privacyResult,
        JSON.stringify(outcome.evidenceResult), JSON.stringify(outcome.qualityFindings),
        JSON.stringify(outcome), JSON.stringify(decisionBoundary)],
    );
    const projectionChanged = (projected.rowCount ?? 0) > 0;
    let stepAppended = false;
    if (adaptiveState === "completed") {
      const draft = await q<{ version: number; createdByAgentSessionId: string; stepExists: boolean }>(
        `SELECT version,created_by_agent_session_id AS "createdByAgentSessionId",
                COALESCE(plan->'steps','[]'::jsonb) @> $4::jsonb AS "stepExists"
           FROM flow_drafts WHERE id=$1 AND mission_id=$2 AND objective_id=$3 FOR UPDATE`,
        [owner.flowDraftId, owner.missionId, owner.objectiveId,
          JSON.stringify([{ id: input.operationId }])],
      );
      if (!draft.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_FLOW_DRAFT_MISSING" });
      if (!draft.rows[0]!.stepExists) {
        const nextVersion = draft.rows[0]!.version + 1;
        const step = {
          id: input.operationId,
          title: `Authoring ${owner.intent.action.kind}: ${safeIntentTitle(owner.intent)}`,
          action: owner.action,
          assertions: [], onFailure: "stop", evidence: [], captureIntent: "final",
        };
        await q(
          `UPDATE flow_drafts SET plan=jsonb_set(plan,'{steps}',COALESCE(plan->'steps','[]'::jsonb) || $2::jsonb,true),
             version=$3,state='editing',updated_at=now() WHERE id=$1`,
          [owner.flowDraftId, JSON.stringify(step), nextVersion],
        );
        await q(
          `UPDATE flow_compilations SET status='stale',invalidated_at=now() WHERE draft_id=$1
             AND status IN ('pending','execution_ready','calibration_required')`,
          [owner.flowDraftId],
        );
        await q(
          `INSERT INTO flow_draft_events(draft_id,version,type,agent_session_id,summary,safe_metadata)
           VALUES($1,$2,'authoring_step_appended',$3,'Durable protected operation projected',$4::jsonb)`,
          [owner.flowDraftId, nextVersion, draft.rows[0]!.createdByAgentSessionId,
            JSON.stringify({ operationId: input.operationId, intentId: owner.intent.intentId, outcome: "completed" })],
        );
        stepAppended = true;
      }
    }
    await q(
      `UPDATE adaptive_sessions SET
         state=CASE
           WHEN $3='unknown' THEN 'recovery_required'
           WHEN $3='applied' AND state='recovery_required' THEN 'active'
           ELSE state
         END,
         protected_reference_allowlist=(
           SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb)
             FROM (
               SELECT DISTINCT value
                 FROM jsonb_array_elements_text(
                   protected_reference_allowlist || $4::jsonb
                 ) AS value
             ) distinct_refs
         ),
         decision_boundary=$2::jsonb,updated_at=now(),version=version+1
       WHERE id=$1
         AND (state IS DISTINCT FROM CASE
           WHEN $3='unknown' THEN 'recovery_required'
           WHEN $3='applied' AND state='recovery_required' THEN 'active'
           ELSE state
         END OR decision_boundary IS DISTINCT FROM $2::jsonb
         OR protected_reference_allowlist IS DISTINCT FROM (
           SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb)
             FROM (
               SELECT DISTINCT value
                 FROM jsonb_array_elements_text(
                   protected_reference_allowlist || $4::jsonb
                 ) AS value
             ) distinct_refs
         ))`,
      [input.sessionId, JSON.stringify(decisionBoundary), outcome.mutationOutcome,
        JSON.stringify(generatedCredentialIds)],
    );
    if (projectionChanged) {
      await this.appendEvent(q, input.sessionId,
        adaptiveState === "completed" ? "operation_completed" : "operation_failed", {
          operationId: input.operationId,
          functionalResult: outcome.functionalResult,
          mutationOutcome: outcome.mutationOutcome,
          authority: "protected_operations",
        });
      await q(
        `INSERT INTO mission_activities(mission_id,objective_id,type,summary,safe_metadata,technical)
         VALUES($1,$2,'authoring','Durable protected operation projected',$3::jsonb,true)`,
        [owner.missionId, owner.objectiveId,
          JSON.stringify({ flowDraftId: owner.flowDraftId, operationId: input.operationId,
            outcome: adaptiveState, stepAppended })],
      );
    }
  }

  settleMissionOperation(input: {
    sessionId: string;
    operationId: string;
    intent: MissionAuthoringIntent;
    action: AdaptiveSessionOperationInput["action"];
    outcome: OperationOutcome;
    capabilityManifestDigest: string;
    decisionBoundary: AgentDecisionBoundary;
  }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const operation = await q<{
        flowDraftId: string;
        missionId: string;
        objectiveId: string;
        projectId: string;
        environmentId: string;
        authoringIntent: unknown;
      }>(
        `SELECT operation.flow_draft_id AS "flowDraftId",operation.mission_id AS "missionId",
                operation.objective_id AS "objectiveId",session.project_id AS "projectId",
                session.environment_id AS "environmentId",
                operation.authoring_intent AS "authoringIntent"
           FROM adaptive_operations operation
           JOIN adaptive_sessions session ON session.id=operation.session_id
          WHERE operation.session_id=$1 AND operation.operation_id=$2
            AND operation.state='running' FOR UPDATE OF operation`,
        [input.sessionId, input.operationId],
      );
      if (!operation.rowCount) throw new ConflictException({ code: "ADAPTIVE_OPERATION_NOT_RUNNING" });
      const durableIntent = missionAuthoringIntentSchema.parse(operation.rows[0]!.authoringIntent);
      if (durableIntent.intentId !== input.intent.intentId) {
        throw new ConflictException({ code: "MISSION_AUTHORING_INTENT_MISMATCH" });
      }
      const state = input.outcome.functionalResult === "succeeded" && input.outcome.mutationOutcome !== "unknown"
        ? "completed"
        : "failed";
      await q(
        `UPDATE adaptive_operations SET state=$3,capability_manifest_digest=$4,
           dispatch_boundary=CASE WHEN dispatch_boundary='dispatching' THEN 'acknowledged' ELSE dispatch_boundary END,
           mutation_outcome=$5,functional_result=$6,privacy_result=$7,evidence_result=$8::jsonb,
           quality_findings=$9::jsonb,safe_outcome=$10::jsonb,decision_boundary=$11::jsonb,completed_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND state='running'`,
        [input.sessionId, input.operationId, state, input.capabilityManifestDigest, input.outcome.mutationOutcome,
          input.outcome.functionalResult, input.outcome.privacyResult, JSON.stringify(input.outcome.evidenceResult),
          JSON.stringify(input.outcome.qualityFindings), JSON.stringify(input.outcome), JSON.stringify(input.decisionBoundary)],
      );
      const owner = operation.rows[0]!;
      await this.projectCredentialLifecycle(q, {
        projectId: owner.projectId,
        environmentId: owner.environmentId,
        missionId: owner.missionId,
        objectiveId: owner.objectiveId,
        operationId: input.operationId,
        intent: durableIntent,
        outcome: input.outcome,
      });
      if (state === "completed" && input.outcome.mutationOutcome !== "unknown") {
        const draft = await q<{ version: number; createdByAgentSessionId: string }>(
          `SELECT version,created_by_agent_session_id AS "createdByAgentSessionId" FROM flow_drafts WHERE id=$1
           AND mission_id=$2 AND objective_id=$3 FOR UPDATE`, [owner.flowDraftId, owner.missionId, owner.objectiveId],
        );
        if (!draft.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_FLOW_DRAFT_MISSING" });
        const nextVersion = draft.rows[0]!.version + 1;
        const step = {
          id: input.operationId,
          title: `Authoring ${input.intent.action.kind}: ${safeIntentTitle(input.intent)}`,
          action: input.action,
          assertions: [], onFailure: "stop", evidence: [], captureIntent: "final",
        };
        await q(
          `UPDATE flow_drafts SET plan=jsonb_set(plan,'{steps}',COALESCE(plan->'steps','[]'::jsonb) || $2::jsonb,true),
             version=$3,state='editing',updated_at=now() WHERE id=$1`,
          [owner.flowDraftId, JSON.stringify(step), nextVersion],
        );
        await q(
          `UPDATE flow_compilations SET status='stale',invalidated_at=now() WHERE draft_id=$1
             AND status IN ('pending','execution_ready','calibration_required')`, [owner.flowDraftId],
        );
        await q(
          `INSERT INTO flow_draft_events(draft_id,version,type,agent_session_id,summary,safe_metadata)
           VALUES($1,$2,'authoring_step_appended',$3,'Server-owned authoring step appended',$4::jsonb)`,
          [owner.flowDraftId, nextVersion, draft.rows[0]!.createdByAgentSessionId,
            JSON.stringify({ operationId: input.operationId, intentId: input.intent.intentId, outcome: input.outcome.functionalResult })],
        );
      }
      await this.appendEvent(q, input.sessionId, state === "completed" ? "operation_completed" : "operation_failed", {
        operationId: input.operationId, functionalResult: input.outcome.functionalResult, mutationOutcome: input.outcome.mutationOutcome,
      });
      if (input.outcome.mutationOutcome === "unknown") {
        await q(
          `UPDATE adaptive_sessions SET state='recovery_required',decision_boundary=$2::jsonb,
             version=version+1,updated_at=now() WHERE id=$1 AND state='active'`,
          [input.sessionId, JSON.stringify(input.decisionBoundary)],
        );
        await this.appendEvent(q, input.sessionId, "recovery_required", {
          operationId: input.operationId,
          reasonCode: input.decisionBoundary.reasonCode,
        });
      }
      await q(
        `INSERT INTO mission_activities(mission_id,objective_id,type,summary,safe_metadata,technical)
         VALUES($1,$2,'authoring','Server-owned authoring operation settled',$3::jsonb,true)`,
        [owner.missionId, owner.objectiveId, JSON.stringify({ flowDraftId: owner.flowDraftId, operationId: input.operationId, outcome: state })],
      );
      return { state, outcome: input.outcome, decisionBoundary: input.decisionBoundary };
    });
  }

  projectCredentialLifecycleForAuthoring(input: { sessionId: string; operationId: string }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const operation = await q<{
        projectId: string;
        environmentId: string;
        missionId: string;
        objectiveId: string;
        intent: unknown;
        outcome: unknown;
      }>(
        `SELECT session.project_id AS "projectId",session.environment_id AS "environmentId",
                operation.mission_id AS "missionId",operation.objective_id AS "objectiveId",
                operation.authoring_intent AS intent,operation.safe_outcome AS outcome
           FROM adaptive_operations operation
           JOIN adaptive_sessions session ON session.id=operation.session_id
          WHERE operation.session_id=$1 AND operation.operation_id=$2
            AND operation.state IN ('completed','failed')
          FOR UPDATE OF operation`,
        [input.sessionId, input.operationId],
      );
      if (!operation.rowCount) {
        throw new ConflictException({ code: "ADAPTIVE_OPERATION_NOT_SETTLED" });
      }
      const owner = operation.rows[0]!;
      const intent = missionAuthoringIntentSchema.parse(owner.intent);
      const outcome = operationOutcomeSchema.parse(owner.outcome);
      const projected = await this.projectCredentialLifecycle(q, {
        projectId: owner.projectId,
        environmentId: owner.environmentId,
        missionId: owner.missionId,
        objectiveId: owner.objectiveId,
        operationId: input.operationId,
        intent,
        outcome,
      });
      return { projected, lifecycle: intent.credentialLifecycle?.effect ?? null };
    });
  }

  private async projectCredentialLifecycle(
    q: Query,
    input: {
      projectId: string;
      environmentId: string;
      missionId: string;
      objectiveId: string;
      operationId: string;
      intent: MissionAuthoringIntent;
      outcome: OperationOutcome;
    },
  ) {
    const lifecycle = input.intent.credentialLifecycle;
    if (!lifecycle || input.outcome.mutationOutcome === "not_applied") return false;

    const references = lifecycle.credentialReferenceIds;
    const credentials = await q<{ id: string; securityStatus: "active" | "compromised" | "revoked" }>(
      `SELECT credential.id::text,credential.security_status AS "securityStatus"
         FROM environments environment
         JOIN project_credentials credential ON credential.project_id=environment.project_id
        WHERE environment.id=$1 AND environment.project_id=$2
          AND credential.id=ANY($3::uuid[]) AND credential.deleted_at IS NULL
          AND environment.secret_refs ? credential.id::text
        FOR UPDATE OF credential`,
      [input.environmentId, input.projectId, references],
    );
    if (credentials.rows.length !== references.length ||
        references.some((reference) => !credentials.rows.some(({ id }) => id === reference))) {
      throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED" });
    }

    const confirmed = input.outcome.mutationOutcome === "applied" &&
      input.outcome.functionalResult === "succeeded";
    const targetStatus = confirmed ? "revoked" : "compromised";
    const updated = await q<{ id: string }>(
      `UPDATE project_credentials
          SET security_status=$2,updated_at=now()
        WHERE id=ANY($1::uuid[])
          AND security_status = ANY($3::text[])
        RETURNING id::text`,
      [references, targetStatus,
        confirmed ? ["active", "compromised"] : ["active"]],
    );
    if (!updated.rowCount) return false;
    await q(
      `INSERT INTO mission_activities(mission_id,objective_id,type,summary,safe_metadata,technical)
       VALUES($1,$2,'authoring','Protected credential lifecycle projected',$3::jsonb,true)`,
      [input.missionId, input.objectiveId, JSON.stringify({
        operationId: input.operationId,
        effect: lifecycle.effect,
        result: targetStatus,
        credentialCount: references.length,
      })],
    );
    return true;
  }

  async closeAtSafeBoundary(input: { workspaceId: string | null; sessionId: string; idempotencyKey: string }) {
    return this.database.transaction(async (client) => {
      const q = bind(client);
      const session = await this.requireSession(q, input.workspaceId, input.sessionId, true);
      const unsafe = await q(
        `SELECT 1 FROM adaptive_operations WHERE session_id=$1 AND
          (state='running' OR mutation_outcome='unknown') LIMIT 1 FOR UPDATE`, [input.sessionId],
      );
      if (unsafe.rowCount) throw new ConflictException({ code: "MISSION_AUTHORING_CLOSE_RECONCILIATION_REQUIRED" });
      if (session.state === "completed") return { replayed: true };
      await this.transitionLocked(q, input.sessionId, session.state, "completed", "session_closed", {}, input.idempotencyKey);
      await q(
        `INSERT INTO mission_activities(mission_id,objective_id,type,summary,safe_metadata,technical)
         VALUES($1,$2,'authoring','Mission authoring session closed',$3::jsonb,true)`,
        [session.missionId, session.activeObjectiveId, JSON.stringify({ sessionId: input.sessionId })],
      );
      return { replayed: false };
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
           policy_digest,observation_epoch,candidate_decision_digest,idempotency_key,
           mission_id,objective_id,flow_draft_id,authoring_intent,derived_action
         ) VALUES($1,$2,$3,$4,'running',$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)`,
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
          session.missionId,
          session.activeObjectiveId,
          session.activeFlowDraftId,
          JSON.stringify({ action: input.action, expectedEffect: input.expectedEffect }),
          JSON.stringify({ action: input.action, expectedEffect: input.expectedEffect, mode: input.mode }),
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

  async resolveProtectedInput(sessionId: string, operationId: string, reference: string) {
    try {
      return await this.resolveCredential(sessionId, reference);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
    }
    const result = await this.database.query<{
      ciphertext: string; initializationVector: string; authenticationTag: string;
    }>(
      `SELECT source.ciphertext,source.initialization_vector AS "initializationVector",
              source.authentication_tag AS "authenticationTag"
       FROM operation_bound_protected_inputs source
       JOIN protected_operations operation ON operation.id=source.protected_operation_id
       WHERE source.id=$1 AND operation.authoring_session_id=$2 AND operation.operation_id=$3
         AND source.lifecycle='active' AND operation.state IN ('planned','preparing','ready_to_dispatch')`,
      [reference,sessionId,operationId],
    );
    if (!result.rowCount) throw new ConflictException({ code: "ADAPTIVE_PROTECTED_INPUT_UNAVAILABLE" });
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
        safeActions: ["get_flow_authoring"],
      };
      const updated = await q(
        `UPDATE adaptive_operations SET state='failed',mutation_outcome='unknown',
           functional_result='inconclusive',safe_outcome=jsonb_build_object(
             'operationId',$2,
             'functionalResult','inconclusive',
             'mutationOutcome','unknown',
             'privacyResult','unverified',
             'evidenceResult','[]'::jsonb,
             'qualityFindings','[]'::jsonb,
             'durationMs',0,
             'reasonCode','ADAPTIVE_OPERATION_INTERRUPTED'
           ),decision_boundary=$3::jsonb,completed_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND state='running'
           AND (semantic_intent->>'type' IN
             ('click','fill','select','check','press','protectedTransaction') OR
             (semantic_intent->>'type'='sameOriginRequest' AND semantic_intent->>'method'<>'GET'))`,
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
      mutating: boolean;
    }>(
      `SELECT operation.state,operation.dispatch_boundary AS "dispatchBoundary",
              COALESCE(lease.lease_expires_at>now(),false) AS "leaseHealthy",
              (operation.semantic_intent->>'type' IN
                ('click','fill','select','check','press','protectedTransaction') OR
               (operation.semantic_intent->>'type'='sameOriginRequest' AND operation.semantic_intent->>'method'<>'GET')) AS mutating
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
        row.mutating &&
        !row.leaseHealthy &&
        row.dispatchBoundary !== "not_dispatched",
      canResume:
        row.state === "running" &&
        !row.leaseHealthy &&
        (!row.mutating || row.dispatchBoundary === "not_dispatched"),
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
      const state = input.outcome.functionalResult === "succeeded" && input.outcome.mutationOutcome !== "unknown"
        ? "completed"
        : "failed";
      const updated = await q(
        `UPDATE adaptive_operations SET
           state=$3,capability_manifest_digest=$4,
           dispatch_boundary=CASE
             WHEN dispatch_boundary='dispatching' THEN 'acknowledged'
             ELSE dispatch_boundary
           END,
           mutation_outcome=$5,functional_result=$6,privacy_result=$7,
           evidence_result=$8::jsonb,quality_findings=$9::jsonb,safe_outcome=$10::jsonb,
           decision_boundary=$11::jsonb,completed_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND state='running'`,
        [
          input.sessionId,
          input.operationId,
          state,
          input.capabilityManifestDigest,
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
        `UPDATE adaptive_sessions SET
           state=CASE WHEN $3 THEN 'recovery_required' ELSE state END,
           decision_boundary=$2::jsonb,updated_at=now(),version=version+1
         WHERE id=$1`,
        [
          input.sessionId,
          JSON.stringify(input.decisionBoundary),
          input.outcome.mutationOutcome === "unknown",
        ],
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
      const operation = await q<{ dispatchBoundary: string; actionType: string; method: string | null }>(
        `SELECT dispatch_boundary AS "dispatchBoundary",
                semantic_intent->>'type' AS "actionType",semantic_intent->>'method' AS method
         FROM adaptive_operations
         WHERE session_id=$1 AND operation_id=$2 AND state='running' FOR UPDATE`,
        [sessionId, operationId],
      );
      if (!operation.rowCount) return;
      const mutating = [
        "click",
        "fill",
        "select",
        "check",
        "press",
        "protectedTransaction",
      ].includes(operation.rows[0]!.actionType) ||
        (operation.rows[0]!.actionType === "sameOriginRequest" && operation.rows[0]!.method !== "GET");
      const crossedDispatch = mutating && operation.rows[0]!.dispatchBoundary !== "not_dispatched";
      const policyRefused = reasonCode === "EXECUTION_MODE_POLICY_DENIED";
      const boundary = crossedDispatch
        ? {
            type: "mutation_reconciliation_required",
            reasonCode: "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN",
            safeActions: ["get_flow_authoring"],
          }
        : {
            type: policyRefused ? "policy_refused" : "environment_unavailable",
            reasonCode,
            safeActions: ["get_flow_authoring", "advance_flow_authoring"],
          };
      const failed = await q(
        `UPDATE adaptive_operations SET state='failed',functional_result='failed',
           mutation_outcome=CASE WHEN $4 THEN 'unknown' ELSE 'not_applied' END,
           safe_outcome=jsonb_build_object(
             'operationId',$2,
             'functionalResult','failed',
             'mutationOutcome',CASE WHEN $4 THEN 'unknown' ELSE 'not_applied' END,
             'privacyResult','unverified',
             'evidenceResult','[]'::jsonb,
             'qualityFindings','[]'::jsonb,
             'durationMs',0,
             'reasonCode',$5::text
           ),completed_at=now(),decision_boundary=$3::jsonb
         WHERE session_id=$1 AND operation_id=$2 AND state='running'`,
        [sessionId, operationId, JSON.stringify(boundary), crossedDispatch, reasonCode],
      );
      if (failed.rowCount) {
        await q(
          `UPDATE adaptive_sessions SET
             state=CASE WHEN $3 THEN 'recovery_required' ELSE state END,
             version=version+1,decision_boundary=$2::jsonb,updated_at=now()
           WHERE id=$1 AND state='active'`,
          [sessionId, JSON.stringify(boundary), crossedDispatch],
        );
        await this.appendEvent(q, sessionId, "operation_failed", { operationId, reasonCode });
        if (crossedDispatch) {
          await this.appendEvent(q, sessionId, "recovery_required", { reasonCode });
        } else {
          await this.appendEvent(q, sessionId, "decision_boundary_reached", {
            operationId,
            type: boundary.type,
            reasonCode,
          });
        }
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
         WHERE session_id=$1 AND owner_id=$2 AND fencing_token=$3
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
      missionId: string;
      objectiveId: string;
      flowDraftId: string;
      activeObjectiveId: string;
      activeFlowDraftId: string;
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
      `SELECT s.id,s.project_id AS "projectId",s.mission_id AS "missionId",
              s.objective_id AS "objectiveId",s.flow_draft_id AS "flowDraftId",
              s.active_objective_id AS "activeObjectiveId",s.active_flow_draft_id AS "activeFlowDraftId",
              s.environment_id AS "environmentId",
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
      projectId: string;
      missionId: string;
      objectiveId: string;
      flowDraftId: string;
      agentSessionId: string;
      environmentId: string;
      correlationId: string;
      allowedOrigins: string[];
      baseOrigin: string;
      policy: unknown;
      lastOperationId: string | null;
      lastDocumentEpoch: number | null;
      lastUrl: string | null;
    }>(
      `SELECT session.id AS "sessionId",session.project_id AS "projectId",
              session.mission_id AS "missionId",session.active_objective_id AS "objectiveId",
              session.active_flow_draft_id AS "flowDraftId",session.agent_session_id AS "agentSessionId",
              session.environment_id AS "environmentId",
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
      projectId: row.projectId,
      missionId: row.missionId,
      objectiveId: row.objectiveId,
      flowDraftId: row.flowDraftId,
      agentSessionId: row.agentSessionId,
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
    const result = await q<{ policy: unknown; secretRefs: unknown }>(
      `SELECT e.policy,e.secret_refs AS "secretRefs"
       FROM projects p JOIN environments e ON e.project_id=p.id
       WHERE p.id=$1 AND e.id=$2 AND ($3::uuid IS NULL OR p.workspace_id=$3)`,
      [projectId, environmentId, workspaceId],
    );
    if (!result.rowCount) {
      throw new NotFoundException({
        code: "PROJECT_ENVIRONMENT_REQUIRED",
        safeActions: ["list_environments", "create_test_environment"],
      });
    }
    return result.rows[0]!;
  }

  private async requireActiveProtectedReferences(
    q: Query,
    projectId: string | undefined,
    environmentId: string,
    references: string[],
    sessionId?: string,
  ) {
    if (!references.length) return;
    const active = await q<{ id: string }>(
      `SELECT credential.id::text
         FROM environments environment
         JOIN project_credentials credential
           ON credential.project_id=environment.project_id
          AND credential.id=ANY($3::uuid[])
          AND credential.deleted_at IS NULL
          AND credential.security_status='active'
        WHERE environment.id=$2
          AND ($1::uuid IS NULL OR environment.project_id=$1)
          AND ($4::uuid IS NULL OR EXISTS (
            SELECT 1 FROM adaptive_sessions session
             WHERE session.id=$4 AND session.project_id=environment.project_id
               AND session.environment_id=environment.id
          ))
          AND environment.secret_refs ? credential.id::text`,
      [projectId ?? null, environmentId, references, sessionId ?? null],
    );
    const activeIds = new Set(active.rows.map(({ id }) => id));
    if (references.some((reference) => !activeIds.has(reference))) {
      throw new ConflictException({ code: "PROTECTED_REFERENCE_INACTIVE" });
    }
  }

  private async validateControlPlaneLinks(q: Query, input: StartAdaptiveSessionInput) {
    const ownership = await q<{ purpose: string }>(
      `SELECT d.purpose
       FROM missions m
       JOIN mission_objectives o ON o.mission_id=m.id
       JOIN flow_drafts d
         ON d.mission_id=m.id
        AND d.objective_id=o.id
        AND d.project_id=m.project_id
       WHERE m.id=$1 AND o.id=$2 AND d.id=$3 AND m.project_id=$4`,
      [input.missionId, input.objectiveId, input.flowDraftId, input.projectId],
    );
    if (!ownership.rowCount) {
      throw new ConflictException({ code: "MISSION_FLOW_AUTHORING_OWNERSHIP_INVALID" });
    }
    return ownership.rows[0]!;
  }
}

function isAuthoringMutation(intent: MissionAuthoringIntent) {
  return ["activate", "fill", "select", "set_checked", "press", "acquire_protected_outputs"].includes(intent.action.kind) ||
    (intent.action.kind === "same_origin_request" && intent.action.method !== "GET");
}

function safeReasonCode(value: string | null | undefined, fallback: string) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : fallback;
}

function policyDigest(policy: ExecutionPolicy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function stableDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalReplayUrl(value: string) {
  try {
    return new URL(value).href;
  } catch {
    throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_REPLAY_CHECKPOINT_UNAVAILABLE" });
  }
}

export function requireEnvironmentCapabilities(
  environment: { policy: unknown; secretRefs: unknown },
  input: Pick<StartAdaptiveSessionInput, "allowedOrigins" | "initialProtectedReferenceIds">,
) {
  const policy = executionPolicySchema.parse(environment.policy);
  const requestedOrigins = [...new Set(input.allowedOrigins.map((value) => new URL(value).origin))];
  const missingOriginCount = requestedOrigins.filter(
    (origin) => !policy.allowedOrigins.includes(origin),
  ).length;
  if (missingOriginCount) {
    throw new ConflictException({
      code: "ENVIRONMENT_CAPABILITY_INCOMPLETE",
      capability: "allowed_origins",
      missingCount: missingOriginCount,
      safeActions: ["list_environments", "create_test_environment"],
    });
  }
  const environmentReferences = Array.isArray(environment.secretRefs)
    ? new Set(environment.secretRefs.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  if (
    (input.initialProtectedReferenceIds ?? []).some(
      (reference) => !environmentReferences.has(reference),
    )
  ) {
    throw new ConflictException({
      code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
      safeActions: ["list_project_credentials", "authorize_environment_credentials"],
    });
  }
  return requestedOrigins;
}

export function selectProtectedReplayPreparation(
  rows: Array<{
    sequence: number;
    intentId: string;
    intent: MissionAuthoringIntent;
    observedUrl: string;
  }>,
  intentIds: string[],
  rawEntryUrl: string,
) {
  if (new Set(intentIds).size !== intentIds.length) {
    throw new ConflictException({ code: "MISSION_AUTHORING_PREPARATION_INVALID" });
  }
  const selected = new Set(intentIds);
  for (const intentId of selected) {
    if (rows.filter((row) => row.intentId === intentId).length !== 1) {
      throw new ConflictException({ code: "MISSION_AUTHORING_PREPARATION_INVALID" });
    }
  }
  const entryUrl = canonicalReplayUrl(rawEntryUrl);
  let checkpointIndex = rows.length - 1;
  if (checkpointIndex < 0 || canonicalReplayUrl(rows[checkpointIndex]!.observedUrl) !== entryUrl) {
    throw new ConflictException({ code: "MISSION_AUTHORING_PROTECTED_REPLAY_CHECKPOINT_UNAVAILABLE" });
  }
  while (
    checkpointIndex > 0 &&
    canonicalReplayUrl(rows[checkpointIndex - 1]!.observedUrl) === entryUrl
  ) {
    checkpointIndex -= 1;
  }
  const checkpointSequence = rows[checkpointIndex]!.sequence;
  return rows
    .filter((row) => row.sequence > checkpointSequence && selected.has(row.intentId))
    .map((row) => row.intent);
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

function safeIntentTitle(intent: MissionAuthoringIntent) {
  const target = "target" in intent.action ? intent.action.target : undefined;
  return (target?.concept ?? intent.action.kind).replace(/[^a-zA-Z0-9 .:_-]/g, "").slice(0, 180);
}
