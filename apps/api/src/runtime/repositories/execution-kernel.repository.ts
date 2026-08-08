import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { ExecutionRequest, OperationOutcome } from "@scry/contracts";

import { decryptCredential, encryptCredential } from "../../access/index.js";
import { Database } from "../../infrastructure/index.js";

@Injectable()
export class ExecutionKernelRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async begin(input: { request: ExecutionRequest; startedAt: string }): Promise<void> {
    const digest = createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
    const result = await this.database.query<{ requestDigest: string; state: string }>(
      `INSERT INTO execution_kernel_operations(
         session_id,operation_id,correlation_id,mode,capability_manifest_digest,
         request_digest,idempotency_key,state,started_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'admitted',$8)
       ON CONFLICT DO NOTHING
       RETURNING request_digest AS "requestDigest",state`,
      [
        input.request.sessionId,
        input.request.operationId,
        input.request.correlationId,
        input.request.mode,
        input.request.capabilityManifestDigest,
        digest,
        input.request.idempotencyKey ?? null,
        input.startedAt,
      ],
    );
    if (result.rowCount) return;
    const existing = await this.database.query<{ requestDigest: string; state: string }>(
      `SELECT request_digest AS "requestDigest",state
       FROM execution_kernel_operations WHERE session_id=$1 AND operation_id=$2`,
      [input.request.sessionId, input.request.operationId],
    );
    if (!existing.rowCount || existing.rows[0]!.requestDigest !== digest) {
      throw new Error("EXECUTION_OPERATION_IDEMPOTENCY_CONFLICT");
    }
    throw new Error(
      existing.rows[0]!.state === "admitted"
        ? "EXECUTION_OPERATION_ALREADY_ADMITTED"
        : "EXECUTION_OPERATION_ALREADY_TERMINAL",
    );
  }

  async complete(input: {
    request: ExecutionRequest;
    outcome: OperationOutcome;
    completedAt: string;
  }): Promise<void> {
    await this.settle({ ...input, state: "completed" });
  }

  async fail(input: {
    request: ExecutionRequest;
    reasonCode: string;
    outcome: OperationOutcome;
    completedAt: string;
  }): Promise<void> {
    await this.settle({ ...input, state: "failed" });
  }

  async settle(input: {
    request: ExecutionRequest;
    outcome: OperationOutcome;
    completedAt: string;
    state: "completed" | "failed";
    reasonCode?: string;
    mutation?: {
      mutationIdentity: string;
      fencingToken: number;
      expected: string;
      next: string;
    };
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      if (input.mutation) {
        const mutation = await client.query(
          `UPDATE execution_kernel_mutations SET state=$5,updated_at=now()
           WHERE session_id=$1 AND operation_id=$2 AND fencing_token=$3 AND state=$4
           RETURNING operation_id`,
          [
            input.request.sessionId,
            input.mutation.mutationIdentity,
            input.mutation.fencingToken,
            input.mutation.expected,
            input.mutation.next,
          ],
        );
        if (!mutation.rowCount) throw new Error("EXECUTION_MUTATION_FENCE_LOST");
      }
      const result = await client.query(
        `UPDATE execution_kernel_operations SET
           state=$3,functional_result=$4,mutation_outcome=$5,privacy_result=$6,
           reason_code=$7,safe_outcome=$8::jsonb,completed_at=$9
         WHERE session_id=$1 AND operation_id=$2 AND state='admitted'`,
        [
          input.request.sessionId,
          input.request.operationId,
          input.state,
          input.outcome.functionalResult,
          input.outcome.mutationOutcome,
          input.outcome.privacyResult,
          input.reasonCode ?? input.outcome.reasonCode ?? null,
          JSON.stringify(input.outcome),
          input.completedAt,
        ],
      );
      if (!result.rowCount) throw new Error("EXECUTION_OPERATION_CLAIM_FENCED");
      await destroyRunScopedValues(client, input.request.sessionId, input.request.operationId);
    });
  }

  async appendEvent(
    sessionId: string,
    operationId: string,
    phase: string,
    safeFacts: Record<string, unknown> = {},
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const operation = await client.query(
        `SELECT 1 FROM execution_kernel_operations
         WHERE session_id=$1 AND operation_id=$2 AND state='admitted' FOR UPDATE`,
        [sessionId, operationId],
      );
      if (!operation.rowCount) throw new Error("EXECUTION_OPERATION_NOT_ADMITTED");
      await client.query(
        `INSERT INTO execution_kernel_events(session_id,operation_id,sequence,phase,safe_facts)
         SELECT $1,$2,COALESCE(max(sequence),0)+1,$3,$4::jsonb
         FROM execution_kernel_events WHERE session_id=$1 AND operation_id=$2`,
        [sessionId, operationId, phase, JSON.stringify(safeFacts)],
      );
    });
  }

  async claimMutation(
    sessionId: string,
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
        `INSERT INTO execution_kernel_mutations(
           session_id,operation_id,mutation_kind,program_digest,input_schema_digest,input_digest,state
         ) VALUES($1,$2,$3,$4,$5,$6,'planned') ON CONFLICT DO NOTHING`,
        [
          sessionId,
          input.operationId,
          input.mutationKind,
          input.programDigest,
          input.inputSchemaDigest,
          input.inputDigest,
        ],
      );
      await client.query(
        `UPDATE execution_kernel_mutations
         SET state='planned',fencing_token=fencing_token+1,updated_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND state='reconciled_not_applied'
           AND mutation_kind=$3 AND program_digest=$4
           AND input_schema_digest=$5 AND input_digest=$6`,
        [
          sessionId,
          input.operationId,
          input.mutationKind,
          input.programDigest,
          input.inputSchemaDigest,
          input.inputDigest,
        ],
      );
      const result = await client.query<any>(
        `SELECT state,fencing_token AS "fencingToken",mutation_kind AS "mutationKind",
                program_digest AS "programDigest",input_schema_digest AS "inputSchemaDigest",
                input_digest AS "inputDigest"
         FROM execution_kernel_mutations WHERE session_id=$1 AND operation_id=$2 FOR UPDATE`,
        [sessionId, input.operationId],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.mutationKind !== input.mutationKind ||
        row.programDigest !== input.programDigest ||
        row.inputSchemaDigest !== input.inputSchemaDigest ||
        row.inputDigest !== input.inputDigest
      ) {
        throw new Error("EXECUTION_MUTATION_IDEMPOTENCY_CONFLICT");
      }
      return { state: row.state, fencingToken: row.fencingToken };
    });
  }

  transitionMutation(
    sessionId: string,
    input: { operationId: string; fencingToken: number; expected: string; next: string },
  ) {
    return this.database
      .query(
        `UPDATE execution_kernel_mutations SET state=$5,updated_at=now()
         WHERE session_id=$1 AND operation_id=$2 AND fencing_token=$3 AND state=$4 RETURNING operation_id`,
        [sessionId, input.operationId, input.fencingToken, input.expected, input.next],
      )
      .then((result) => Boolean(result.rowCount));
  }

  recordMutation(
    sessionId: string,
    parentOperationId: string,
    input: { operationId: string; phase: string; facts?: Record<string, unknown> },
  ) {
    return this.appendEvent(sessionId, parentOperationId, input.phase, {
      ...input.facts,
      protectedOperationId: input.operationId,
    });
  }

  async persistSecret(
    sessionId: string,
    input: {
      operationId: string;
      reference: string;
      name: string;
      value: string;
      scope: "run" | "project";
    },
  ) {
    const encrypted = encryptCredential(input.value);
    const credentialId = randomUUID();
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO execution_kernel_secret_values(
         id,session_id,operation_id,reference,name,scope,ciphertext,initialization_vector,
         authentication_tag,retention_until
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
         CASE WHEN $6='run' THEN now()+interval '24 hours' ELSE NULL END)
       ON CONFLICT(session_id,reference) DO UPDATE SET reference=EXCLUDED.reference
       RETURNING id`,
      [
        credentialId,
        sessionId,
        input.operationId,
        input.reference,
        input.name,
        input.scope,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
      ],
    );
    return { credentialId: result.rows[0]!.id };
  }

  async purgeExpiredValues(before = new Date()): Promise<number> {
    return this.database.transaction(async (client) => {
      const secrets = await client.query(
        `DELETE FROM execution_kernel_secret_values
         WHERE scope='run' AND retention_until IS NOT NULL AND retention_until<=$1`,
        [before],
      );
      const publicValues = await client.query(
        `DELETE FROM execution_kernel_public_values
         WHERE scope='run' AND retention_until IS NOT NULL AND retention_until<=$1`,
        [before],
      );
      return (secrets.rowCount ?? 0) + (publicValues.rowCount ?? 0);
    });
  }

  purgeExpiredSecrets(before = new Date()): Promise<number> {
    return this.purgeExpiredValues(before);
  }

  async resolveSecret(sessionId: string, reference: string) {
    const result = await this.database.query<any>(
      `SELECT ciphertext,initialization_vector AS "initializationVector",
              authentication_tag AS "authenticationTag"
       FROM execution_kernel_secret_values WHERE session_id=$1 AND (reference=$2 OR id::text=$2)`,
      [sessionId, reference],
    );
    if (!result.rowCount) return undefined;
    return decryptCredential(result.rows[0]);
  }

  async persistPublicValue(
    sessionId: string,
    input: {
      operationId: string;
      reference: string;
      name: string;
      value: string;
      scope: "run" | "project";
    },
  ) {
    const valueId = randomUUID();
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO execution_kernel_public_values(
         id,session_id,operation_id,reference,name,scope,value,retention_until
       ) VALUES($1,$2,$3,$4,$5,$6,$7,
         CASE WHEN $6='run' THEN now()+interval '24 hours' ELSE NULL END)
       ON CONFLICT(session_id,reference) DO UPDATE SET reference=EXCLUDED.reference
       RETURNING id`,
      [
        valueId,
        sessionId,
        input.operationId,
        input.reference,
        input.name,
        input.scope,
        input.value,
      ],
    );
    return { valueId: result.rows[0]!.id };
  }

  async resolvePublicValue(sessionId: string, reference: string) {
    const result = await this.database.query<{ value: string }>(
      `SELECT value FROM execution_kernel_public_values
       WHERE session_id=$1 AND (reference=$2 OR id::text=$2)`,
      [sessionId, reference],
    );
    return result.rows[0]?.value;
  }

  establishCheckpoint(sessionId: string, input: any) {
    return this.database
      .query(
        `INSERT INTO execution_kernel_checkpoints(
         session_id,checkpoint_id,binding_fingerprint,payload,expires_at
       ) VALUES($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT(session_id,checkpoint_id) DO NOTHING`,
        [
          sessionId,
          input.checkpoint.id,
          input.bindingFingerprint,
          JSON.stringify(input.payload),
          input.expiresAt,
        ],
      )
      .then(() => undefined);
  }

  async claimCheckpoint(sessionId: string, checkpointId: string) {
    const result = await this.database.query<any>(
      `SELECT payload,binding_fingerprint AS "bindingFingerprint"
       FROM execution_kernel_checkpoints
       WHERE session_id=$1 AND checkpoint_id=$2 AND outcome IS NULL AND expires_at>now()`,
      [sessionId, checkpointId],
    );
    if (!result.rowCount) throw new Error("CHECKPOINT_UNAVAILABLE");
    return result.rows[0];
  }

  completeCheckpoint(
    sessionId: string,
    checkpointId: string,
    outcome: string,
    reasonCode?: string,
  ) {
    return this.database
      .query(
        `UPDATE execution_kernel_checkpoints SET outcome=$3,reason_code=$4,completed_at=now()
       WHERE session_id=$1 AND checkpoint_id=$2 AND outcome IS NULL`,
        [sessionId, checkpointId, outcome, reasonCode ?? null],
      )
      .then(() => undefined);
  }

  recordContextProvenance(
    sessionId: string,
    input: { contextId: string; provenance: string; operationId: string },
  ) {
    return this.database
      .query(
        `INSERT INTO execution_kernel_context_provenance(session_id,context_id,operation_id,provenance)
       VALUES($1,$2,$3,$4)`,
        [sessionId, input.contextId, input.operationId, input.provenance],
      )
      .then(() => undefined);
  }
}

async function destroyRunScopedValues(
  client: { query(query: string, values?: unknown[]): Promise<{ rowCount: number | null }> },
  sessionId: string,
  operationId: string,
) {
  await client.query(
    `DELETE FROM execution_kernel_secret_values
     WHERE session_id=$1 AND operation_id=$2 AND scope='run'`,
    [sessionId, operationId],
  );
  await client.query(
    `DELETE FROM execution_kernel_public_values
     WHERE session_id=$1 AND operation_id=$2 AND scope='run'`,
    [sessionId, operationId],
  );
}
