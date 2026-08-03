import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { decryptCredential, encryptCredential } from "./credential.crypto.js";
import { Database } from "./database.js";

export class ProtectedExecutionStateRepository {
  constructor(private readonly database: Database) {}

  async recordContextProvenance(
    runId: string,
    input: { contextId: string; provenance: string; operationId: string },
  ) {
    const allowed: Record<string, string[]> = {
      safe_parked: ["safe"],
      safe: ["safe_parked"],
      tainted: ["protected"],
      destroyed: ["safe_parked", "protected", "tainted", "restored_pending_verification"],
      restored_safe: ["restored_pending_verification"],
    };
    return this.database.transaction(async (client) => {
      const existing = await client.query(
        `SELECT provenance FROM browser_contexts WHERE id=$1 AND run_id=$2 FOR UPDATE`,
        [input.contextId, runId],
      );
      if (!existing.rowCount) {
        const initial = input.provenance === "safe_parked" ? "safe_parked" : input.provenance;
        await client.query(
          `INSERT INTO browser_contexts(id,run_id,operation_id,provenance,destroyed_at) VALUES ($1,$2,$3,$4,CASE WHEN $4='destroyed' THEN now() END)`,
          [input.contextId, runId, input.operationId, initial],
        );
        return;
      }
      const prior = String(existing.rows[0]!.provenance);
      if (!(allowed[input.provenance] ?? []).includes(prior))
        throw new ConflictException(
          `CONTEXT_PROVENANCE_TRANSITION_REJECTED:${prior}:${input.provenance}`,
        );
      await client.query(
        `UPDATE browser_contexts SET provenance=$3,destroyed_at=CASE WHEN $3='destroyed' THEN now() ELSE NULL END WHERE id=$1 AND run_id=$2`,
        [input.contextId, runId, input.provenance],
      );
    });
  }

  async persistCapturedSecret(input: {
    runId: string;
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }) {
    if (input.scope === "project")
      return this.captureCredential(input.runId, input.name, input.value);
    const encrypted = encryptCredential(input.value);
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO run_captured_secrets(
         id, run_id, operation_id, reference, ciphertext, initialization_vector, authentication_tag
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        input.runId,
        input.operationId,
        input.reference,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
      ],
    );
    return { credentialId: id };
  }

  async persistGeneratedPublicValue(input: {
    runId: string;
    operationId: string;
    reference: string;
    name: string;
    value: string;
    scope: "run" | "project";
  }) {
    const run = await this.database.query<{
      projectId: string;
      missionId: string;
      objectiveId: string;
    }>(
      `SELECT project_id AS "projectId",mission_id AS "missionId",objective_id AS "objectiveId" FROM runs WHERE id = $1`,
      [input.runId],
    );
    if (!run.rowCount) throw new NotFoundException("Run not found");
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO generated_public_values(id,project_id,source_run_id,run_id,operation_id,name,reference,scope,mission_id,objective_id,value)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        run.rows[0]!.projectId,
        input.runId,
        input.scope === "run" ? input.runId : null,
        input.operationId,
        input.name,
        input.reference,
        input.scope,
        run.rows[0]!.missionId,
        run.rows[0]!.objectiveId,
        input.value,
      ],
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
    if (!result.rowCount)
      throw new NotFoundException("Generated public value not found or not authorized");
    return result.rows[0]!.value;
  }

  async markCapturedCredentialCompromised(
    runId: string,
    credentialId: string,
    code: string,
    operationId: string,
  ) {
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
    const snapshot = await this.database.query<{
      plan: {
        steps?: Array<{ action?: { operationId?: string; calibrationAttestationId?: string } }>;
      };
    }>(`SELECT plan_snapshot AS plan FROM runs WHERE id = $1`, [runId]);
    const attestationId = snapshot.rows[0]?.plan.steps?.find(
      (step) => step.action?.operationId === operationId,
    )?.action?.calibrationAttestationId;
    const adapter = attestationId
      ? await this.database
          .query<{
            adapterId: string;
            configuration: { endpoint?: string };
            allowedOrigins: string[];
          }>(
            `SELECT revision.operation_snapshot->'revocationAdapter'->>'adapterId' AS "adapterId",
                revision.operation_snapshot->'revocationAdapter'->'configuration' AS configuration,
                ARRAY(SELECT jsonb_array_elements_text(revision.allowed_origins)) AS "allowedOrigins"
         FROM calibration_attestations attestation JOIN calibration_contract_revisions revision ON revision.id=attestation.contract_revision_id
         JOIN calibration_decisions decision ON decision.attestation_id=attestation.id AND decision.decision='approved'
         LEFT JOIN calibration_revocations revocation ON revocation.attestation_id=attestation.id
         WHERE attestation.id=$1 AND revocation.id IS NULL`,
            [attestationId],
          )
          .catch(() => ({ rows: [], rowCount: 0 }))
      : { rows: [], rowCount: 0 };
    const selected = adapter.rows[0];
    if (selected?.adapterId === "gauntlet.revocation" && selected.configuration?.endpoint) {
      const endpoint = new URL(selected.configuration.endpoint);
      if (selected.allowedOrigins.includes(endpoint.origin)) {
        await this.database.query(
          `UPDATE credential_incidents SET state = 'pending', adapter_id = $2, safe_diagnostics = '{"code":"REVOCATION_PENDING"}'::jsonb WHERE id = $1`,
          [incidentId, selected.adapterId],
        );
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credentialId }),
            signal: AbortSignal.timeout(5_000),
          });
          await this.database.query(
            `UPDATE credential_incidents SET state = $2, safe_diagnostics = $3::jsonb, resolved_at = CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END WHERE id = $1`,
            [
              incidentId,
              response.ok ? "revoked" : "failed",
              JSON.stringify({
                code: response.ok ? "REVOCATION_CONFIRMED" : "REVOCATION_REJECTED",
                ...(response.ok ? {} : { manualAction: "REVOKE_IN_PROVIDER_ADMIN" }),
              }),
            ],
          );
          return { incidentId, state: response.ok ? ("revoked" as const) : ("failed" as const) };
        } catch (error) {
          const state =
            error instanceof DOMException && error.name === "TimeoutError" ? "timed_out" : "failed";
          await this.database.query(
            `UPDATE credential_incidents SET state = $2, safe_diagnostics = $3::jsonb WHERE id = $1`,
            [
              incidentId,
              state,
              JSON.stringify({
                code: state === "timed_out" ? "REVOCATION_TIMED_OUT" : "REVOCATION_FAILED",
                manualAction: "REVOKE_IN_PROVIDER_ADMIN",
              }),
            ],
          );
          return { incidentId, state };
        }
      }
    }
    return { incidentId, state: "manual_action_required" as const };
  }

  async establishCheckpoint(
    runId: string,
    input: {
      checkpoint: { id: string; restorationUrl: string; continueAtStepId: string };
      payload: unknown;
      bindingFingerprint: string;
      expiresAt: string;
    },
  ) {
    const encrypted = encryptCredential(JSON.stringify(input.payload));
    await this.database.query(
      `INSERT INTO run_checkpoints(run_id, checkpoint_id, state, ciphertext, initialization_vector, authentication_tag,
         binding_fingerprint, restoration_url, continue_at_step_id, expires_at, established_at)
       VALUES ($1,$2,'available',$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (run_id, checkpoint_id) DO NOTHING`,
      [
        runId,
        input.checkpoint.id,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        input.bindingFingerprint,
        input.checkpoint.restorationUrl,
        input.checkpoint.continueAtStepId,
        input.expiresAt,
      ],
    );
  }

  async claimCheckpoint(runId: string, checkpointId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE run_checkpoints SET state = 'restoring', restoration_attempts = restoration_attempts + 1, updated_at = now()
         WHERE run_id = $1 AND checkpoint_id = $2 AND state = 'available' AND restoration_attempts = 0 AND expires_at > now()
         RETURNING ciphertext, initialization_vector AS "initializationVector", authentication_tag AS "authenticationTag",
                   binding_fingerprint AS "bindingFingerprint"`,
        [runId, checkpointId],
      );
      if (!result.rowCount) throw new ConflictException("CHECKPOINT_UNAVAILABLE");
      const row = result.rows[0]!;
      return {
        payload: JSON.parse(decryptCredential(row)),
        bindingFingerprint: row.bindingFingerprint,
      };
    });
  }

  async completeCheckpoint(
    runId: string,
    checkpointId: string,
    outcome: "verified" | "failed" | "destroyed",
    reasonCode?: string,
  ) {
    const result = await this.database.query(
      `UPDATE run_checkpoints SET state = $3, ciphertext = NULL, initialization_vector = NULL, authentication_tag = NULL,
         reason_code = $4, restored_at = CASE WHEN $3 = 'verified' THEN now() ELSE restored_at END, updated_at = now()
       WHERE run_id = $1 AND checkpoint_id = $2 AND state IN ('available','restoring') RETURNING id`,
      [runId, checkpointId, outcome, reasonCode ?? null],
    );
    if (!result.rowCount) throw new ConflictException("CHECKPOINT_STATE_CONFLICT");
  }

  async verifyCalibrationAttestation(
    runId: string,
    attestationId: string,
    operationId: string,
    operationDigest: string,
    structureFingerprint: string,
  ) {
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
}
