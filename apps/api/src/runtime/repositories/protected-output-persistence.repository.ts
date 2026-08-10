import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { decryptCredential, encryptCredential } from "../../access/credential.crypto.js";
import { Database } from "../../infrastructure/index.js";

export type ProtectedOutputPersistenceContext = {
  protectedOperationId: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  ownerKind: "authoring_session" | "run";
  ownerId: string;
  operationId: string;
  leaseOwner: string;
  fencingToken: number;
  version: number;
};

export type AcquiredProtectedOutput = {
  reference: string;
  classification: "protected" | "public";
  storageName: string;
  value: string;
  scope: "run" | "project";
};

@Injectable()
export class ProtectedOutputPersistenceRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async stageResponseOutputs(
    context: ProtectedOutputPersistenceContext,
    outputs: AcquiredProtectedOutput[],
  ) {
    validateOutputs(outputs);
    const encrypted = encryptCredential(JSON.stringify(outputs));
    try {
      const result = await this.database.query(
        `INSERT INTO protected_response_output_staging(
           protected_operation_id,operation_id,ciphertext,initialization_vector,authentication_tag
         ) SELECT id,$2,$6,$7,$8 FROM protected_operations
           WHERE id=$1 AND operation_id=$2 AND owner_kind=$3
             AND (($3='authoring_session' AND authoring_session_id=$4) OR ($3='run' AND run_id=$4))
             AND lease_owner=$5 AND fencing_token=$9 AND version=$10 AND state='dispatching'
             AND lease_expires_at>now()
         ON CONFLICT(protected_operation_id) DO NOTHING RETURNING protected_operation_id`,
        [context.protectedOperationId,context.operationId,context.ownerKind,context.ownerId,
          context.leaseOwner,encrypted.ciphertext,encrypted.initializationVector,
          encrypted.authenticationTag,context.fencingToken,context.version],
      );
      if (!result.rowCount) {
        const existing = await this.database.query(
          `SELECT 1 FROM protected_response_output_staging WHERE protected_operation_id=$1 AND operation_id=$2`,
          [context.protectedOperationId,context.operationId],
        );
        if (!existing.rowCount) throw new ConflictException("PROTECTED_RESPONSE_STAGING_FENCED");
      }
    } finally {
      for (const output of outputs) output.value = "";
    }
  }

  async recoverStagedResponseOutputs(context: ProtectedOutputPersistenceContext) {
    const result = await this.database.query<{
      ciphertext: Buffer; initializationVector: Buffer; authenticationTag: Buffer;
    }>(
      `SELECT staged.ciphertext,staged.initialization_vector AS "initializationVector",
         staged.authentication_tag AS "authenticationTag"
       FROM protected_response_output_staging staged
       JOIN protected_operations operation ON operation.id=staged.protected_operation_id
       WHERE operation.id=$1 AND operation.operation_id=$2 AND operation.owner_kind=$3
         AND (($3='authoring_session' AND operation.authoring_session_id=$4) OR ($3='run' AND operation.run_id=$4))
         AND operation.lease_owner=$5 AND operation.fencing_token=$6 AND operation.version=$7
         AND operation.state='recovery_required' AND operation.lease_expires_at>now()`,
      [context.protectedOperationId,context.operationId,context.ownerKind,context.ownerId,
        context.leaseOwner,context.fencingToken,context.version],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0]!;
    const parsed = JSON.parse(decryptCredential(row)) as AcquiredProtectedOutput[];
    validateOutputs(parsed);
    return parsed;
  }

  async persistOutputsAtomically(
    context: ProtectedOutputPersistenceContext,
    outputs: AcquiredProtectedOutput[],
  ) {
    if (!outputs.length || outputs.length > 8) throw new Error("PROTECTED_OUTPUT_SET_INVALID");
    if (new Set(outputs.map((output) => output.reference)).size !== outputs.length)
      throw new Error("PROTECTED_OUTPUT_REFERENCE_DUPLICATE");
    const encrypted = outputs.map((output) => output.classification === "protected"
      ? { output, encrypted: encryptCredential(output.value) }
      : { output });
    try {
      return await this.database.transaction(async (client) => {
        const operation = await client.query<{ state: string }>(
          `SELECT state FROM protected_operations WHERE id=$1 AND project_id=$2 AND environment_id=$3
             AND mission_id=$4 AND objective_id=$5 AND agent_session_id=$6 AND owner_kind=$7
             AND (($7='authoring_session' AND authoring_session_id=$8) OR ($7='run' AND run_id=$8))
             AND operation_id=$9 AND lease_owner=$10 AND fencing_token=$11 AND version=$12
             AND lease_expires_at>now() FOR UPDATE`,
          [context.protectedOperationId,context.projectId,context.environmentId,context.missionId,
            context.objectiveId,context.agentSessionId,context.ownerKind,context.ownerId,
            context.operationId,context.leaseOwner,context.fencingToken,context.version],
        );
        if (operation.rows[0]?.state !== "persisting")
          throw new ConflictException("PROTECTED_OPERATION_PERSISTENCE_FENCED");

        const references: Record<string, { classification: "protected" | "public"; credentialId?: string; valueId?: string; scope: "run" | "project" }> = {};
        const credentialIds: string[] = [];
        for (const item of encrypted) {
          const id = randomUUID();
          if (item.output.classification === "protected") {
            if (item.output.scope === "run") {
              if (context.ownerKind !== "run") throw new ConflictException("RUN_OUTPUT_REQUIRES_RUN_OWNER");
              const secret = (item as Extract<typeof item,{ encrypted: unknown }>).encrypted;
              await client.query(
                `INSERT INTO run_captured_secrets(
                   id,run_id,operation_id,reference,ciphertext,initialization_vector,authentication_tag
                 ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
                [id,context.ownerId,context.operationId,item.output.reference,secret.ciphertext,
                  secret.initializationVector,secret.authenticationTag],
              );
              references[item.output.reference] = { classification: "protected", credentialId: id, scope: "run" };
              continue;
            }
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
              `${context.projectId}:${item.output.storageName}`,
            ]);
            const duplicate = await client.query(
              `SELECT 1 FROM project_credentials WHERE project_id=$1 AND name=$2 AND deleted_at IS NULL`,
              [context.projectId,item.output.storageName],
            );
            const name = duplicate.rowCount
              ? `${item.output.storageName.slice(0,185)} (${id.slice(0,8)})`
              : item.output.storageName;
            const secret = (item as Extract<typeof item,{ encrypted: unknown }>).encrypted;
            await client.query(
              `INSERT INTO project_credentials(
                 id,project_id,name,ciphertext,initialization_vector,authentication_tag,
                 origin_mission_id,origin_objective_id,created_by_agent_session_id,origin_protected_operation_id
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [id,context.projectId,name,secret.ciphertext,secret.initializationVector,
                secret.authenticationTag,context.missionId,context.objectiveId,
                context.agentSessionId,context.protectedOperationId],
            );
            credentialIds.push(id);
            references[item.output.reference] = { classification: "protected", credentialId: id, scope: "project" };
          } else {
            if (item.output.scope === "run" && context.ownerKind !== "run")
              throw new ConflictException("RUN_OUTPUT_REQUIRES_RUN_OWNER");
            await client.query(
              `INSERT INTO generated_public_values(
                 id,project_id,source_run_id,source_protected_operation_id,run_id,operation_id,
                 name,reference,scope,mission_id,objective_id,value
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [id,context.projectId,context.ownerKind === "run" ? context.ownerId : null,
                context.ownerKind === "run" ? null : context.protectedOperationId,
                item.output.scope === "run" ? context.ownerId : null,context.operationId,
                item.output.storageName,item.output.reference,item.output.scope,
                context.missionId,context.objectiveId,item.output.value],
            );
            references[item.output.reference] = { classification: "public", valueId: id, scope: item.output.scope };
          }
        }
        if (credentialIds.length) {
          await client.query(
            `UPDATE environments SET secret_refs=(
               SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements_text(secret_refs || $2::jsonb) value
             ) WHERE id=$1 AND project_id=$3`,
            [context.environmentId,JSON.stringify(credentialIds),context.projectId],
          );
        }
        const transitioned = await client.query<{
          id: string; state: "persisted"; version: string; fencingToken: string;
          persistedReferences: Record<string, unknown>;
        }>(
          `UPDATE protected_operations SET state='persisted',phase='persistence_committed',
             persistence_state='committed',persisted_references=$5::jsonb,version=version+1,updated_at=now()
           WHERE id=$1 AND state='persisting' AND lease_owner=$2 AND fencing_token=$3 AND version=$4
             AND lease_expires_at>now() RETURNING id,state,version,
               fencing_token AS "fencingToken",persisted_references AS "persistedReferences"`,
          [context.protectedOperationId,context.leaseOwner,context.fencingToken,context.version,JSON.stringify(references)],
        );
        if (!transitioned.rowCount) throw new ConflictException("PROTECTED_OPERATION_PERSISTENCE_FENCED");
        await client.query(
          `DELETE FROM protected_response_output_staging WHERE protected_operation_id=$1`,
          [context.protectedOperationId],
        );
        await client.query(
          `INSERT INTO protected_operation_transitions(protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics)
           SELECT $1,COALESCE(max(sequence),0)+1,'persisting','persisted','persistence_committed',$2,'{}'::jsonb
           FROM protected_operation_transitions WHERE protected_operation_id=$1`,
          [context.protectedOperationId,context.fencingToken],
        );
        const row = transitioned.rows[0]!;
        return {
          references,
          claim: {
            id: row.id,
            state: row.state,
            version: Number(row.version),
            fencingToken: Number(row.fencingToken),
            persistedReferences: row.persistedReferences as typeof references,
          },
        };
      });
    } finally {
      for (const output of outputs) output.value = "";
    }
  }

  async markCommittedCredentialsCompromised(input: {
    protectedOperationId: string;
    credentialIds: string[];
    operationId: string;
    reasonCode: string;
    ownerKind: "authoring_session" | "run";
    ownerId: string;
  }) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(input.reasonCode)) throw new Error("PROTECTED_OPERATION_REASON_CODE_INVALID");
    await this.database.transaction(async (client) => {
      for (const credentialId of input.credentialIds) {
        const updated = await client.query<{ project_id: string }>(
          `UPDATE project_credentials SET security_status='compromised',updated_at=now()
           WHERE id=$1 AND origin_protected_operation_id=$2 AND security_status='active'
           RETURNING project_id`,
          [credentialId,input.protectedOperationId],
        );
        if (updated.rowCount) {
          await client.query(
            `INSERT INTO credential_incidents(
               project_id,run_id,protected_operation_id,credential_id,operation_id,state,reason_code,safe_diagnostics
             ) VALUES($1,NULL,$2,$3,$4,'manual_action_required',$5,'{"manualAction":"REVOKE_IN_PROVIDER_ADMIN"}'::jsonb)`,
            [updated.rows[0]!.project_id,input.protectedOperationId,credentialId,input.operationId,input.reasonCode],
          );
          continue;
        }
        if (input.ownerKind !== "run") continue;
        const runSecret = await client.query(
          `UPDATE run_captured_secrets SET security_status='compromised'
           WHERE id=$1 AND run_id=$2 AND security_status='active' RETURNING id`,
          [credentialId,input.ownerId],
        );
        if (!runSecret.rowCount) continue;
        await client.query(
          `INSERT INTO credential_incidents(
             project_id,run_id,protected_operation_id,run_secret_id,operation_id,state,reason_code,safe_diagnostics
           ) SELECT project_id,id,$2,$3,$4,'manual_action_required',$5,
             '{"manualAction":"REVOKE_IN_PROVIDER_ADMIN"}'::jsonb FROM runs WHERE id=$1`,
          [input.ownerId,input.protectedOperationId,credentialId,input.operationId,input.reasonCode],
        );
      }
    });
  }
}

function validateOutputs(outputs: AcquiredProtectedOutput[]) {
  if (!outputs.length || outputs.length > 8) throw new Error("PROTECTED_OUTPUT_SET_INVALID");
  if (new Set(outputs.map((output) => output.reference)).size !== outputs.length)
    throw new Error("PROTECTED_OUTPUT_REFERENCE_DUPLICATE");
  for (const output of outputs) {
    if (!output.value || output.value.length > 64 * 1024) throw new Error("PROTECTED_OUTPUT_VALUE_INVALID");
    if (!output.reference || !output.storageName) throw new Error("PROTECTED_OUTPUT_IDENTITY_INVALID");
  }
}
