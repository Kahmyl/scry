import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CurrentPlan, ExecutionPolicy, ProtectedTransaction } from "@scry/contracts";
import type { CalibrationStructure } from "@scry/executor";

import { Database } from "./database.js";
import { decryptCredential } from "./credential.crypto.js";

export type CalibrationRuntime = {
  sessionId: string;
  attemptId: string;
  claimToken: string;
  contractRevisionId: string;
  operationDigest: string;
  inputSchemaDigest: string;
  inputDigest: string;
  operationId: string;
  operation: ProtectedTransaction;
  environmentId: string;
  projectId: string;
  plan: CurrentPlan;
  policy: ExecutionPolicy;
};

export type CalibrationCompletion = {
  passed: boolean;
  structure?: CalibrationStructure;
  fingerprint?: string;
  mutationCount: number;
  privacyVerified: boolean;
  canaryScanPassed: boolean;
  diagnostics: Record<string, unknown>;
  failureProvenance?: string;
  protectionResult?: Record<string, unknown>;
  extractionResult?: Record<string, unknown>;
  safeExitResult?: Record<string, unknown>;
};

@Injectable()
export class CalibrationRuntimeRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async claim(sessionId: string, workerId: string, claimToken: string, releaseId: string, schemaFingerprint: string): Promise<CalibrationRuntime | undefined> {
    return this.database.transaction(async (client) => {
      const session = await client.query<{ contractRevisionId: string }>(
        `SELECT contract_revision_id AS "contractRevisionId"
         FROM calibration_sessions
         WHERE id=$1 AND state='queued' AND expires_at>now()
         FOR UPDATE`, [sessionId],
      );
      if (!session.rowCount) return undefined;
      const attempt = await client.query<{ attemptNumber: number }>(
        `SELECT COALESCE(max(attempt_number),0)+1 AS "attemptNumber"
         FROM calibration_attempts WHERE session_id=$1`, [sessionId],
      );
      const attemptNumber = Number(attempt.rows[0]!.attemptNumber);
      const attemptId = randomUUID();
      await client.query(
        `INSERT INTO calibration_attempts(id,session_id,attempt_number,state,worker_id,claim_token,release_id,schema_fingerprint)
         VALUES($1,$2,$3,'claimed',$4,$5,$6,$7)`,
        [attemptId, sessionId, attemptNumber, workerId, claimToken, releaseId, schemaFingerprint],
      );
      await client.query(`UPDATE calibration_sessions SET state='claimed',current_attempt_id=$2,updated_at=now() WHERE id=$1`, [sessionId, attemptId]);
      await this.appendEvent(client, sessionId, "attempt.claimed", "claimed", "CALIBRATION_CLAIMED", { attemptNumber });
      const runtime = await client.query<Omit<CalibrationRuntime, "sessionId" | "attemptId" | "claimToken"> & { operation: ProtectedTransaction }>(
        `SELECT revision.id AS "contractRevisionId",revision.operation_digest AS "operationDigest",
                revision.input_schema_digest AS "inputSchemaDigest",revision.input_digest AS "inputDigest",revision.operation_id AS "operationId",
                revision.operation_snapshot AS operation,revision.environment_id AS "environmentId",contract.project_id AS "projectId",
                flow_revision.plan,environment.policy
         FROM calibration_contract_revisions revision JOIN calibration_contracts contract ON contract.id=revision.contract_id
         JOIN flow_revisions flow_revision ON flow_revision.id=revision.source_flow_revision_id
         JOIN environments environment ON environment.id=revision.environment_id
         WHERE revision.id=$1`, [session.rows[0]!.contractRevisionId],
      );
      if (!runtime.rows[0]) throw new Error("CALIBRATION_RUNTIME_SNAPSHOT_MISSING");
      return { ...runtime.rows[0], sessionId, attemptId, claimToken };
    });
  }

  async markRunning(runtime: CalibrationRuntime, phase: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE calibration_attempts SET state='running',heartbeat_at=now(),safe_diagnostics=jsonb_build_object('phase',$3::text)
         WHERE id=$1 AND claim_token=$2 AND state='claimed' RETURNING id`, [runtime.attemptId, runtime.claimToken, phase],
      );
      if (!result.rowCount) return false;
      const session = await client.query(`UPDATE calibration_sessions SET state=$2::text,updated_at=now() WHERE id=$1 AND current_attempt_id=$3 RETURNING id`, [runtime.sessionId, phase, runtime.attemptId]);
      if (!session.rowCount) throw new Error("CALIBRATION_SESSION_OWNERSHIP_LOST");
      await this.appendEvent(client, runtime.sessionId, "attempt.phase", phase, "CALIBRATION_PHASE_CHANGED", {});
      return true;
    });
  }

  async heartbeat(runtime: CalibrationRuntime) {
    const result = await this.database.query(`UPDATE calibration_attempts SET heartbeat_at=now() WHERE id=$1 AND claim_token=$2 AND state='running' RETURNING id`, [runtime.attemptId, runtime.claimToken]);
    return Boolean(result.rowCount);
  }

  async markPhase(runtime: CalibrationRuntime, phase: string) {
    return this.database.transaction(async (client) => {
      const owned = await client.query(
        `UPDATE calibration_attempts SET heartbeat_at=now(),safe_diagnostics=safe_diagnostics || jsonb_build_object('phase',$3::text)
         WHERE id=$1 AND claim_token=$2 AND state='running' RETURNING id`,
        [runtime.attemptId, runtime.claimToken, phase],
      );
      if (!owned.rowCount) return false;
      const session = await client.query(`UPDATE calibration_sessions SET state=$2,updated_at=now() WHERE id=$1 AND current_attempt_id=$3 RETURNING id`, [runtime.sessionId, phase, runtime.attemptId]);
      if (!session.rowCount) throw new Error("CALIBRATION_SESSION_OWNERSHIP_LOST");
      await this.appendEvent(client, runtime.sessionId, "attempt.phase", phase, "CALIBRATION_PHASE_CHANGED", {});
      return true;
    });
  }

  async markMutation(runtime: CalibrationRuntime, state: "started" | "completed" | "unknown") {
    const count = state === "started" ? 1 : undefined;
    const result = await this.database.query(
      `UPDATE calibration_attempts SET mutation_state=$3,mutation_count=COALESCE($4,mutation_count),heartbeat_at=now()
       WHERE id=$1 AND claim_token=$2 AND state='running' AND mutation_count<=1 RETURNING id`,
      [runtime.attemptId, runtime.claimToken, state, count],
    );
    return Boolean(result.rowCount);
  }

  async complete(runtime: CalibrationRuntime, completion: CalibrationCompletion) {
    return this.database.transaction(async (client) => {
      const owned = await client.query(
        `SELECT id FROM calibration_attempts WHERE id=$1 AND claim_token=$2 AND state='running' FOR UPDATE`,
        [runtime.attemptId, runtime.claimToken],
      );
      if (!owned.rowCount) return false;
      if (completion.passed && completion.structure && completion.fingerprint && completion.mutationCount === 1 && completion.privacyVerified && completion.canaryScanPassed) {
        const attestationId = randomUUID();
        await client.query(
          `INSERT INTO calibration_attestations(id,contract_revision_id,attempt_id,operation_digest,input_schema_digest,input_digest,boundary_fingerprint,boundary_structure,
             protection_result,extraction_result,safe_exit_result,privacy_verified,canary_scan_passed,mutation_count,release_id,schema_fingerprint)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,true,true,1,release_id,schema_fingerprint
           FROM calibration_attempts WHERE id=$3 AND claim_token=$12`,
          [attestationId, runtime.contractRevisionId, runtime.attemptId, runtime.operationDigest, runtime.inputSchemaDigest, runtime.inputDigest, completion.fingerprint, JSON.stringify(completion.structure), JSON.stringify(completion.protectionResult ?? { status: "passed" }), JSON.stringify(completion.extractionResult ?? { status: "passed" }), JSON.stringify(completion.safeExitResult ?? { status: "passed" }), runtime.claimToken],
        );
        await client.query(`UPDATE calibration_attempts SET state='attested',mutation_state='completed',mutation_count=1,safe_diagnostics=$3::jsonb,completed_at=now(),heartbeat_at=now() WHERE id=$1 AND claim_token=$2`, [runtime.attemptId, runtime.claimToken, JSON.stringify(completion.diagnostics)]);
        await client.query(`UPDATE calibration_sessions SET state='attested',completed_at=now(),updated_at=now() WHERE id=$1 AND current_attempt_id=$2`, [runtime.sessionId, runtime.attemptId]);
        await this.appendEvent(client, runtime.sessionId, "attestation.created", "attested", "CALIBRATION_ATTESTED", { attestationId });
        return { attestationId };
      }
      const terminal = completion.mutationCount > 0 ? "mutation_outcome_unknown" : "failed";
      await client.query(
        `UPDATE calibration_attempts SET state=$3,mutation_state=$4,mutation_count=$5,failure_provenance=$6,reason_code=$7,
           safe_diagnostics=$8::jsonb,completed_at=now(),heartbeat_at=now() WHERE id=$1 AND claim_token=$2`,
        [runtime.attemptId, runtime.claimToken, terminal, completion.mutationCount > 0 ? "unknown" : "not_started", completion.mutationCount, completion.failureProvenance ?? "infrastructure", String(completion.diagnostics.code ?? "CALIBRATION_FAILED"), JSON.stringify(completion.diagnostics)],
      );
      await client.query(`UPDATE calibration_sessions SET state=$3,completed_at=now(),updated_at=now() WHERE id=$1 AND current_attempt_id=$2`, [runtime.sessionId, runtime.attemptId, terminal]);
      await this.appendEvent(client, runtime.sessionId, "attempt.failed", terminal, String(completion.diagnostics.code ?? "CALIBRATION_FAILED"), { stepId: completion.diagnostics.stepId, failureProvenance: completion.failureProvenance });
      return false;
    });
  }

  async failClaim(runtime: CalibrationRuntime, reasonCode: string, dependencyCode?: string) {
    return this.database.transaction(async (client) => {
      const owned = await client.query<{ mutationCount: number }>(
        `SELECT mutation_count AS "mutationCount" FROM calibration_attempts
         WHERE id=$1 AND claim_token=$2 AND state IN ('claimed','running') FOR UPDATE`,
        [runtime.attemptId, runtime.claimToken],
      );
      if (!owned.rowCount) return false;
      const mutationCount = Number(owned.rows[0]!.mutationCount);
      const terminal = mutationCount > 0 ? "mutation_outcome_unknown" : "failed";
      const diagnostics = { code: reasonCode, phase: "worker_finalization", ...(dependencyCode ? { dependencyCode } : {}) };
      await client.query(
        `UPDATE calibration_attempts SET state=$3,mutation_state=CASE WHEN mutation_count=0 THEN 'not_started' ELSE 'unknown' END,
           failure_provenance='infrastructure',reason_code=$4,safe_diagnostics=$5::jsonb,completed_at=now(),heartbeat_at=now()
         WHERE id=$1 AND claim_token=$2`,
        [runtime.attemptId, runtime.claimToken, terminal, reasonCode, JSON.stringify(diagnostics)],
      );
      await client.query(`UPDATE calibration_sessions SET state=$3,completed_at=now(),updated_at=now() WHERE id=$1 AND current_attempt_id=$2`, [runtime.sessionId, runtime.attemptId, terminal]);
      await this.appendEvent(client, runtime.sessionId, "attempt.failed", terminal, reasonCode, diagnostics);
      return true;
    });
  }

  async resolveCredential(runtime: CalibrationRuntime, credentialId: string) {
    const result = await this.database.query<{ ciphertext: Buffer; initializationVector: Buffer; authenticationTag: Buffer }>(
      `SELECT credential.ciphertext,credential.initialization_vector AS "initializationVector",credential.authentication_tag AS "authenticationTag"
       FROM project_credentials credential JOIN environments environment ON environment.id=$1 AND environment.project_id=credential.project_id
       WHERE credential.id=$2 AND credential.project_id=$3 AND credential.deleted_at IS NULL AND credential.security_status='active'
         AND environment.secret_refs ? ($2::uuid)::text`, [runtime.environmentId, credentialId, runtime.projectId],
    );
    if (!result.rowCount) throw new BadRequestException("CREDENTIAL_NOT_AUTHORIZED");
    return decryptCredential(result.rows[0]!);
  }

  async recoverStale(staleBefore: Date) {
    return this.database.transaction(async (client) => {
      const stale = await client.query<{ sessionId: string; attemptId: string; mutationCount: number }>(
        `UPDATE calibration_attempts SET state=CASE WHEN mutation_count=0 THEN 'failed' ELSE 'mutation_outcome_unknown' END,
           mutation_state=CASE WHEN mutation_count=0 THEN 'not_started' ELSE 'unknown' END,failure_provenance='infrastructure',reason_code='CALIBRATION_WORKER_LOST',
           safe_diagnostics=jsonb_build_object('code','CALIBRATION_WORKER_LOST','phase','stale_recovery'),completed_at=now()
         WHERE state IN ('claimed','running') AND heartbeat_at<$1
         RETURNING session_id AS "sessionId",id AS "attemptId",mutation_count AS "mutationCount"`, [staleBefore],
      );
      for (const item of stale.rows) {
        const terminal = item.mutationCount === 0 ? "failed" : "mutation_outcome_unknown";
        await client.query(`UPDATE calibration_sessions SET state=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND current_attempt_id=$3`, [item.sessionId, terminal, item.attemptId]);
        await this.appendEvent(client, item.sessionId, "attempt.recovered", terminal, "CALIBRATION_WORKER_LOST", { phase: "stale_recovery" });
      }
      return stale.rows;
    });
  }

  private async appendEvent(query: Pick<Database, "query">, sessionId: string, type: string, phase: string, code: string, safePayload: Record<string, unknown>) {
    await query.query(
      `INSERT INTO calibration_events(session_id,sequence,type,phase,code,safe_payload)
       SELECT $1,COALESCE(max(sequence),0)+1,$2,$3,$4,$5::jsonb FROM calibration_events WHERE session_id=$1`,
      [sessionId, type, phase, code, JSON.stringify(safePayload)],
    );
  }
}
