import { ConflictException } from "@nestjs/common";

import { Database } from "./database.js";

export class ProtectedTransactionRepository {
  constructor(private readonly database: Database) {}

  async claimProtectedTransaction(
    runId: string,
    workerLeaseId: string,
    input: {
      operationId: string;
      mutationKind: "one_time" | "repeatable";
      programDigest: string;
      inputSchemaDigest: string;
      inputDigest: string;
    },
  ) {
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO protected_transactions(run_id, operation_id, lifecycle_state, mutation_kind,program_digest,input_schema_digest,input_digest)
         VALUES ($1,$2,'planned',$3,$4,$5,$6) ON CONFLICT (run_id, operation_id) DO NOTHING`,
        [
          runId,
          input.operationId,
          input.mutationKind,
          input.programDigest,
          input.inputSchemaDigest,
          input.inputDigest,
        ],
      );
      await client.query(
        `INSERT INTO protected_mutation_ledger(run_id, operation_id, state, fencing_token) VALUES ($1,$2,'planned',0) ON CONFLICT DO NOTHING`,
        [runId, input.operationId],
      );
      const result = await client.query(
        `UPDATE protected_mutation_ledger SET fencing_token=fencing_token+1, worker_lease_id=$3,
           lease_expires_at=now()+interval '30 seconds', updated_at=now()
         WHERE run_id=$1 AND operation_id=$2
         RETURNING state, fencing_token AS "fencingToken"`,
        [runId, input.operationId, workerLeaseId],
      );
      if (!result.rowCount) throw new Error("PROTECTED_TRANSACTION_LEDGER_MISSING");
      await client.query(
        `UPDATE protected_transactions SET fencing_token=$3, worker_lease_id=$4, lease_expires_at=now()+interval '30 seconds', updated_at=now() WHERE run_id=$1 AND operation_id=$2`,
        [runId, input.operationId, result.rows[0]!.fencingToken, workerLeaseId],
      );
      return {
        state: String(result.rows[0]!.state),
        fencingToken: Number(result.rows[0]!.fencingToken),
      };
    });
  }

  async transitionProtectedMutation(
    runId: string,
    workerLeaseId: string,
    input: { operationId: string; fencingToken: number; expected: string; next: string },
  ) {
    const result = await this.database.query(
      `UPDATE protected_mutation_ledger SET state=$6, updated_at=now(),
         invocation_started_at=CASE WHEN $6='dispatching' THEN COALESCE(invocation_started_at,now()) ELSE invocation_started_at END,
         invocation_acknowledged_at=CASE WHEN $6='acknowledged' THEN COALESCE(invocation_acknowledged_at,now()) ELSE invocation_acknowledged_at END
       WHERE run_id=$1 AND operation_id=$2 AND worker_lease_id=$3 AND fencing_token=$4 AND state=$5 AND lease_expires_at>now() RETURNING state`,
      [runId, input.operationId, workerLeaseId, input.fencingToken, input.expected, input.next],
    );
    return Boolean(result.rowCount);
  }

  async recordProtectedTransaction(
    runId: string,
    workerLeaseId: string,
    input: {
      operationId: string;
      fencingToken: number;
      phase: string;
      facts?: Record<string, unknown>;
    },
  ) {
    const lifecycle: Record<string, string> = {
      acquisition_readiness_validating: "acquisition_readiness_validating",
      acquisition_ready: "acquisition_ready",
      safe_context_parking: "safe_context_parking",
      capsule_bootstrapping: "capsule_bootstrapping",
      capsule_ready: "capsule_ready",
      preparation_running: "preparation_running",
      preparation_verified: "preparation_verified",
      dispatch_authorized: "dispatch_authorized",
      mutation_dispatching: "mutation_dispatching",
      acquisition_running: "acquisition_running",
      acquisition_unresolved: "acquisition_unresolved",
      recovery_window: "recovery_window",
      secure_assistance: "secure_assistance",
      credential_revoked: "credential_revoked",
      credential_abandoned: "credential_abandoned",
      recovery_expired: "recovery_expired",
      evidence_resumed: "evidence_resumed",
      completed: "evidence_resumed",
      terminal: "terminal",
      continuing_unrecorded: "continuing_unrecorded",
      aborted: "aborted",
      outcome_unknown: "aborted",
      replay_rejected: "aborted",
    };
    const facts = input.facts ?? {};
    const bootstrap =
      facts.bootstrap && typeof facts.bootstrap === "object"
        ? (facts.bootstrap as Record<string, unknown>).status
        : facts.bootstrap;
    const preparation =
      facts.preparation && typeof facts.preparation === "object"
        ? (facts.preparation as Record<string, unknown>).status
        : facts.preparation;
    const mutation =
      facts.mutation && typeof facts.mutation === "object"
        ? (facts.mutation as Record<string, unknown>)
        : {};
    const result = await this.database.query(
      `UPDATE protected_transactions SET lifecycle_state=COALESCE($5,lifecycle_state),
         bootstrap_status=COALESCE($6,bootstrap_status),preparation_status=COALESCE($7,preparation_status),
         mutation_dispatch_status=COALESCE($8,mutation_dispatch_status),mutation_outcome_status=COALESCE($9,mutation_outcome_status),
         protected_extraction_status=COALESCE($10,protected_extraction_status),public_extraction_status=COALESCE($11,public_extraction_status),
         protected_persistence_status=COALESCE($12,protected_persistence_status),public_persistence_status=COALESCE($13,public_persistence_status),
         capsule_status=COALESCE($14,capsule_status), reconciliation_status=COALESCE($15,reconciliation_status),
         continuation_status=COALESCE($16,continuation_status), evidence_status=COALESCE($17,evidence_status),
         credential_security_status=COALESCE($18,credential_security_status), reason_code=COALESCE($19,reason_code),
         failure_phase=COALESCE($20,failure_phase),retry_class=COALESCE($21,retry_class),
         acquisition_contract_digest=COALESCE($22,acquisition_contract_digest),recovery_expires_at=COALESCE($23::timestamptz,recovery_expires_at),updated_at=now()
       WHERE run_id=$1 AND operation_id=$2 AND worker_lease_id=$3 AND fencing_token=$4 AND lease_expires_at>now() RETURNING operation_id`,
      [
        runId,
        input.operationId,
        workerLeaseId,
        input.fencingToken,
        lifecycle[input.phase] ?? null,
        bootstrap ?? null,
        preparation ?? null,
        mutation.dispatch ?? null,
        mutation.outcome ?? null,
        facts.protectedExtraction ?? null,
        facts.publicExtraction ?? null,
        facts.protectedPersistence ?? null,
        facts.publicPersistence ?? null,
        facts.capsule ?? null,
        facts.reconciliation ?? null,
        facts.continuation ?? null,
        facts.evidence ?? null,
        facts.credentialSecurity ?? null,
        facts.reasonCode ?? null,
        facts.failurePhase ?? null,
        facts.retryClass ?? null,
        facts.acquisitionContractDigest ?? null,
        facts.recoveryExpiresAt ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_TRANSACTION_FENCED");
  }

  async protectedRecoveryDecision(runId: string, operationId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        resolution: { action?: string; correctedScope?: import("@scry/contracts").SemanticScope };
      }>(
        `SELECT recovery_resolution resolution FROM protected_transactions WHERE run_id=$1 AND operation_id=$2 FOR UPDATE`,
        [runId, operationId],
      );
      const resolution = result.rows[0]?.resolution;
      const action = resolution?.action;
      if (!action) return undefined;
      await client.query(
        `UPDATE protected_transactions SET recovery_resolution='{}'::jsonb,updated_at=now() WHERE run_id=$1 AND operation_id=$2`,
        [runId, operationId],
      );
      return {
        action,
        ...(resolution.correctedScope ? { correctedScope: resolution.correctedScope } : {}),
      };
    });
  }
}
