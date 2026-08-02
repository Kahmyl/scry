import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Artifact, OutcomeClassification, RecordingTimelineEntry, RunEvent, RunState } from "@scry/contracts";

import { Database } from "./database.js";
import { decryptCredential } from "./credential.crypto.js";
import { encryptCredential } from "./credential.crypto.js";

@Injectable()
export class ExecutionRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async heartbeatWorker(workerId: string, releaseId: string, schemaFingerprint: string) {
    await this.database.query(
      `INSERT INTO worker_heartbeats(worker_id, release_id, schema_fingerprint, heartbeat_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (worker_id) DO UPDATE SET release_id = EXCLUDED.release_id,
         schema_fingerprint = EXCLUDED.schema_fingerprint, heartbeat_at = now()`,
      [workerId, releaseId, schemaFingerprint],
    );
  }

  setRunPhase(runId: string, phase: string) {
    return this.database.query(`UPDATE runs SET phase = $2, updated_at = now() WHERE id = $1`, [runId, phase]);
  }

  async claimProtectedTransaction(runId: string, workerLeaseId: string, input: { operationId: string; mutationKind: "one_time" | "repeatable"; programDigest: string; inputSchemaDigest: string; inputDigest: string }) {
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO protected_transactions(run_id, operation_id, lifecycle_state, mutation_kind,program_digest,input_schema_digest,input_digest)
         VALUES ($1,$2,'planned',$3,$4,$5,$6) ON CONFLICT (run_id, operation_id) DO NOTHING`, [runId, input.operationId, input.mutationKind, input.programDigest, input.inputSchemaDigest, input.inputDigest],
      );
      await client.query(`INSERT INTO protected_mutation_ledger(run_id, operation_id, state, fencing_token) VALUES ($1,$2,'planned',0) ON CONFLICT DO NOTHING`, [runId, input.operationId]);
      const result = await client.query(
        `UPDATE protected_mutation_ledger SET fencing_token=fencing_token+1, worker_lease_id=$3,
           lease_expires_at=now()+interval '30 seconds', updated_at=now()
         WHERE run_id=$1 AND operation_id=$2
         RETURNING state, fencing_token AS "fencingToken"`, [runId, input.operationId, workerLeaseId],
      );
      if (!result.rowCount) throw new Error("PROTECTED_TRANSACTION_LEDGER_MISSING");
      await client.query(`UPDATE protected_transactions SET fencing_token=$3, worker_lease_id=$4, lease_expires_at=now()+interval '30 seconds', updated_at=now() WHERE run_id=$1 AND operation_id=$2`, [runId, input.operationId, result.rows[0]!.fencingToken, workerLeaseId]);
      return { state: String(result.rows[0]!.state), fencingToken: Number(result.rows[0]!.fencingToken) };
    });
  }

  async transitionProtectedMutation(runId: string, workerLeaseId: string, input: { operationId: string; fencingToken: number; expected: string; next: string }) {
    const result = await this.database.query(
      `UPDATE protected_mutation_ledger SET state=$6, updated_at=now(),
         invocation_started_at=CASE WHEN $6='dispatching' THEN COALESCE(invocation_started_at,now()) ELSE invocation_started_at END,
         invocation_acknowledged_at=CASE WHEN $6='acknowledged' THEN COALESCE(invocation_acknowledged_at,now()) ELSE invocation_acknowledged_at END
       WHERE run_id=$1 AND operation_id=$2 AND worker_lease_id=$3 AND fencing_token=$4 AND state=$5 AND lease_expires_at>now() RETURNING state`,
      [runId, input.operationId, workerLeaseId, input.fencingToken, input.expected, input.next],
    );
    return Boolean(result.rowCount);
  }

  async recordProtectedTransaction(runId: string, workerLeaseId: string, input: { operationId: string; fencingToken: number; phase: string; facts?: Record<string, unknown> }) {
    const lifecycle: Record<string, string> = {
      acquisition_readiness_validating: "acquisition_readiness_validating", acquisition_ready: "acquisition_ready", safe_context_parking: "safe_context_parking", capsule_bootstrapping: "capsule_bootstrapping", capsule_ready: "capsule_ready", preparation_running: "preparation_running", preparation_verified: "preparation_verified", dispatch_authorized: "dispatch_authorized", mutation_dispatching: "mutation_dispatching", acquisition_running: "acquisition_running", acquisition_unresolved: "acquisition_unresolved", recovery_window: "recovery_window", secure_assistance: "secure_assistance", credential_revoked: "credential_revoked", credential_abandoned: "credential_abandoned", recovery_expired: "recovery_expired",
      evidence_resumed: "evidence_resumed", completed: "evidence_resumed", terminal: "terminal", continuing_unrecorded: "continuing_unrecorded", aborted: "aborted", outcome_unknown: "aborted", replay_rejected: "aborted",
    };
    const facts = input.facts ?? {};
    const bootstrap = facts.bootstrap && typeof facts.bootstrap === "object" ? (facts.bootstrap as Record<string, unknown>).status : facts.bootstrap;
    const preparation = facts.preparation && typeof facts.preparation === "object" ? (facts.preparation as Record<string, unknown>).status : facts.preparation;
    const mutation = facts.mutation && typeof facts.mutation === "object" ? facts.mutation as Record<string, unknown> : {};
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
      [runId, input.operationId, workerLeaseId, input.fencingToken, lifecycle[input.phase] ?? null,
       bootstrap ?? null, preparation ?? null, mutation.dispatch ?? null, mutation.outcome ?? null,
       facts.protectedExtraction ?? null, facts.publicExtraction ?? null, facts.protectedPersistence ?? null, facts.publicPersistence ?? null,
       facts.capsule ?? null, facts.reconciliation ?? null, facts.continuation ?? null, facts.evidence ?? null,
       facts.credentialSecurity ?? null, facts.reasonCode ?? null, facts.failurePhase ?? null, facts.retryClass ?? null,
       facts.acquisitionContractDigest ?? null, facts.recoveryExpiresAt ?? null],
    );
    if (!result.rowCount) throw new ConflictException("PROTECTED_TRANSACTION_FENCED");
  }

  async protectedRecoveryDecision(runId: string, operationId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ resolution: { action?: string; correctedScope?: import("@scry/contracts").SemanticScope } }>(`SELECT recovery_resolution resolution FROM protected_transactions WHERE run_id=$1 AND operation_id=$2 FOR UPDATE`, [runId,operationId]);
      const resolution = result.rows[0]?.resolution;
      const action = resolution?.action;
      if (!action) return undefined;
      await client.query(`UPDATE protected_transactions SET recovery_resolution='{}'::jsonb,updated_at=now() WHERE run_id=$1 AND operation_id=$2`, [runId,operationId]);
      return { action, ...(resolution.correctedScope ? { correctedScope: resolution.correctedScope } : {}) };
    });
  }
  async groundingHistory(runId: string, intentDigest: string) {
    const result = await this.database.query<{ fingerprint: import("@scry/contracts").SemanticFingerprint }>(`SELECT h.fingerprint FROM runs r JOIN environments e ON e.id=r.environment_id JOIN semantic_target_history h ON h.project_id=r.project_id AND h.environment_id=r.environment_id AND h.flow_revision_id=r.flow_revision_id AND h.origin=e.base_origin AND h.intent_digest=$2 WHERE r.id=$1`, [runId,intentDigest]);
    return result.rows[0]?.fingerprint;
  }

  async recordContextProvenance(runId: string, input: { contextId: string; provenance: string; operationId: string }) {
    const allowed: Record<string, string[]> = {
      safe_parked: ["safe"], safe: ["safe_parked"], tainted: ["protected"], destroyed: ["safe_parked", "protected", "tainted", "restored_pending_verification"], restored_safe: ["restored_pending_verification"],
    };
    return this.database.transaction(async (client) => {
      const existing = await client.query(`SELECT provenance FROM browser_contexts WHERE id=$1 AND run_id=$2 FOR UPDATE`, [input.contextId, runId]);
      if (!existing.rowCount) {
        const initial = input.provenance === "safe_parked" ? "safe_parked" : input.provenance;
        await client.query(`INSERT INTO browser_contexts(id,run_id,operation_id,provenance,destroyed_at) VALUES ($1,$2,$3,$4,CASE WHEN $4='destroyed' THEN now() END)`, [input.contextId, runId, input.operationId, initial]);
        return;
      }
      const prior = String(existing.rows[0]!.provenance);
      if (!(allowed[input.provenance] ?? []).includes(prior)) throw new ConflictException(`CONTEXT_PROVENANCE_TRANSITION_REJECTED:${prior}:${input.provenance}`);
      await client.query(`UPDATE browser_contexts SET provenance=$3,destroyed_at=CASE WHEN $3='destroyed' THEN now() ELSE NULL END WHERE id=$1 AND run_id=$2`, [input.contextId, runId, input.provenance]);
    });
  }

  async persistCapturedSecret(input: {
    runId: string; operationId: string; reference: string; name: string; value: string; scope: "run" | "project";
  }) {
    if (input.scope === "project") return this.captureCredential(input.runId, input.name, input.value);
    const encrypted = encryptCredential(input.value);
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO run_captured_secrets(
         id, run_id, operation_id, reference, ciphertext, initialization_vector, authentication_tag
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.runId, input.operationId, input.reference, encrypted.ciphertext, encrypted.initializationVector, encrypted.authenticationTag],
    );
    return { credentialId: id };
  }

  async persistGeneratedPublicValue(input: {
    runId: string; operationId: string; reference: string; name: string; value: string; scope: "run" | "project";
  }) {
    const run = await this.database.query<{ projectId: string; missionId: string; objectiveId: string }>(
      `SELECT project_id AS "projectId",mission_id AS "missionId",objective_id AS "objectiveId" FROM runs WHERE id = $1`, [input.runId],
    );
    if (!run.rowCount) throw new NotFoundException("Run not found");
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO generated_public_values(id,project_id,source_run_id,run_id,operation_id,name,reference,scope,mission_id,objective_id,value)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,run.rows[0]!.projectId,input.runId,input.scope === "run" ? input.runId : null,input.operationId,input.name,input.reference,input.scope,run.rows[0]!.missionId,run.rows[0]!.objectiveId,input.value],
    );
    return { valueId: id };
  }

  async resolveGeneratedPublicValue(runId: string, valueId: string) {
    const result = await this.database.query<{ value: string }>(
      `SELECT value.value FROM generated_public_values value
       JOIN runs run ON run.id=$1 AND run.project_id=value.project_id
       WHERE value.id=$2 AND (value.scope='project' OR value.run_id=run.id)`,
      [runId, valueId],
    );
    if (!result.rowCount) throw new NotFoundException("Generated public value not found or not authorized");
    return result.rows[0]!.value;
  }

  async markCapturedCredentialCompromised(runId: string, credentialId: string, code: string, operationId: string) {
    const incidentId = randomUUID();
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE project_credentials SET security_status = 'compromised'
         WHERE id = $1 AND project_id = (SELECT project_id FROM runs WHERE id = $2)`,
        [credentialId, runId],
      );
      await client.query(
        `UPDATE run_captured_secrets SET security_status = 'compromised' WHERE id = $1 AND run_id = $2`,
        [credentialId, runId],
      );
      await client.query(
        `INSERT INTO credential_incidents(id, project_id, run_id, credential_id, run_secret_id, operation_id, state, reason_code, safe_diagnostics)
         SELECT $1, run.project_id, run.id,
                CASE WHEN project_credential.id IS NOT NULL THEN $2::uuid ELSE NULL END,
                CASE WHEN run_secret.id IS NOT NULL THEN $2::uuid ELSE NULL END,
                $3, 'manual_action_required', $4, '{"manualAction":"REVOKE_IN_PROVIDER_ADMIN"}'::jsonb
         FROM runs run LEFT JOIN project_credentials project_credential ON project_credential.id = $2
         LEFT JOIN run_captured_secrets run_secret ON run_secret.id = $2 WHERE run.id = $5`,
        [incidentId, credentialId, operationId, code, runId],
      );
    });
    const snapshot = await this.database.query<{ plan: { steps?: Array<{ action?: { operationId?: string; calibrationAttestationId?: string } }> } }>(`SELECT plan_snapshot AS plan FROM runs WHERE id = $1`, [runId]);
    const attestationId = snapshot.rows[0]?.plan.steps?.find((step) => step.action?.operationId === operationId)?.action?.calibrationAttestationId;
    const adapter = attestationId
      ? await this.database.query<{ adapterId: string; configuration: { endpoint?: string }; allowedOrigins: string[] }>(
        `SELECT revision.operation_snapshot->'revocationAdapter'->>'adapterId' AS "adapterId",
                revision.operation_snapshot->'revocationAdapter'->'configuration' AS configuration,
                ARRAY(SELECT jsonb_array_elements_text(revision.allowed_origins)) AS "allowedOrigins"
         FROM calibration_attestations attestation JOIN calibration_contract_revisions revision ON revision.id=attestation.contract_revision_id
         JOIN calibration_decisions decision ON decision.attestation_id=attestation.id AND decision.decision='approved'
         LEFT JOIN calibration_revocations revocation ON revocation.attestation_id=attestation.id
         WHERE attestation.id=$1 AND revocation.id IS NULL`, [attestationId],
      ).catch(() => ({ rows: [], rowCount: 0 }))
      : { rows: [], rowCount: 0 };
    const selected = adapter.rows[0];
    if (selected?.adapterId === "gauntlet.revocation" && selected.configuration?.endpoint) {
      const endpoint = new URL(selected.configuration.endpoint);
      if (selected.allowedOrigins.includes(endpoint.origin)) {
        await this.database.query(`UPDATE credential_incidents SET state = 'pending', adapter_id = $2, safe_diagnostics = '{"code":"REVOCATION_PENDING"}'::jsonb WHERE id = $1`, [incidentId, selected.adapterId]);
        try {
          const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credentialId }), signal: AbortSignal.timeout(5_000) });
          await this.database.query(`UPDATE credential_incidents SET state = $2, safe_diagnostics = $3::jsonb, resolved_at = CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END WHERE id = $1`, [incidentId, response.ok ? "revoked" : "failed", JSON.stringify({ code: response.ok ? "REVOCATION_CONFIRMED" : "REVOCATION_REJECTED", ...(response.ok ? {} : { manualAction: "REVOKE_IN_PROVIDER_ADMIN" }) })]);
          return { incidentId, state: response.ok ? "revoked" as const : "failed" as const };
        } catch (error) {
          const state = error instanceof DOMException && error.name === "TimeoutError" ? "timed_out" : "failed";
          await this.database.query(`UPDATE credential_incidents SET state = $2, safe_diagnostics = $3::jsonb WHERE id = $1`, [incidentId, state, JSON.stringify({ code: state === "timed_out" ? "REVOCATION_TIMED_OUT" : "REVOCATION_FAILED", manualAction: "REVOKE_IN_PROVIDER_ADMIN" })]);
          return { incidentId, state };
        }
      }
    }
    return { incidentId, state: "manual_action_required" as const };
  }

  async establishCheckpoint(runId: string, input: { checkpoint: { id: string; restorationUrl: string; continueAtStepId: string }; payload: unknown; bindingFingerprint: string; expiresAt: string }) {
    const encrypted = encryptCredential(JSON.stringify(input.payload));
    await this.database.query(
      `INSERT INTO run_checkpoints(run_id, checkpoint_id, state, ciphertext, initialization_vector, authentication_tag,
         binding_fingerprint, restoration_url, continue_at_step_id, expires_at, established_at)
       VALUES ($1,$2,'available',$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (run_id, checkpoint_id) DO NOTHING`,
      [runId, input.checkpoint.id, encrypted.ciphertext, encrypted.initializationVector, encrypted.authenticationTag,
       input.bindingFingerprint, input.checkpoint.restorationUrl, input.checkpoint.continueAtStepId, input.expiresAt],
    );
  }

  async claimCheckpoint(runId: string, checkpointId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE run_checkpoints SET state = 'restoring', restoration_attempts = restoration_attempts + 1, updated_at = now()
         WHERE run_id = $1 AND checkpoint_id = $2 AND state = 'available' AND restoration_attempts = 0 AND expires_at > now()
         RETURNING ciphertext, initialization_vector AS "initializationVector", authentication_tag AS "authenticationTag",
                   binding_fingerprint AS "bindingFingerprint"`, [runId, checkpointId],
      );
      if (!result.rowCount) throw new ConflictException("CHECKPOINT_UNAVAILABLE");
      const row = result.rows[0]!;
      return { payload: JSON.parse(decryptCredential(row)), bindingFingerprint: row.bindingFingerprint };
    });
  }

  async completeCheckpoint(runId: string, checkpointId: string, outcome: "verified" | "failed" | "destroyed", reasonCode?: string) {
    const result = await this.database.query(
      `UPDATE run_checkpoints SET state = $3, ciphertext = NULL, initialization_vector = NULL, authentication_tag = NULL,
         reason_code = $4, restored_at = CASE WHEN $3 = 'verified' THEN now() ELSE restored_at END, updated_at = now()
       WHERE run_id = $1 AND checkpoint_id = $2 AND state IN ('available','restoring') RETURNING id`,
      [runId, checkpointId, outcome, reasonCode ?? null],
    );
    if (!result.rowCount) throw new ConflictException("CHECKPOINT_STATE_CONFLICT");
  }

  async verifyCalibrationAttestation(runId: string, attestationId: string, operationId: string, operationDigest: string, structureFingerprint: string) {
    const result = await this.database.query(
      `SELECT 1 FROM calibration_attestations attestation
       JOIN calibration_contract_revisions revision ON revision.id=attestation.contract_revision_id
       JOIN calibration_contracts contract ON contract.id=revision.contract_id
       JOIN calibration_decisions decision ON decision.attestation_id=attestation.id AND decision.decision='approved'
       LEFT JOIN calibration_revocations revocation ON revocation.attestation_id=attestation.id
       JOIN runs run ON run.project_id = contract.project_id
       WHERE run.id=$1 AND attestation.id=$2 AND revision.operation_id=$3
         AND revision.operation_digest=$4 AND attestation.operation_digest=$4 AND attestation.boundary_fingerprint=$5
         AND revision.input_schema_digest=attestation.input_schema_digest
         AND revision.environment_id=run.environment_id AND revocation.id IS NULL
         AND attestation.privacy_verified AND attestation.canary_scan_passed AND attestation.mutation_count=1`,
      [runId, attestationId, operationId, operationDigest, structureFingerprint],
    );
    return Boolean(result.rowCount);
  }

  async markQueued(runId: string) {
    return this.database.transaction(async (client) => {
      const run = await client.query(
        "SELECT state, cancellation_requested_at FROM runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found");
      const row = run.rows[0]!;
      if (!["draft", "queued"].includes(row.state)) {
        throw new ConflictException(`Run cannot be queued from state ${row.state}`);
      }
      if (row.cancellation_requested_at) {
        throw new ConflictException("Cancelled run cannot be queued");
      }
      const result = await client.query(
        `UPDATE runs SET state = 'queued', phase = 'queued', queued_at = COALESCE(queued_at, now()),
                         updated_at = now()
         WHERE id = $1
         RETURNING id, state, queued_at AS "queuedAt"`,
        [runId],
      );
      return result.rows[0]!;
    });
  }

  async requestCancellation(runId: string) {
    const result = await this.database.query(
      `UPDATE runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, now()),
                       updated_at = now()
       WHERE id = $1
         AND state NOT IN ('passed','failed','cancelled','timed_out','infrastructure_error')
       RETURNING id, state, cancellation_requested_at AS "cancellationRequestedAt"`,
      [runId],
    );
    if (!result.rowCount) throw new ConflictException("Run is missing or already terminal");
    return result.rows[0]!;
  }

  async cancelQueuedRun(runId: string) {
    await this.database.query(
      `UPDATE runs SET state = 'cancelled', phase = 'completed', outcome_classification = 'cancelled', updated_at = now()
       WHERE id = $1 AND state = 'queued'`,
      [runId],
    );
  }

  async claimAttempt(runId: string, workerId: string, claimToken: string) {
    return this.database.transaction(async (client) => {
      const run = await client.query(
        `SELECT state, cancellation_requested_at FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found");
      if (run.rows[0]!.cancellation_requested_at) {
        await client.query(
          "UPDATE runs SET state = 'cancelled', phase = 'completed', outcome_classification = 'cancelled', updated_at = now() WHERE id = $1",
          [runId],
        );
        return undefined;
      }
      if (run.rows[0]!.state !== "queued") {
        throw new ConflictException(`Run cannot be claimed from state ${run.rows[0]!.state}`);
      }
      const result = await client.query(
        `INSERT INTO attempts(
           run_id, attempt_number, state, started_at, heartbeat_at, worker_id, claim_token
         )
         SELECT $1, COALESCE(MAX(attempt_number), 0) + 1, 'preparing',
                now(), now(), $2, $3
         FROM attempts WHERE run_id = $1
         RETURNING id, run_id AS "runId", attempt_number AS "attemptNumber",
                   state, started_at AS "startedAt", claim_token AS "claimToken",
                   created_at AS "createdAt"`,
        [runId, workerId, claimToken],
      );
      await client.query(
        "UPDATE runs SET state = 'preparing', phase = 'preparing', updated_at = now() WHERE id = $1",
        [runId],
      );
      return result.rows[0]!;
    });
  }

  async loadExecution(runId: string) {
    const result = await this.database.query(
      `SELECT id, flow_revision_id AS "flowRevisionId", environment_id AS "environmentId", plan_snapshot AS "planSnapshot", policy_snapshot AS "policySnapshot",
              environment_snapshot AS "environmentSnapshot",
              execution_snapshot AS "executionSnapshot"
       FROM runs WHERE id = $1`,
      [runId],
    );
    if (!result.rowCount) throw new NotFoundException("Run not found");
    return result.rows[0]!;
  }

  async resolveCredential(runId: string, credentialId: string) {
    const result = await this.lookupCredential(runId, credentialId);
    if (result.status === "resolved") return result.value;
    if (result.status === "storage_failure") throw new Error(`CREDENTIAL_STORAGE_FAILURE: ${result.message}`);
    throw new BadRequestException(`CREDENTIAL_${result.status.toUpperCase()}: Protected credential is unavailable`);
  }

  async lookupCredential(runId: string, credentialId: string): Promise<CredentialLookupResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credentialId)) {
      return { status: "invalid_reference" };
    }
    try {
      const runSecret = await this.database.query<{
        ciphertext: Buffer; initializationVector: Buffer; authenticationTag: Buffer; securityStatus: string;
      }>(
        `SELECT ciphertext, initialization_vector AS "initializationVector", authentication_tag AS "authenticationTag", security_status AS "securityStatus"
         FROM run_captured_secrets WHERE id=$2 AND run_id=$1`, [runId, credentialId],
      );
      if (runSecret.rowCount) {
        if (runSecret.rows[0]!.securityStatus !== "active") return { status: "compromised" };
        return { status: "resolved", value: decryptCredential(runSecret.rows[0]!) };
      }
      const authorization = await this.database.query<{ projectId: string; authorized: boolean }>(
        `SELECT project_id AS "projectId",
                COALESCE(environment_snapshot->'secretRefs', '[]'::jsonb) ? ($2::uuid)::text AS authorized
         FROM runs WHERE id = $1`,
        [runId, credentialId],
      );
      if (!authorization.rowCount || !authorization.rows[0]!.authorized) return { status: "not_authorized" };
      const credential = await this.database.query<{
      ciphertext: Buffer;
      initializationVector: Buffer;
      authenticationTag: Buffer;
      deletedAt?: Date;
      securityStatus: string;
    }>(
      `SELECT credential.ciphertext,
              credential.initialization_vector AS "initializationVector",
              credential.authentication_tag AS "authenticationTag", credential.deleted_at AS "deletedAt",
              credential.security_status AS "securityStatus"
       FROM project_credentials credential
       WHERE credential.project_id = $1 AND credential.id = $2`,
        [authorization.rows[0]!.projectId, credentialId],
      );
      if (!credential.rowCount || credential.rows[0]!.deletedAt) return { status: "deleted" };
      if (credential.rows[0]!.securityStatus !== "active") return { status: "compromised" };
      return { status: "resolved", value: decryptCredential(credential.rows[0]!) };
    } catch (error) {
      return { status: "storage_failure", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async captureCredential(runId: string, name: string, value: string) {
    const encrypted = encryptCredential(value);
    return this.database.transaction(async (client) => {
      const run = await client.query(
        `SELECT project_id,environment_id,mission_id,objective_id,agent_session_id FROM runs WHERE id=$1 FOR UPDATE`,
        [runId],
      );
      if (!run.rowCount) throw new NotFoundException("Run not found");
      const duplicateName = await client.query(
        `SELECT 1 FROM project_credentials
         WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL`,
        [run.rows[0]!.project_id, name],
      );
      const generatedCredentialId = randomUUID();
      const storedName = duplicateName.rowCount
        ? `${name.slice(0, 185)} (${generatedCredentialId.slice(0, 8)})`
        : name;
      const credential = await client.query(
        `INSERT INTO project_credentials(id,project_id,name,ciphertext,initialization_vector,authentication_tag,origin_mission_id,origin_objective_id,created_by_agent_session_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          generatedCredentialId,
          run.rows[0]!.project_id,
          storedName,
          encrypted.ciphertext,
          encrypted.initializationVector,
          encrypted.authenticationTag,
          run.rows[0]!.mission_id,
          run.rows[0]!.objective_id,
          run.rows[0]!.agent_session_id,
        ],
      );
      const credentialId = String(credential.rows[0]!.id);
      await client.query(
        `UPDATE environments
         SET secret_refs = CASE
           WHEN secret_refs @> to_jsonb(ARRAY[$2::text]) THEN secret_refs
           ELSE secret_refs || to_jsonb($2::text)
         END
         WHERE id = $1`,
        [run.rows[0]!.environment_id, credentialId],
      );
      return { credentialId };
    });
  }

  async markRunning(runId: string, attemptId: string, claimToken: string) {
    const updated = await this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts SET state = 'running', heartbeat_at = now()
         WHERE id = $1 AND claim_token = $2 AND state = 'preparing'
         RETURNING id`,
        [attemptId, claimToken],
      );
      if (!attempt.rowCount) return false;
      await client.query(
        "UPDATE runs SET state = 'running', phase = 'executing_action', updated_at = now() WHERE id = $1",
        [runId],
      );
      await client.query(`UPDATE mission_objective_orchestration SET state='running',lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE active_run_id=$1 AND state='queued'`,[runId]);
      return true;
    });
    if (!updated) throw new ConflictException("Attempt claim was lost");
  }

  async heartbeat(attemptId: string, claimToken: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE attempts SET heartbeat_at = now()
         WHERE id = $1 AND claim_token = $2 AND state IN ('preparing','running','finalizing')
         RETURNING run_id`, [attemptId, claimToken],
      );
      if (!result.rowCount) return false;
      await client.query(`UPDATE protected_transactions SET lease_expires_at=now()+interval '30 seconds' WHERE run_id=$1 AND worker_lease_id=$2`, [result.rows[0]!.run_id, claimToken]);
      await client.query(`UPDATE protected_mutation_ledger SET lease_expires_at=now()+interval '30 seconds' WHERE run_id=$1 AND worker_lease_id=$2`, [result.rows[0]!.run_id, claimToken]);
      return true;
    });
  }

  async markFinalizing(runId: string, attemptId: string, claimToken: string) {
    return this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts SET state = 'finalizing', heartbeat_at = now()
         WHERE id = $1 AND claim_token = $2 AND state = 'running'
         RETURNING id`,
        [attemptId, claimToken],
      );
      if (!attempt.rowCount) throw new ConflictException("Attempt claim was lost");
      await client.query(
        "UPDATE runs SET state = 'finalizing', phase = 'finalizing', updated_at = now() WHERE id = $1 AND state = 'running'",
        [runId],
      );
    });
  }

  async isCancellationRequested(runId: string) {
    const result = await this.database.query(
      "SELECT cancellation_requested_at IS NOT NULL AS cancelled FROM runs WHERE id = $1",
      [runId],
    );
    return Boolean(result.rows[0]?.cancelled);
  }

  async appendEvent(
    attemptId: string,
    claimToken: string,
    event: Omit<RunEvent, "attemptId" | "runId">,
  ) {
    const result = await this.database.query(
      `INSERT INTO run_events(attempt_id, sequence, type, payload, occurred_at)
       SELECT $1, $3, $4, $5::jsonb, $6
       FROM attempts WHERE id = $1 AND claim_token = $2
       RETURNING id, attempt_id AS "attemptId", sequence, type, payload,
                 occurred_at AS "occurredAt", created_at AS "createdAt"`,
      [
        attemptId,
        claimToken,
        event.sequence,
        event.type,
        JSON.stringify(event.payload),
        event.occurredAt,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordGroundingDiagnostic(runId: string, payload: Record<string, unknown>) {
    await this.database.transaction(async (client) => {
      await client.query(`INSERT INTO grounding_diagnostics(run_id,step_id,intent_digest,outcome,failure_code,candidate_count,eligible_count,confidence,confidence_margin,score_components,rejected_constraints,selected_fingerprint,drift,safe_actions,resolution_source,visual_candidate_count,observation,evidence_families,correlation_groups,degraded_policy,selected_adapter) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,'unified',$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20)`, [runId,String(payload.stepId ?? "unknown"),String(payload.intentDigest),payload.outcome === "resolved" ? "resolved" : "rejected",payload.code ?? null,Number(payload.candidateCount ?? 0),Number(payload.eligibleCount ?? 0),Number(payload.confidence ?? 0),Number(payload.confidenceMargin ?? 0),JSON.stringify(payload.score ?? {}),JSON.stringify(payload.rejectedConstraints ?? []),JSON.stringify(payload.selectedFingerprint ?? null),String(payload.drift ?? "unchanged"),JSON.stringify(payload.safeActions ?? []),Number(payload.visualCandidateCount ?? 0),JSON.stringify(payload.observation ?? {status:"failed",reasonCode:"DIAGNOSTIC_INCOMPLETE"}),JSON.stringify(payload.evidenceFamilies ?? []),JSON.stringify(payload.correlationGroups ?? []),payload.degradedPolicy??null,payload.selectedAdapter??null]);
      if (payload.outcome === "resolved" && payload.selectedFingerprint) await client.query(`INSERT INTO semantic_target_history(project_id,environment_id,flow_revision_id,origin,intent_digest,fingerprint,confidence,confidence_margin,drift) SELECT r.project_id,r.environment_id,r.flow_revision_id,e.base_origin,$2,$3::jsonb,$4,$5,$6 FROM runs r JOIN environments e ON e.id=r.environment_id WHERE r.id=$1 ON CONFLICT(project_id,environment_id,flow_revision_id,origin,intent_digest) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,confidence=EXCLUDED.confidence,confidence_margin=EXCLUDED.confidence_margin,drift=EXCLUDED.drift,success_count=semantic_target_history.success_count+1,last_seen_at=now()`, [runId,String(payload.intentDigest),JSON.stringify(payload.selectedFingerprint),Number(payload.confidence ?? 0),Number(payload.confidenceMargin ?? 0),String(payload.drift ?? "unchanged")]);
    });
  }

  async recordAssertion(input: {
    attemptId: string;
    claimToken: string;
    stepId: string;
    assertionIndex: number;
    assertionType: string;
    status: "passed" | "failed" | "unevaluated";
    error?: string;
  }) {
    const result = await this.database.query(
      `INSERT INTO assertion_results(
         attempt_id, step_id, assertion_index, assertion_type, status, error
       )
       SELECT $1, $3, $4, $5, $6, $7
       FROM attempts WHERE id = $1 AND claim_token = $2
       RETURNING id, attempt_id AS "attemptId", step_id AS "stepId",
                 assertion_index AS "assertionIndex", assertion_type AS "assertionType",
                 status, error, created_at AS "createdAt"`,
      [
        input.attemptId,
        input.claimToken,
        input.stepId,
        input.assertionIndex,
        input.assertionType,
        input.status,
        input.error ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordStepResult(input: {
    attemptId: string;
    claimToken: string;
    ordinal: number;
    step: {
      id: string;
      action: { status: string; error?: string };
      readiness?: unknown;
      assertions: Array<{ status: string }>;
      evidence: unknown[];
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
    };
  }) {
    const summary = {
      passed: input.step.assertions.filter(({ status }) => status === "passed").length,
      failed: input.step.assertions.filter(({ status }) => status === "failed").length,
      unevaluated: input.step.assertions.filter(({ status }) => status === "unevaluated").length,
    };
    await this.database.query(
      `INSERT INTO step_results(attempt_id, step_id, ordinal, action_status, action_error,
                                readiness, assertions_summary, evidence, started_at, completed_at, duration_ms)
       SELECT $1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12
       FROM attempts WHERE id = $1 AND claim_token = $2
       ON CONFLICT (attempt_id, step_id) DO UPDATE SET action_status = EXCLUDED.action_status,
         action_error = EXCLUDED.action_error, readiness = EXCLUDED.readiness,
         assertions_summary = EXCLUDED.assertions_summary, evidence = EXCLUDED.evidence,
         completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms`,
      [input.attemptId, input.claimToken, input.step.id, input.ordinal, input.step.action.status,
       input.step.action.error ?? null, JSON.stringify(input.step.readiness ?? null), JSON.stringify(summary),
       JSON.stringify(input.step.evidence), input.step.startedAt ?? null, input.step.completedAt ?? null, input.step.durationMs ?? null],
    );
  }

  async recordArtifact(input: {
    attemptId: string;
    claimToken: string;
    stepId?: string;
    artifact: Artifact;
    storageKey?: string;
    retentionUntil?: string;
    contextId?: string;
    captureEpoch?: number;
  }) {
    const availability = input.artifact.availability;
    const privacyClassification = input.artifact.privacyClassification;
    if (availability === "available" && (!input.contextId || input.captureEpoch === undefined)) throw new ConflictException("AVAILABLE_ARTIFACT_REQUIRES_PROVENANCE");
    if (input.contextId) await this.database.query(
      `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
       SELECT $1,run_id,'safe',$3 FROM attempts WHERE id=$2 ON CONFLICT (id) DO NOTHING`, [input.contextId, input.attemptId, input.captureEpoch ?? null],
    );
    const result = await this.database.query(
      `INSERT INTO artifacts(
         id, attempt_id, step_id, kind, availability, privacy_classification, content_type, storage_key,
         size_bytes, checksum_sha256, retention_until, metadata, reason_code, context_id, capture_epoch
       )
       SELECT $1, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16
       FROM attempts WHERE id = $2 AND claim_token = $3
       RETURNING id, attempt_id AS "attemptId", step_id AS "stepId", kind, availability,
                 content_type AS "contentType", storage_key AS "storageKey",
                 size_bytes AS "sizeBytes", checksum_sha256 AS "checksumSha256",
                 retention_until AS "retentionUntil", metadata AS observation,
                 created_at AS "createdAt"`,
      [
        input.artifact.id,
        input.attemptId,
        input.claimToken,
        input.stepId ?? null,
        input.artifact.kind,
        availability,
        privacyClassification,
        input.artifact.contentType,
        input.storageKey ?? null,
        input.artifact.sizeBytes ?? null,
        input.artifact.checksumSha256 ?? null,
        input.retentionUntil ?? null,
        JSON.stringify(input.artifact.observation ?? {}),
        input.artifact.reasonCode ?? null,
        input.contextId ?? null,
        input.captureEpoch ?? null,
      ],
    );
    if (!result.rowCount) throw new ConflictException("Attempt claim was lost");
    return result.rows[0]!;
  }

  async recordCaptureEpochs(attemptId: string, claimToken: string, entries: RecordingTimelineEntry[]) {
    for (const entry of entries) {
      if (entry.type !== "capture_epoch") continue;
      const producingProvenance = entry.startReason === "checkpoint_restored" ? "restored_safe" : "safe";
      await this.database.transaction(async (client) => {
        const attempt = await client.query(`SELECT run_id FROM attempts WHERE id=$1 AND claim_token=$2`, [attemptId, claimToken]);
        if (!attempt.rowCount) throw new ConflictException("Attempt claim was lost");
        const runId = String(attempt.rows[0]!.run_id);
        await client.query(
          `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET capture_epoch=GREATEST(COALESCE(browser_contexts.capture_epoch,0),EXCLUDED.capture_epoch)`,
          [entry.contextId, runId, producingProvenance, entry.epoch],
        );
        await client.query(
          `INSERT INTO capture_epochs(run_id,context_id,epoch,producing_provenance,status,started_at,ended_at)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (context_id,epoch) DO NOTHING`,
          [runId, entry.contextId, entry.epoch, producingProvenance, entry.status, entry.startedAt, entry.endedAt],
        );
      });
    }
  }

  async recordArtifactTimeline(attemptId: string, claimToken: string, entries: RecordingTimelineEntry[]) {
    await this.recordCaptureEpochs(attemptId, claimToken, entries);
    let activeContext: { contextId: string; captureEpoch: number } | undefined;
    for (const entry of entries) {
      if (entry.type === "capture_epoch") {
        activeContext = { contextId: entry.contextId, captureEpoch: entry.epoch };
        await this.database.query(
          `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
           SELECT $1,run_id,'safe',$3 FROM attempts WHERE id=$2
           ON CONFLICT (id) DO UPDATE SET capture_epoch=EXCLUDED.capture_epoch`, [entry.contextId, attemptId, entry.epoch],
        );
      }
      const startedAt = "startedAt" in entry ? entry.startedAt : entry.occurredAt;
      const endedAt = "endedAt" in entry ? entry.endedAt : null;
      const artifactId = "artifactId" in entry ? entry.artifactId ?? null : null;
      const operationId = entry.type === "protected_gap" ? entry.operationId : entry.type === "checkpoint_boundary" ? entry.checkpointId : null;
      const channel = entry.type === "trace_segment" ? "trace"
        : entry.type === "video_segment" ? "video"
        : entry.type === "capture_epoch" ? "capture"
        : entry.type === "checkpoint_boundary" ? "checkpoint"
        : entry.type === "quarantine_record" ? entry.channel : null;
      const reasonCode = "failureCode" in entry ? entry.failureCode ?? null
        : entry.type === "quarantine_record" ? entry.reasonCode
        : entry.type === "checkpoint_boundary" ? entry.reasonCode ?? null
        : null;
      await this.database.query(
        `INSERT INTO artifact_timeline_entries(id, attempt_id, sequence, entry_type, artifact_id, operation_id, channel, started_at, ended_at, reason_code, metadata, context_id, capture_epoch)
         SELECT $1,$2,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14 FROM attempts WHERE id = $2 AND claim_token = $3`,
        [entry.id, attemptId, claimToken, entry.sequence, entry.type, artifactId, operationId, channel, startedAt, endedAt, reasonCode, JSON.stringify(entry), activeContext?.contextId ?? null, activeContext?.captureEpoch ?? null],
      );
      if (entry.type === "protected_gap") {
        await this.database.query(
          `INSERT INTO privacy_intervals(attempt_id, operation_id, sequence, mode, started_at, ended_at, terminal_state, safe_boundary_kind)
           SELECT $1,$3,$4,'protected_recording_gap',$5,$6,'safe_to_resume','recording_gap_closed'
           FROM attempts WHERE id = $1 AND claim_token = $2
           ON CONFLICT (attempt_id, operation_id) DO NOTHING`,
          [attemptId, claimToken, entry.operationId, entry.sequence, entry.startedAt, entry.endedAt],
        );
      }
    }
  }

  async completeAttempt(
    runId: string,
    attemptId: string,
    claimToken: string,
    state: Extract<RunState, "passed" | "failed" | "cancelled" | "timed_out">,
    outcomeClassification: OutcomeClassification,
    error?: string,
  ) {
    return this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts
         SET state = $3, completed_at = now(), heartbeat_at = now(), error = $4
         WHERE id = $1 AND claim_token = $2
           AND state IN ('preparing','running','finalizing')
         RETURNING id`,
        [attemptId, claimToken, state, error ?? null],
      );
      if (!attempt.rowCount) throw new ConflictException("Attempt claim was lost");
      const structural=await client.query<{structural:boolean}>(`SELECT EXISTS(SELECT 1 FROM grounding_diagnostics WHERE run_id=$1 AND failure_code IN ('TARGET_AMBIGUOUS','NO_CAPABILITY_COMPATIBLE_CONTROL','INSUFFICIENT_EVIDENCE','GROUNDING_DRIFT_REQUIRES_CALIBRATION','TARGET_SCOPE_INVALID','TARGET_CHANGED_BEFORE_ACTION')) structural`,[runId]);
      const resultClassification=state==="passed"?"application_pass":state==="cancelled"?"cancelled":structural.rows[0]!.structural||outcomeClassification==="inconclusive_plan"||outcomeClassification==="readiness_timeout"?"calibration_required":outcomeClassification==="assertion_failure"?"application_failure":"environment_failure";
      await client.query(
        `UPDATE runs SET state = $2, phase = 'completed', outcome_classification = $3,result_classification=$4, updated_at = now()
         WHERE id = $1 AND state IN ('preparing','running','finalizing')`,
        [runId, state, outcomeClassification,resultClassification],
      );
      await client.query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata)
        SELECT mission_id,objective_id,agent_session_id,'run_completed',$2,$3::jsonb FROM runs WHERE id=$1`,[runId,`Run completed: ${state}`,JSON.stringify({runId,state,outcomeClassification})]);
      await client.query(`UPDATE mission_objective_orchestration SET state=CASE WHEN $2='cancelled' THEN 'cancelled' WHEN $4='calibration_required' THEN 'blocked' ELSE 'awaiting_evidence' END,blocker_code=CASE WHEN $2='passed' THEN NULL WHEN $4='calibration_required' THEN 'CALIBRATION_REQUIRED' ELSE upper(COALESCE($3,$2)) END,blocker_details=jsonb_build_object('candidateRunState',$2,'outcomeClassification',$3,'resultClassification',$4),lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE active_run_id=$1`,[runId,state,outcomeClassification,resultClassification]);
      if(resultClassification==="calibration_required"){
        const source=await client.query<any>(`SELECT r.mission_id,r.objective_id,r.environment_id,r.agent_session_id,fc.id compilation_id,fc.draft_id,fc.draft_version FROM runs r JOIN flow_compilations fc ON fc.id=r.compiled_contract_id WHERE r.id=$1`,[runId]);
        if(source.rowCount){const item=source.rows[0];await client.query(`UPDATE flow_compilations SET status='calibration_required',invalidated_at=now() WHERE id=$1`,[item.compilation_id]);const probeId=randomUUID();await client.query(`INSERT INTO probe_sessions(id,draft_id,mission_id,objective_id,environment_id,draft_version,level,created_by_agent_session_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'inspection',$7,$8) ON CONFLICT(draft_id,idempotency_key) DO NOTHING`,[probeId,item.draft_id,item.mission_id,item.objective_id,item.environment_id,item.draft_version,item.agent_session_id,`auto-calibration:${runId}`]);await client.query(`INSERT INTO probe_outbox(probe_session_id,release_id,schema_fingerprint) SELECT id,$2,$3 FROM probe_sessions WHERE draft_id=$1 AND idempotency_key=$4 ON CONFLICT(probe_session_id) DO NOTHING`,[item.draft_id,process.env.SCRY_RELEASE_ID??"development",process.env.SCRY_SCHEMA_FINGERPRINT??"development-baseline",`auto-calibration:${runId}`]);}
      }
    });
  }

  async failAttempt(
    runId: string,
    attemptId: string,
    claimToken: string,
    error: string,
    retry: boolean,
  ) {
    return this.database.transaction(async (client) => {
      const attempt = await client.query(
        `UPDATE attempts
         SET state = 'infrastructure_error', completed_at = now(),
             heartbeat_at = now(), error = $3
         WHERE id = $1 AND claim_token = $2
           AND state IN ('preparing','running','finalizing')
         RETURNING id`,
        [attemptId, claimToken, error],
      );
      if (!attempt.rowCount) return;
      await client.query(
        `UPDATE runs SET state = $2, phase = CASE WHEN $3::boolean THEN 'queued' ELSE 'completed' END,
                         outcome_classification = CASE WHEN $3::boolean THEN outcome_classification ELSE 'infrastructure_failure' END,
                         result_classification=CASE WHEN $3::boolean THEN result_classification ELSE 'infrastructure_failure' END,
                         updated_at = now()
         WHERE id = $1`,
        [runId, retry ? "queued" : "infrastructure_error", retry],
      );
      if(!retry) await client.query(`INSERT INTO mission_activities(mission_id,objective_id,agent_session_id,type,summary,safe_metadata)
        SELECT mission_id,objective_id,agent_session_id,'run_completed','Run ended with infrastructure error',$2::jsonb FROM runs WHERE id=$1`,[runId,JSON.stringify({runId,state:"infrastructure_error"})]);
      if(!retry) await client.query(`UPDATE mission_objective_orchestration SET state='blocked',blocker_code='INFRASTRUCTURE_FAILURE',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE active_run_id=$1`,[runId]);
    });
  }

  async recoverStaleAttempts(staleBefore: Date) {
    return this.database.transaction(async (client) => {
      const stale = await client.query(
        `UPDATE attempts
         SET state = 'infrastructure_error', completed_at = now(),
             error = 'Worker heartbeat expired'
         WHERE state IN ('preparing','running','finalizing')
           AND heartbeat_at < $1
         RETURNING run_id`,
        [staleBefore],
      );
      const runIds = [...new Set(stale.rows.map((row) => String(row.run_id)))];
      if (runIds.length > 0) {
        await client.query(
          `UPDATE runs SET state = 'queued', phase = 'queued', updated_at = now()
           WHERE id = ANY($1::uuid[])
             AND cancellation_requested_at IS NULL`,
          [runIds],
        );
        await client.query(
          `UPDATE runs SET state = 'cancelled', outcome_classification = 'cancelled', updated_at = now()
           WHERE id = ANY($1::uuid[])
             AND cancellation_requested_at IS NOT NULL`,
          [runIds],
        );
      }
      return runIds;
    });
  }
}

export type CredentialLookupResult =
  | { status: "resolved"; value: string }
  | { status: "invalid_reference" | "not_authorized" | "deleted" | "compromised" }
  | { status: "storage_failure"; message: string };

export function classifyOriginalAfterConfirmation(
  confirmationState: RunState,
  confirmationClassification: OutcomeClassification,
): OutcomeClassification | null {
  if (confirmationState === "passed") return "non_reproduced_failure";
  if (confirmationClassification === "assertion_failure") return "confirmed_product_failure";
  if (confirmationClassification === "readiness_timeout") return "readiness_timeout";
  return null;
}
