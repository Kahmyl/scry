import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  assertProtectedOperationTransition,
  protectedOperationDispatchMayBegin,
  protectedOperationLeaseExpiryState,
  protectedOperationTerminalStates,
  type ProtectedOperationOwnerKind,
  type ProtectedOperationState,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

type Owner =
  | { ownerKind: "authoring_session"; ownerId: string; flowDraftId: string; authorizationId: string }
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
  safeOutputManifest: Array<{ reference: string; classification: "public" | "protected"; storageName: string }>;
};

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
  persistedReferences: Record<string, { classification: "public" | "protected"; credentialId?: string; valueId?: string; scope: "run" | "project" }>;
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
};

@Injectable()
export class ProtectedOperationRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

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
        input.operationId, input.mutationIdentity, input.ownerKind,
        input.ownerKind === "authoring_session" ? input.ownerId : null,
        input.ownerKind === "run" ? input.ownerId : null,
        input.projectId, input.environmentId, input.missionId, input.objectiveId,
        input.agentSessionId,
        input.ownerKind === "authoring_session" ? input.flowDraftId : null,
        input.ownerKind === "run" ? input.flowRevisionId : null,
        input.authorizationId ?? null, input.programDigest, input.dispatchSemantics ?? "mutation",
        JSON.stringify(input.safeOutputManifest),
      ],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_ALREADY_EXISTS");
    await this.appendTransition(result.rows[0]!.id, null, "planned", "planned", 0);
    return normalize(result.rows[0]!);
  }

  async claim(input: { ownerKind: ProtectedOperationOwnerKind; ownerId: string; operationId: string; leaseOwner: string; leaseDurationMs: number; binding: ProtectedOperationBinding }) {
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
         FROM protected_operations WHERE owner_kind=$1 AND operation_id=$3
           AND (($1='authoring_session' AND authoring_session_id=$2) OR ($1='run' AND run_id=$2)) FOR UPDATE`,
        [input.ownerKind, input.ownerId, input.operationId],
      );
      if (!result.rowCount) throw new NotFoundException("PROTECTED_OPERATION_NOT_FOUND");
      const current = result.rows[0]!;
      if (!bindingMatches(current, input.binding))
        throw new ConflictException("PROTECTED_OPERATION_BINDING_MISMATCH");
      const leaseLive = current.leaseExpiresAt && current.leaseExpiresAt.getTime() > Date.now();
      if (leaseLive && current.leaseOwner !== input.leaseOwner)
        throw new ConflictException("PROTECTED_OPERATION_LEASE_HELD");
      if (leaseLive && current.leaseOwner === input.leaseOwner) return normalize(current);
      let state = current.state;
      if (!leaseLive) state = protectedOperationLeaseExpiryState(
        state,
        current.dispatchSemantics ?? "mutation",
      );
      const claimed = await client.query<OperationRow>(
        `UPDATE protected_operations SET state=$2,phase=CASE WHEN $2='recovery_required' THEN 'lease_expired' ELSE phase END,
           version=version+1,fencing_token=fencing_token+1,lease_owner=$3,
           lease_expires_at=now()+($4::text||' milliseconds')::interval,
           mutation_outcome=CASE WHEN $2='failed_not_applied' THEN 'not_applied' WHEN $5::boolean THEN 'unknown' ELSE mutation_outcome END,
           failure_code=CASE WHEN $2 IN ('recovery_required','failed_not_applied') THEN 'PROTECTED_OPERATION_LEASE_EXPIRED' ELSE failure_code END,
           recovery_class=CASE WHEN $2='recovery_required' THEN 'reconciliation_required' WHEN $2='failed_not_applied' THEN 'safe_to_retry' ELSE recovery_class END,
           updated_at=now() WHERE id=$1
         RETURNING id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",
           lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",
           mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences"`,
        [current.id, state, input.leaseOwner, input.leaseDurationMs,
          state === "recovery_required" && ["dispatching","dispatched","acquiring","persisting","persisted","reconciling"].includes(current.state)],
      );
      if (state !== current.state) await appendTransition(client, current.id, current.state, state, "lease_expired", Number(claimed.rows[0]!.fencingToken), "PROTECTED_OPERATION_LEASE_EXPIRED");
      return normalize(claimed.rows[0]!);
    });
  }

  async heartbeat(input: { id: string; leaseOwner: string; fencingToken: number; leaseDurationMs: number }) {
    const result = await this.database.query(
      `UPDATE protected_operations SET lease_expires_at=now()+($4::text||' milliseconds')::interval,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>now() AND completed_at IS NULL RETURNING id`,
      [input.id, input.leaseOwner, input.fencingToken, input.leaseDurationMs],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_FENCED");
  }

  async transition(input: {
    id: string; leaseOwner: string; fencingToken: number; version: number;
    expected: ProtectedOperationState; next: ProtectedOperationState; phase: string;
    reasonCode?: string; safeDiagnostics?: Record<string, unknown>;
  }) {
    assertProtectedOperationTransition(input.expected, input.next);
    return this.database.transaction(async (client) => {
      if (input.next === "failed_not_applied" && ["dispatching", "dispatched", "acquiring", "persisting", "persisted", "reconciling"].includes(input.expected)) {
        const semantics = await client.query<{ dispatchSemantics: string }>(
          `SELECT dispatch_semantics AS "dispatchSemantics" FROM protected_operations
           WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND version=$4 AND state=$5 FOR UPDATE`,
          [input.id,input.leaseOwner,input.fencingToken,input.version,input.expected],
        );
        if (semantics.rows[0]?.dispatchSemantics !== "read_only")
          throw new ConflictException("PROTECTED_MUTATION_CANNOT_SETTLE_NOT_APPLIED_AFTER_DISPATCH");
      }
      const dispatchState = protectedOperationDispatchMayBegin(input.expected, input.next)
        ? "started"
        : input.next === "dispatched" ? "acknowledged" : null;
      const mutationOutcome = input.next === "completed" ? "applied"
        : input.next === "failed_not_applied" ? "not_applied"
          : input.next === "recovery_required" && ["dispatching", "dispatched", "acquiring", "persisting", "persisted", "reconciling"].includes(input.expected)
            ? "unknown" : null;
      const result = await client.query<OperationRow>(
        `UPDATE protected_operations SET state=$6,phase=$7,version=version+1,
           dispatch_state=COALESCE($8,dispatch_state),mutation_outcome=COALESCE($9,mutation_outcome),
           failure_code=COALESCE($10,failure_code),safe_diagnostics=COALESCE($11::jsonb,safe_diagnostics),
           recovery_class=CASE WHEN $6='recovery_required' THEN 'reconciliation_required' ELSE recovery_class END,
           completed_at=CASE WHEN $6=ANY($12::text[]) THEN now() ELSE completed_at END,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND version=$4 AND state=$5 AND lease_expires_at>now()
         RETURNING id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",
           lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",
           mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences"`,
        [input.id,input.leaseOwner,input.fencingToken,input.version,input.expected,input.next,input.phase,
          dispatchState,mutationOutcome,input.reasonCode ?? null,input.safeDiagnostics ? JSON.stringify(input.safeDiagnostics) : null,
          [...protectedOperationTerminalStates]],
      );
      if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_TRANSITION_FENCED");
      await appendTransition(client,input.id,input.expected,input.next,input.phase,input.fencingToken,input.reasonCode,input.safeDiagnostics);
      return normalize(result.rows[0]!);
    });
  }

  async record(input: {
    id: string;
    leaseOwner: string;
    fencingToken: number;
    phase: string;
    safeDiagnostics?: Record<string, unknown>;
    durationMs?: number;
  }) {
    const result = await this.database.query(
      `UPDATE protected_operations SET phase=$4::text,safe_diagnostics=$5::jsonb,
         phase_timings=CASE WHEN $6::double precision IS NULL THEN phase_timings
           ELSE phase_timings || jsonb_build_object($4::text,round($6::numeric,3)) END,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND fencing_token=$3 AND lease_expires_at>now()
         AND completed_at IS NULL RETURNING id`,
      [input.id,input.leaseOwner,input.fencingToken,input.phase,JSON.stringify(input.safeDiagnostics ?? {}),input.durationMs ?? null],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_OPERATION_FENCED");
  }

  private appendTransition(id: string, from: ProtectedOperationState | null, to: ProtectedOperationState, phase: string, fencingToken: number) {
    return this.database.transaction((client) => appendTransition(client,id,from,to,phase,fencingToken));
  }
}

async function appendTransition(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, id: string, from: ProtectedOperationState | null, to: ProtectedOperationState, phase: string, fencingToken: number, reasonCode?: string, diagnostics?: Record<string, unknown>) {
  await client.query(
    `INSERT INTO protected_operation_transitions(protected_operation_id,sequence,from_state,to_state,phase,fencing_token,reason_code,safe_diagnostics)
     SELECT $1,COALESCE(max(sequence),0)+1,$2,$3,$4,$5,$6,$7::jsonb FROM protected_operation_transitions WHERE protected_operation_id=$1`,
    [id,from,to,phase,fencingToken,reasonCode ?? null,JSON.stringify(diagnostics ?? {})],
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
  return row.mutationIdentity === binding.mutationIdentity
    && row.dispatchSemantics === (binding.dispatchSemantics ?? "mutation")
    && row.programDigest === binding.programDigest
    && JSON.stringify(manifest(row.safeOutputManifest)) === JSON.stringify(manifest(binding.safeOutputManifest))
    && row.projectId === binding.projectId
    && row.environmentId === binding.environmentId
    && row.missionId === binding.missionId
    && row.objectiveId === binding.objectiveId
    && row.agentSessionId === binding.agentSessionId
    && row.flowDraftId === ("flowDraftId" in binding ? binding.flowDraftId : null)
    && row.flowRevisionId === ("flowRevisionId" in binding ? binding.flowRevisionId : null)
    && row.authorizationId === (binding.authorizationId ?? null);
}
