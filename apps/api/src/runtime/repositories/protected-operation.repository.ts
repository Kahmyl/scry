import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  assertProtectedOperationTransition,
  projectMutationReceipt,
  protectedOperationDispatchMayBegin,
  protectedOperationLeaseExpiryState,
  protectedOperationTerminalStates,
  type MutationReceipt,
  type MutationReceiptProjectionSource,
  type ProtectedOperationOwnerKind,
  type ProtectedOperationState,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

type Owner =
  | {
      ownerKind: "authoring_session";
      ownerId: string;
      flowDraftId: string;
      authorizationId?: string;
    }
  | { ownerKind: "run"; ownerId: string; flowRevisionId: string; authorizationId?: string };

export type CreateProtectedOperationInput = Owner & {
  operationId: string;
  mutationIdentity: string;
  dispatchSemantics?: "mutation" | "read_only";
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  programDigest: string;
  safeOutputManifest: Array<{
    reference: string;
    classification: "public" | "protected";
    storageName: string;
  }>;
};

export type ReserveProtectedOperationInput = Owner &
  Omit<
    CreateProtectedOperationInput,
    keyof Owner | "programDigest" | "safeOutputManifest" | "dispatchSemantics"
  >;

type OperationRow = {
  id: string;
  state: ProtectedOperationState;
  phase: string;
  version: string;
  fencingToken: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  dispatchState: "not_started" | "authorized" | "started" | "acknowledged";
  mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
  persistedReferences: Record<
    string,
    {
      classification: "public" | "protected";
      credentialId?: string;
      valueId?: string;
      scope: "run" | "project";
    }
  >;
  mutationIdentity: string;
  dispatchSemantics?: "mutation" | "read_only";
  programDigest: string;
  safeOutputManifest: CreateProtectedOperationInput["safeOutputManifest"];
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  flowDraftId: string | null;
  flowRevisionId: string | null;
  authorizationId: string | null;
  authorityModel: "legacy" | "canonical";
  preparedExecutionCapabilityId: string | null;
};

type ProtectedOperationBinding = {
  mutationIdentity: string;
  dispatchSemantics?: "mutation" | "read_only";
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  programDigest: string;
  safeOutputManifest: CreateProtectedOperationInput["safeOutputManifest"];
  flowDraftId?: string;
  flowRevisionId?: string;
  authorizationId?: string;
  preparedExecutionCapabilityId?: string;
};

type ReceiptOperationRow = {
  authorityModel: "legacy" | "canonical";
  receiptId: string;
  operationId: string;
  ownerKind: ProtectedOperationOwnerKind;
  ownerId: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  runId: string | null;
  praxisSessionId: string | null;
  dispatchSemantics: "mutation" | "read_only";
  programDigest: string | null;
  syntheticInputSetCommitment: string | null;
  payloadCommitment: string | null;
  providerIdempotencyCommitment: string | null;
  state: ProtectedOperationState;
  dispatchState: "not_started" | "authorized" | "started" | "acknowledged";
  mutationOutcome: "not_attempted" | "not_applied" | "applied" | "unknown";
  persistenceState: "not_started" | "running" | "committed" | "failed" | "uncertain";
  persistedReferences: MutationReceiptProjectionSource["persistedReferences"];
  failureCode: string | null;
};

@Injectable()
export class ProtectedOperationRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async reserve(input: ReserveProtectedOperationInput) {
    const result = await this.database.query<{ id: string; state: "reserved" }>(
      `INSERT INTO protected_operations(
         operation_id,mutation_identity,owner_kind,authoring_session_id,run_id,project_id,
         environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,flow_revision_id,
         authorization_id,program_digest,state,phase,safe_output_manifest
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,'reserved','reserved','[]'::jsonb)
       ON CONFLICT DO NOTHING RETURNING id,state`,
      [
        input.operationId,
        input.mutationIdentity,
        input.ownerKind,
        input.ownerKind === "authoring_session" ? input.ownerId : null,
        input.ownerKind === "run" ? input.ownerId : null,
        input.projectId,
        input.environmentId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.ownerKind === "authoring_session" ? input.flowDraftId : null,
        input.ownerKind === "run" ? input.flowRevisionId : null,
        input.authorizationId ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_ALREADY_EXISTS");
    await this.appendTransition(result.rows[0]!.id, null, "reserved", "reserved", 0);
    return result.rows[0]!;
  }

  async bindProgram(input: {
    id: string;
    programDigest: string;
    dispatchSemantics?: "mutation" | "read_only";
    safeOutputManifest: CreateProtectedOperationInput["safeOutputManifest"];
    syntheticInputSetCommitment?: string;
    payloadCommitment?: string;
    providerIdempotencyCommitment?: string;
  }) {
    const result = await this.database.query<{ id: string }>(
      `UPDATE protected_operations SET program_digest=$2,dispatch_semantics=$3,
         safe_output_manifest=$4::jsonb,synthetic_input_set_commitment=$5,
         payload_commitment=$6,provider_idempotency_commitment=$7,
         state='planned',phase='planned',version=version+1,updated_at=now()
       WHERE id=$1 AND state='reserved' AND program_digest IS NULL RETURNING id`,
      [
        input.id,
        input.programDigest,
        input.dispatchSemantics ?? "mutation",
        JSON.stringify(input.safeOutputManifest),
        input.syntheticInputSetCommitment ?? null,
        input.payloadCommitment ?? null,
        input.providerIdempotencyCommitment ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_PROGRAM_ALREADY_BOUND");
    await this.appendTransition(input.id, "reserved", "planned", "planned", 0);
  }

  /** Historical/import fixtures only. Legacy rows cannot acquire new dispatch authority. */
  async create(input: CreateProtectedOperationInput) {
    const result = await this.database.query<OperationRow>(
      `INSERT INTO protected_operations(
         operation_id,mutation_identity,owner_kind,authoring_session_id,run_id,project_id,
         environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,flow_revision_id,
         authorization_id,program_digest,dispatch_semantics,state,phase,safe_output_manifest
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'planned','planned',$16::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",
         lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",
         mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences",
         dispatch_semantics AS "dispatchSemantics"`,
      [
        input.operationId,
        input.mutationIdentity,
        input.ownerKind,
        input.ownerKind === "authoring_session" ? input.ownerId : null,
        input.ownerKind === "run" ? input.ownerId : null,
        input.projectId,
        input.environmentId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.ownerKind === "authoring_session" ? input.flowDraftId : null,
        input.ownerKind === "run" ? input.flowRevisionId : null,
        input.authorizationId ?? null,
        input.programDigest,
        input.dispatchSemantics ?? "mutation",
        JSON.stringify(input.safeOutputManifest),
      ],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_ALREADY_EXISTS");
    await this.appendTransition(result.rows[0]!.id, null, "planned", "planned", 0);
    return normalize(result.rows[0]!);
  }

  async claim(input: {
    ownerKind: ProtectedOperationOwnerKind;
    ownerId: string;
    operationId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    binding: ProtectedOperationBinding;
  }) {
    return this.database.transaction(async (client) => {
      const result = await client.query<OperationRow>(
        `SELECT id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",
           lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",
           mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences",
           mutation_identity AS "mutationIdentity",dispatch_semantics AS "dispatchSemantics",program_digest AS "programDigest",
           safe_output_manifest AS "safeOutputManifest",project_id AS "projectId",
           environment_id AS "environmentId",mission_id AS "missionId",objective_id AS "objectiveId",
           agent_session_id AS "agentSessionId",flow_draft_id AS "flowDraftId",
           flow_revision_id AS "flowRevisionId",authorization_id AS "authorizationId"
           ,authority_model AS "authorityModel",
           prepared_execution_capability_id AS "preparedExecutionCapabilityId"
         FROM protected_operations WHERE owner_kind=$1 AND operation_id=$3
           AND (($1='authoring_session' AND authoring_session_id=$2) OR ($1='run' AND run_id=$2)) FOR UPDATE`,
        [input.ownerKind, input.ownerId, input.operationId],
      );
      if (!result.rowCount) throw new NotFoundException("PROTECTED_OPERATION_NOT_FOUND");
      const current = result.rows[0]!;
      if (current.authorityModel !== "canonical" && current.dispatchState === "not_started")
        throw new ConflictException("LEGACY_PROTECTED_OPERATION_DISPATCH_FORBIDDEN");
      if (!bindingMatches(current, input.binding))
        throw new ConflictException("PROTECTED_OPERATION_BINDING_MISMATCH");
      if (current.authorityModel === "canonical") {
        if (
          !input.binding.preparedExecutionCapabilityId ||
          input.binding.preparedExecutionCapabilityId !== current.preparedExecutionCapabilityId
        )
          throw new ConflictException("PREPARED_EXECUTION_CAPABILITY_REQUIRED");
        const authority = await client.query(
          `SELECT 1 FROM prepared_execution_capabilities
           WHERE id=$1 AND protected_operation_id=$2 AND state='finalized'
             AND program_digest=$3 AND mutation_identity=$4
             AND expires_at>now()`,
          [
            input.binding.preparedExecutionCapabilityId,
            current.id,
            input.binding.programDigest,
            input.binding.mutationIdentity,
          ],
        );
        if (!authority.rowCount)
          throw new ConflictException("PREPARED_EXECUTION_CAPABILITY_INVALID");
      }
      if (input.ownerKind === "run" && current.authorityModel !== "canonical") {
        const authorization = await client.query(
          `SELECT 1 FROM mission_authorizations
           WHERE id=$1 AND mission_id=$2 AND objective_id=$3 AND environment_id=$4
             AND kind='protected_mutation' AND operation_id=$5 AND status='approved'
             AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
          [
            current.authorizationId,
            current.missionId,
            current.objectiveId,
            current.environmentId,
            input.operationId,
          ],
        );
        if (!authorization.rowCount)
          throw new ConflictException("PROTECTED_OPERATION_AUTHORIZATION_INVALID");
      }
      const leaseLive = current.leaseExpiresAt && current.leaseExpiresAt.getTime() > Date.now();
      if (leaseLive && current.leaseOwner !== input.leaseOwner)
        throw new ConflictException("PROTECTED_OPERATION_LEASE_HELD");
      if (leaseLive && current.leaseOwner === input.leaseOwner) return normalize(current);
      let state = current.state;
      if (!leaseLive)
        state = protectedOperationLeaseExpiryState(state, current.dispatchSemantics ?? "mutation");
      const claimed = await client.query<OperationRow>(
        `UPDATE protected_operations SET state=$2,phase=CASE WHEN $2='recovery_required' THEN 'lease_expired' ELSE phase END,
           version=version+1,fencing_token=fencing_token+1,lease_owner=$3,
           lease_expires_at=now()+($4::text||' milliseconds')::interval,
           mutation_outcome=CASE
             WHEN mutation_outcome IN ('applied','not_applied') THEN mutation_outcome
             WHEN $2='failed_not_applied' THEN 'not_applied'
             WHEN $5::boolean AND mutation_outcome NOT IN ('applied','not_applied') THEN 'unknown'
             ELSE mutation_outcome
           END,
           failure_code=CASE WHEN $2 IN ('recovery_required','failed_not_applied') THEN 'PROTECTED_OPERATION_LEASE_EXPIRED' ELSE failure_code END,
           recovery_class=CASE WHEN $2='recovery_required' THEN 'reconciliation_required' WHEN $2='failed_not_applied' THEN 'safe_to_retry' ELSE recovery_class END,
           updated_at=now() WHERE id=$1
         RETURNING id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",
           lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",
           mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences"`,
        [
          current.id,
          state,
          input.leaseOwner,
          input.leaseDurationMs,
          state === "recovery_required" &&
            [
              "dispatching",
              "dispatched",
              "acquiring",
              "persisting",
              "persisted",
              "reconciling",
            ].includes(current.state),
        ],
      );
      if (state === "failed_not_applied") {
        await client.query(
          `DELETE FROM protected_response_output_staging WHERE protected_operation_id=$1`,
          [current.id],
        );
        await destroyOperationBoundInputs(client, current.id);
      }
      if (state !== current.state)
        await appendTransition(
          client,
          current.id,
          current.state,
          state,
          "lease_expired",
          Number(claimed.rows[0]!.fencingToken),
          "PROTECTED_OPERATION_LEASE_EXPIRED",
        );
      return normalize(claimed.rows[0]!);
    });
  }

  async heartbeat(input: {
    id: string;
    leaseOwner: string;
    fencingToken: number;
    leaseDurationMs: number;
  }) {
    const result = await this.database.query(
      `UPDATE protected_operations SET lease_expires_at=now()+($4::text||' milliseconds')::interval,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>now() AND completed_at IS NULL RETURNING id`,
      [input.id, input.leaseOwner, input.fencingToken, input.leaseDurationMs],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_FENCED");
  }

  async transition(input: {
    id: string;
    leaseOwner: string;
    fencingToken: number;
    version: number;
    expected: ProtectedOperationState;
    next: ProtectedOperationState;
    phase: string;
    reasonCode?: string;
    safeDiagnostics?: Record<string, unknown>;
  }) {
    assertProtectedOperationTransition(input.expected, input.next);
    return this.database.transaction(async (client) => {
      if (
        input.next === "failed_not_applied" &&
        [
          "dispatching",
          "dispatched",
          "acquiring",
          "persisting",
          "persisted",
          "reconciling",
        ].includes(input.expected)
      ) {
        const semantics = await client.query<{
          dispatchSemantics: string;
          mutationOutcome: string;
        }>(
          `SELECT dispatch_semantics AS "dispatchSemantics",mutation_outcome AS "mutationOutcome" FROM protected_operations
           WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND version=$4 AND state=$5 FOR UPDATE`,
          [input.id, input.leaseOwner, input.fencingToken, input.version, input.expected],
        );
        if (semantics.rows[0]?.mutationOutcome === "applied")
          throw new ConflictException("PROTECTED_MUTATION_OUTCOME_CONTRADICTION");
        if (
          semantics.rows[0]?.dispatchSemantics !== "read_only" &&
          semantics.rows[0]?.mutationOutcome !== "not_applied"
        )
          throw new ConflictException(
            "PROTECTED_MUTATION_CANNOT_SETTLE_NOT_APPLIED_AFTER_DISPATCH",
          );
      }
      const dispatchState = protectedOperationDispatchMayBegin(input.expected, input.next)
        ? "started"
        : input.next === "dispatched"
          ? "acknowledged"
          : null;
      const mutationOutcome =
        input.next === "completed"
          ? "applied"
          : input.next === "failed_not_applied"
            ? "not_applied"
            : input.next === "recovery_required" &&
                [
                  "dispatching",
                  "dispatched",
                  "acquiring",
                  "persisting",
                  "persisted",
                  "reconciling",
                ].includes(input.expected)
              ? "unknown"
              : null;
      const result = await client.query<OperationRow>(
        `UPDATE protected_operations SET state=$6,phase=$7,version=version+1,
           dispatch_state=COALESCE($8,dispatch_state),
           mutation_outcome=CASE
             WHEN $9::text IS NULL THEN mutation_outcome
             WHEN mutation_outcome IN ('applied','not_applied') THEN mutation_outcome
             ELSE $9::text
           END,
           failure_code=COALESCE($10,failure_code),safe_diagnostics=COALESCE($11::jsonb,safe_diagnostics),
           recovery_class=CASE WHEN $6='recovery_required' THEN 'reconciliation_required' ELSE recovery_class END,
           completed_at=CASE WHEN $6=ANY($12::text[]) THEN now() ELSE completed_at END,
           lease_owner=CASE WHEN $6=ANY($13::text[]) THEN NULL ELSE lease_owner END,
           lease_expires_at=CASE WHEN $6=ANY($13::text[]) THEN NULL ELSE lease_expires_at END,
           updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND version=$4 AND state=$5 AND lease_expires_at>now()
         RETURNING id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",
           lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",
           mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences"`,
        [
          input.id,
          input.leaseOwner,
          input.fencingToken,
          input.version,
          input.expected,
          input.next,
          input.phase,
          dispatchState,
          mutationOutcome,
          input.reasonCode ?? null,
          input.safeDiagnostics ? JSON.stringify(input.safeDiagnostics) : null,
          [...protectedOperationTerminalStates],
          [...protectedOperationTerminalStates, "recovery_required", "compromised"],
        ],
      );
      if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_TRANSITION_FENCED");
      if (input.next === "failed_not_applied") {
        await client.query(
          `DELETE FROM protected_response_output_staging WHERE protected_operation_id=$1`,
          [input.id],
        );
      }
      if (protectedOperationTerminalStates.has(input.next)) {
        await destroyOperationBoundInputs(client, input.id);
      }
      await appendTransition(
        client,
        input.id,
        input.expected,
        input.next,
        input.phase,
        input.fencingToken,
        input.reasonCode,
        input.safeDiagnostics,
      );
      return normalize(result.rows[0]!);
    });
  }

  async settleMutationOutcome(input: {
    id: string;
    leaseOwner: string;
    fencingToken: number;
    version: number;
    outcome: "applied" | "not_applied";
  }) {
    const result = await this.database.query<OperationRow>(
      `UPDATE protected_operations
          SET mutation_outcome=CASE
                WHEN mutation_outcome IN ('applied','not_applied') THEN mutation_outcome
                ELSE $5
              END,
              version=version+1,
              updated_at=now()
        WHERE id=$1
          AND lease_owner=$2
          AND fencing_token=$3
          AND version=$4
          AND lease_expires_at>now()
          AND state IN ('dispatching','dispatched','acquiring','persisting','persisted','reconciling')
          AND (mutation_outcome NOT IN ('applied','not_applied') OR mutation_outcome=$5)
        RETURNING id,state,phase,version,fencing_token AS "fencingToken",
          lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt",
          dispatch_state AS "dispatchState",mutation_outcome AS "mutationOutcome",
          persisted_references AS "persistedReferences"`,
      [input.id, input.leaseOwner, input.fencingToken, input.version, input.outcome],
    );
    if (!result.rowCount)
      throw new ConflictException("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_FENCED");
    return normalize(result.rows[0]!);
  }

  async record(input: {
    id: string;
    leaseOwner: string;
    fencingToken: number;
    phase: string;
    safeDiagnostics?: Record<string, unknown>;
    durationMs?: number;
  }) {
    await this.database.transaction(async (client) => {
      const diagnostics = input.safeDiagnostics ?? {};
      const result = await client.query<{ id: string; state: ProtectedOperationState }>(
        `UPDATE protected_operations SET phase=$4::text,safe_diagnostics=$5::jsonb,
           dispatch_state=CASE
             WHEN $4='dispatch_authorized' AND dispatch_state='not_started' THEN 'authorized'
             ELSE dispatch_state
           END,
           phase_timings=CASE WHEN $6::double precision IS NULL THEN phase_timings
             ELSE phase_timings || jsonb_build_object($4::text,round($6::numeric,3)) END,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>now()
           AND completed_at IS NULL RETURNING id,state`,
        [
          input.id,
          input.leaseOwner,
          input.fencingToken,
          input.phase,
          JSON.stringify(diagnostics),
          input.durationMs ?? null,
        ],
      );
      if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_FENCED");
      const state = result.rows[0]!.state;
      const reasonCode =
        typeof diagnostics.reasonCode === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(diagnostics.reasonCode)
          ? diagnostics.reasonCode
          : undefined;
      await appendTransition(
        client,
        input.id,
        state,
        state,
        input.phase,
        input.fencingToken,
        reasonCode,
        diagnostics,
      );
    });
  }

  async getMutationReceiptByAuthoringOperation(
    authoringSessionId: string,
    operationId: string,
  ): Promise<MutationReceipt | undefined> {
    const operations = await this.database.query<ReceiptOperationRow>(
      `${receiptOperationSelect}
       WHERE operation.owner_kind='authoring_session'
         AND operation.authoring_session_id=$1 AND operation.operation_id=$2`,
      [authoringSessionId, operationId],
    );
    return (await this.projectReceipts(operations.rows))[0];
  }

  async listMutationReceiptsForRun(runId: string): Promise<MutationReceipt[]> {
    return this.listMutationReceiptsForRuns([runId]);
  }

  async listMutationReceiptsForRuns(runIds: readonly string[]): Promise<MutationReceipt[]> {
    if (!runIds.length) return [];

    const operations = await this.database.query<ReceiptOperationRow>(
      `${receiptOperationSelect}
       WHERE operation.run_id=ANY($1::uuid[]) OR operation.id IN (
         SELECT protected.id
           FROM protected_operations protected
           JOIN run_operation_links link
             ON link.praxis_session_id=protected.authoring_session_id
            AND link.operation_id=protected.operation_id
          WHERE link.run_id=ANY($1::uuid[])
       )
       ORDER BY operation.created_at,operation.id`,
      [runIds],
    );
    return this.projectReceipts(operations.rows);
  }

  private async projectReceipts(rows: ReceiptOperationRow[]): Promise<MutationReceipt[]> {
    if (!rows.length) return [];
    const ids = rows.map(({ receiptId }) => receiptId);
    const [transitions, identities] = await Promise.all([
      this.database.query<{
        protectedOperationId: string;
        sequence: string;
        fromState: ProtectedOperationState | null;
        toState: ProtectedOperationState;
        phase: string;
        reasonCode: string | null;
        safeDiagnostics: Record<string, unknown>;
        occurredAt: Date;
      }>(
        `SELECT protected_operation_id AS "protectedOperationId",sequence,
                from_state AS "fromState",to_state AS "toState",phase,
                reason_code AS "reasonCode",safe_diagnostics AS "safeDiagnostics",
                occurred_at AS "occurredAt"
           FROM protected_operation_transitions
          WHERE protected_operation_id=ANY($1::uuid[])
          ORDER BY protected_operation_id,sequence`,
        [ids],
      ),
      this.database.query<{
        protectedOperationId: string;
        bindingId: string;
        publicValueId: string | null;
        provider: string;
        resourceKind: string;
        resourceScope: string;
        identityContractVersion: number;
        identitySource: "response" | null;
        lifecycleState: "active" | "unavailable" | "invalidated" | "desynchronized";
      }>(
        `SELECT source_protected_operation_id AS "protectedOperationId",id AS "bindingId",
                generated_public_value_id AS "publicValueId",provider,
                resource_kind AS "resourceKind",resource_scope AS "resourceScope",
                identity_contract_version AS "identityContractVersion",
                identity_source AS "identitySource",lifecycle_state AS "lifecycleState"
           FROM external_resource_bindings
          WHERE source_protected_operation_id=ANY($1::uuid[])
          ORDER BY source_protected_operation_id,created_at,id`,
        [ids],
      ),
    ]);
    return rows.map(({ runId, praxisSessionId, ...row }) =>
      projectMutationReceipt({
        ...row,
        ...(runId ? { runId } : {}),
        ...(praxisSessionId ? { praxisSessionId } : {}),
        transitions: transitions.rows
          .filter(({ protectedOperationId }) => protectedOperationId === row.receiptId)
          .map(({ sequence, occurredAt, ...transition }) => ({
            ...transition,
            sequence: Number(sequence),
            occurredAt: occurredAt.toISOString(),
          })),
        responseIdentities: identities.rows.filter(
          ({ protectedOperationId }) => protectedOperationId === row.receiptId,
        ),
      }),
    );
  }

  private appendTransition(
    id: string,
    from: ProtectedOperationState | null,
    to: ProtectedOperationState,
    phase: string,
    fencingToken: number,
  ) {
    return this.database.transaction((client) =>
      appendTransition(client, id, from, to, phase, fencingToken),
    );
  }
}

const receiptOperationSelect = `SELECT operation.id AS "receiptId",operation.operation_id AS "operationId",
  operation.owner_kind AS "ownerKind",
  CASE WHEN operation.owner_kind='authoring_session' THEN operation.authoring_session_id ELSE operation.run_id END AS "ownerId",
  operation.project_id AS "projectId",operation.environment_id AS "environmentId",
  operation.mission_id AS "missionId",operation.objective_id AS "objectiveId",
  operation.agent_session_id AS "agentSessionId",
  COALESCE(operation.run_id,linked_run.run_id) AS "runId",
  CASE WHEN operation.owner_kind='authoring_session' THEN operation.authoring_session_id
       ELSE live_session.praxis_session_id END AS "praxisSessionId",
  operation.dispatch_semantics AS "dispatchSemantics",operation.program_digest AS "programDigest",
  operation.authority_model AS "authorityModel",
  operation.synthetic_input_set_commitment AS "syntheticInputSetCommitment",
  operation.payload_commitment AS "payloadCommitment",
  operation.provider_idempotency_commitment AS "providerIdempotencyCommitment",
  operation.state,operation.dispatch_state AS "dispatchState",
  operation.mutation_outcome AS "mutationOutcome",
  operation.persistence_state AS "persistenceState",
  operation.persisted_references AS "persistedReferences",
  operation.failure_code AS "failureCode"
 FROM protected_operations operation
 LEFT JOIN LATERAL (
   SELECT link.run_id
     FROM run_operation_links link
    WHERE operation.owner_kind='authoring_session'
      AND link.praxis_session_id=operation.authoring_session_id
      AND link.operation_id=operation.operation_id
    ORDER BY link.created_at DESC,link.run_id LIMIT 1
 ) linked_run ON operation.owner_kind='authoring_session'
 LEFT JOIN LATERAL (
   SELECT binding.praxis_session_id
     FROM run_praxis_sessions binding
    WHERE binding.run_id=operation.run_id
    ORDER BY binding.epoch DESC LIMIT 1
 ) live_session ON operation.owner_kind='run'`;

async function destroyOperationBoundInputs(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  protectedOperationId: string,
) {
  await client.query(
    `UPDATE operation_bound_protected_inputs
        SET ciphertext=NULL,initialization_vector=NULL,authentication_tag=NULL,
            lifecycle='destroyed',destroyed_at=now()
      WHERE protected_operation_id=$1 AND lifecycle='active'`,
    [protectedOperationId],
  );
}

async function appendTransition(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  id: string,
  from: ProtectedOperationState | null,
  to: ProtectedOperationState,
  phase: string,
  fencingToken: number,
  reasonCode?: string,
  diagnostics?: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO protected_operation_transitions(protected_operation_id,sequence,from_state,to_state,phase,fencing_token,reason_code,safe_diagnostics)
     SELECT $1,COALESCE(max(sequence),0)+1,$2,$3,$4,$5,$6,$7::jsonb FROM protected_operation_transitions WHERE protected_operation_id=$1`,
    [id, from, to, phase, fencingToken, reasonCode ?? null, JSON.stringify(diagnostics ?? {})],
  );
}

function normalize(row: OperationRow) {
  return { ...row, version: Number(row.version), fencingToken: Number(row.fencingToken) };
}

function bindingMatches(row: OperationRow, binding: ProtectedOperationBinding) {
  const manifest = (values: CreateProtectedOperationInput["safeOutputManifest"]) =>
    values
      .map((value) => ({
        reference: value.reference,
        classification: value.classification,
        storageName: value.storageName,
      }))
      .sort((a, b) => a.reference.localeCompare(b.reference));
  return (
    row.mutationIdentity === binding.mutationIdentity &&
    row.dispatchSemantics === (binding.dispatchSemantics ?? "mutation") &&
    row.programDigest === binding.programDigest &&
    JSON.stringify(manifest(row.safeOutputManifest)) ===
      JSON.stringify(manifest(binding.safeOutputManifest)) &&
    row.projectId === binding.projectId &&
    row.environmentId === binding.environmentId &&
    row.missionId === binding.missionId &&
    row.objectiveId === binding.objectiveId &&
    row.agentSessionId === binding.agentSessionId &&
    row.flowDraftId === ("flowDraftId" in binding ? binding.flowDraftId : null) &&
    row.flowRevisionId === ("flowRevisionId" in binding ? binding.flowRevisionId : null) &&
    row.authorizationId === (binding.authorizationId ?? null)
  );
}
