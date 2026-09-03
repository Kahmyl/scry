import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { Q5_MCP_PROFILE, Q5_MCP_CONTRACT_DIGEST } from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

export type Q5AttemptScope = Readonly<{
  attemptId: string;
  preparedScopeId: string;
  state: string;
  campaignId: string;
  canonicalApplicationId: string;
  applicationIdentity: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  externalRunId: string;
  flowDraftId: string;
  flowRevisionId: string;
  targetOrigin: string;
  allowedOrigins: string[];
  clientIdPublicValueId: string;
  clientSecretReferenceId: string;
  clientIdValueAssetId: string;
  clientSecretValueAssetId: string;
  runId: string | null;
  praxisSessionId: string | null;
  praxisSessionIds: string[];
  sourceCommit: string;
  sourceManifest: string;
  schemaFingerprint: string;
  migrationDigest: string;
  provider: "deepseek";
  model: string;
}>;

export type PrepareQ5AuthoritativeAttemptInput = Omit<
  Q5AttemptScope,
  | "attemptId"
  | "state"
  | "allowedOrigins"
  | "clientIdPublicValueId"
  | "clientSecretReferenceId"
  | "clientIdValueAssetId"
  | "clientSecretValueAssetId"
  | "runId"
  | "praxisSessionId"
  | "praxisSessionIds"
> & { credentialDigest: string; preparedScopeId: string };

@Injectable()
export class Q5AuthoritativeAttemptRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async createCanonicalApplication(input: {
    identity: string;
    projectId: string;
    environmentId: string;
    baseOrigin: string;
    allowedOrigins: string[];
    clientIdPublicValueId: string;
    clientSecretReferenceId: string;
    clientIdValueAssetId: string;
    clientSecretValueAssetId: string;
  }) {
    return this.database.transaction((client) =>
      this.createCanonicalApplicationUsing(client, input),
    );
  }

  async createCanonicalApplicationUsing(
    client: PoolClient,
    input: {
      identity: string;
      projectId: string;
      environmentId: string;
      baseOrigin: string;
      allowedOrigins: string[];
      clientIdPublicValueId: string;
      clientSecretReferenceId: string;
      clientIdValueAssetId: string;
      clientSecretValueAssetId: string;
    },
  ) {
    if (input.identity !== "vitract-preview-test")
      throw new ConflictException({ code: "Q5_CANONICAL_APPLICATION_ENVIRONMENT_MISMATCH" });
    const result = await client.query<{ id: string }>(
      `INSERT INTO qualification_applications(
         identity,project_id,environment_id,base_origin,allowed_origins,credential_reference_ids,
         typed_value_references
       )
       SELECT $1,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6::jsonb
       WHERE EXISTS (
         SELECT 1 FROM environments
          WHERE id=$3 AND project_id=$2 AND base_origin=$4
            AND policy->'allowedOrigins' @> to_jsonb(ARRAY[$4]::text[])
       )
         AND (
           SELECT count(*)=1 FROM typed_value_assets asset
             JOIN generated_public_values value ON value.id=asset.generated_public_value_id
            WHERE asset.id=$8::uuid AND asset.project_id=$2 AND asset.classification='public'
              AND asset.environment_id=$3 AND asset.state='active'
              AND asset.canonical_output_key='clientId' AND value.reference='clientId'
         ) AND EXISTS (
           SELECT 1 FROM typed_value_assets secret_asset
             JOIN project_credentials credential ON credential.id=secret_asset.project_credential_id
             JOIN typed_value_assets client_asset ON client_asset.id=$8::uuid
             JOIN protected_operations issuance
               ON issuance.id=client_asset.producer_protected_operation_id
              AND issuance.id=secret_asset.producer_protected_operation_id
            WHERE secret_asset.id=$7::uuid AND secret_asset.project_id=$2
              AND secret_asset.environment_id=$3 AND secret_asset.state='active'
              AND secret_asset.classification='protected'
              AND secret_asset.canonical_output_key='clientSecret'
              AND credential.deleted_at IS NULL AND credential.security_status='active'
              AND issuance.project_id=$2 AND issuance.environment_id=$3
              AND issuance.state='completed' AND issuance.persistence_state='committed'
              AND issuance.authority_model='canonical'
              AND issuance.mutation_outcome='applied'
         )
       ON CONFLICT DO NOTHING
       RETURNING id::text`,
      [
        input.identity,
        input.projectId,
        input.environmentId,
        input.baseOrigin,
        JSON.stringify(input.allowedOrigins),
        JSON.stringify({
          clientId: { kind: "generated_safe", valueAssetId: input.clientIdValueAssetId },
          clientSecret: {
            kind: "generated_protected",
            valueAssetId: input.clientSecretValueAssetId,
          },
        }),
        input.clientSecretValueAssetId,
        input.clientIdValueAssetId,
      ],
    );
    if (result.rowCount) return result.rows[0]!.id;
    const existing = await client.query<{ id: string }>(
      `SELECT id::text FROM qualification_applications
        WHERE identity=$1 AND project_id=$2 AND environment_id=$3 AND base_origin=$4
          AND allowed_origins=$5::jsonb
          AND typed_value_references=$6::jsonb AND credential_reference_ids='[]'::jsonb
          AND status='active'`,
      [
        input.identity,
        input.projectId,
        input.environmentId,
        input.baseOrigin,
        JSON.stringify(input.allowedOrigins),
        JSON.stringify({
          clientId: { kind: "generated_safe", valueAssetId: input.clientIdValueAssetId },
          clientSecret: {
            kind: "generated_protected",
            valueAssetId: input.clientSecretValueAssetId,
          },
        }),
      ],
    );
    if (existing.rowCount) return existing.rows[0]!.id;
    throw new ConflictException({ code: "Q5_CANONICAL_APPLICATION_ENVIRONMENT_MISMATCH" });
  }

  async prepare(input: PrepareQ5AuthoritativeAttemptInput) {
    return this.database.transaction((client) => this.prepareUsing(client, input));
  }

  async prepareUsing(client: PoolClient, input: PrepareQ5AuthoritativeAttemptInput) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('m6-q5-authoritative'))`);
    const existing = await this.scopeQuery(client, `attempt.qualification_key=$1`, [
      "m6-q5-authoritative",
    ]);
    if (existing) {
      const exact =
        existing.state === "prepared" &&
        existing.preparedScopeId === input.preparedScopeId &&
        existing.campaignId === input.campaignId &&
        existing.canonicalApplicationId === input.canonicalApplicationId &&
        existing.externalRunId === input.externalRunId &&
        existing.flowDraftId === input.flowDraftId &&
        existing.flowRevisionId === input.flowRevisionId &&
        existing.sourceCommit === input.sourceCommit &&
        existing.sourceManifest === input.sourceManifest &&
        existing.schemaFingerprint === input.schemaFingerprint &&
        existing.migrationDigest === input.migrationDigest &&
        existing.provider === input.provider &&
        existing.model === input.model;
      if (!exact) throw new ConflictException({ code: "Q5_AUTHORITATIVE_ATTEMPT_ALREADY_EXISTS" });
      return { attempt: existing, replayed: true } as const;
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO q5_authoritative_attempts(
           qualification_key,campaign_authorization_id,prepared_scope_id,canonical_application_id,external_run_id,
           flow_draft_id,flow_revision_id,credential_digest,source_commit,source_manifest,
           source_dirty,schema_fingerprint,migration_digest,provider,model
         )
         SELECT 'm6-q5-authoritative',$1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,$12,$13
          FROM qualification_campaign_authorizations campaign
          JOIN q5_prepared_scopes prepared ON prepared.id=$2 AND prepared.state='prepared'
          JOIN qualification_applications application ON application.id=$3
         WHERE campaign.id=$1 AND campaign.canonical_application_id=application.id
           AND prepared.project_id=campaign.project_id AND prepared.environment_id=campaign.environment_id
           AND prepared.application_identity=application.identity
           AND prepared.target_origin=campaign.target_origin
           AND prepared.source_commit=$8 AND prepared.source_manifest=$9
           AND prepared.schema_fingerprint=$10 AND prepared.migration_identity=$11
           AND prepared.q5_mcp_profile=$21 AND prepared.q5_mcp_contract_digest=$22
           AND prepared.client_id_value_asset_id::text=application.typed_value_references->'clientId'->>'valueAssetId'
           AND prepared.client_secret_value_asset_id::text=application.typed_value_references->'clientSecret'->>'valueAssetId'
           AND campaign.project_id=$14 AND campaign.environment_id=$15
           AND campaign.mission_id=$16 AND campaign.objective_id=$17
           AND campaign.agent_session_id=$18 AND campaign.target_origin=$19
           AND campaign.application_identity=$20 AND campaign.disposition='authorized'
           AND campaign.runs_consumed=0 AND campaign.business_mutation_dispatches_consumed=0
           AND application.status='active'
         RETURNING id::text`,
      [
        input.campaignId,
        input.preparedScopeId,
        input.canonicalApplicationId,
        input.externalRunId,
        input.flowDraftId,
        input.flowRevisionId,
        input.credentialDigest,
        input.sourceCommit,
        input.sourceManifest,
        input.schemaFingerprint,
        input.migrationDigest,
        input.provider,
        input.model,
        input.projectId,
        input.environmentId,
        input.missionId,
        input.objectiveId,
        input.agentSessionId,
        input.targetOrigin,
        input.applicationIdentity,
        Q5_MCP_PROFILE,
        Q5_MCP_CONTRACT_DIGEST,
      ],
    );
    if (!inserted.rowCount)
      throw new ConflictException({ code: "Q5_AUTHORITATIVE_ATTEMPT_SCOPE_MISMATCH" });
    return {
      attempt: (await this.scopeQuery(client, `attempt.id=$1`, [inserted.rows[0]!.id]))!,
      replayed: false,
    } as const;
  }

  scopeForCredential(credentialDigest: string, externalRunId: string) {
    return this.database.transaction(async (client) => {
      const scope = await this.scopeQuery(
        client,
        `attempt.credential_digest=$1 AND attempt.external_run_id=$2`,
        [credentialDigest, externalRunId],
      );
      if (!scope) throw new NotFoundException({ code: "Q5_SCOPED_CREDENTIAL_INVALID" });
      if (scope.state !== "consumed")
        throw new ConflictException({ code: "Q5_AUTHORITATIVE_ATTEMPT_TERMINAL" });
      return scope;
    });
  }

  async consume(attemptId: string, credentialDigest: string) {
    return this.database.transaction((client) =>
      this.consumeUsing(client, attemptId, credentialDigest),
    );
  }

  async consumeUsing(client: PoolClient, attemptId: string, credentialDigest: string) {
    const result = await client.query<{ id: string }>(
      `UPDATE q5_authoritative_attempts attempt
          SET state='consumed',consumed_at=now(),updated_at=now()
         FROM qualification_campaign_authorizations campaign,
              q5_prepared_scopes prepared,
              q5_canonical_scope_designations designation,
              qualification_applications application,
              generated_public_values client_id,
              project_credentials client_secret,
              typed_value_assets client_id_asset,
              typed_value_assets client_secret_asset,
              protected_operations issuance,

              environments environment
        WHERE attempt.id=$1 AND attempt.credential_digest=$2 AND attempt.state='prepared'
          AND campaign.id=attempt.campaign_authorization_id
          AND campaign.disposition='authorized' AND campaign.expires_at>now()
          AND campaign.runs_consumed=0 AND campaign.business_mutation_dispatches_consumed=0
          AND prepared.id=attempt.prepared_scope_id AND prepared.state='prepared'
          AND prepared.source_commit=attempt.source_commit
          AND prepared.source_manifest=attempt.source_manifest
          AND prepared.schema_fingerprint=attempt.schema_fingerprint
          AND prepared.migration_identity=attempt.migration_digest
          AND prepared.q5_mcp_profile=$3 AND prepared.q5_mcp_contract_digest=$4
          AND designation.qualification_key=prepared.qualification_key
          AND designation.project_id=prepared.project_id
          AND designation.environment_id=prepared.environment_id
          AND designation.application_identity=prepared.application_identity
          AND application.id=attempt.canonical_application_id AND application.status='active'
          AND application.identity=prepared.application_identity
          AND application.project_id=prepared.project_id
          AND application.environment_id=prepared.environment_id
          AND application.typed_value_references->'clientId'->>'valueAssetId'=prepared.client_id_value_asset_id::text
          AND application.typed_value_references->'clientSecret'->>'valueAssetId'=prepared.client_secret_value_asset_id::text
          AND client_id_asset.id=prepared.client_id_value_asset_id
          AND client_secret_asset.id=prepared.client_secret_value_asset_id
          AND client_id_asset.generated_public_value_id=client_id.id
          AND client_secret_asset.project_credential_id=client_secret.id
          AND client_id_asset.state='active' AND client_secret_asset.state='active'
          AND client_id_asset.producer_protected_operation_id=prepared.issuance_operation_id
          AND client_secret_asset.producer_protected_operation_id=prepared.issuance_operation_id
          AND client_id.id=prepared.client_id_public_value_id
          AND client_secret.id=prepared.client_secret_reference_id
          AND client_id.project_id=prepared.project_id
          AND client_secret.project_id=prepared.project_id
          AND client_id.reference='clientId'
          AND client_secret.security_status='active' AND client_secret.deleted_at IS NULL
          AND client_id.source_protected_operation_id=prepared.issuance_operation_id
          AND client_secret.origin_protected_operation_id=prepared.issuance_operation_id
          AND issuance.id=prepared.issuance_operation_id
          AND issuance.project_id=prepared.project_id
          AND issuance.environment_id=prepared.environment_id
          AND issuance.state='completed' AND issuance.persistence_state='committed'
          AND issuance.authority_model='canonical'
          AND issuance.mutation_outcome='applied'
          AND issuance.persisted_references->'clientId'->>'valueId'=client_id.id::text
          AND issuance.persisted_references->'clientSecret'->>'credentialId'=client_secret.id::text
          AND environment.id=prepared.environment_id AND environment.project_id=prepared.project_id
        RETURNING attempt.id::text`,
      [attemptId, credentialDigest, Q5_MCP_PROFILE, Q5_MCP_CONTRACT_DIGEST],
    );
    if (!result.rowCount)
      throw new ConflictException({ code: "Q5_AUTHORITATIVE_ATTEMPT_CONSUMED" });
    return { id: result.rows[0]!.id, state: "consumed" as const };
  }

  async recordProviderRequest(attemptId: string) {
    const result = await this.database.query<{ providerRequestCount: number }>(
      `UPDATE q5_authoritative_attempts
          SET provider_request_count=provider_request_count+1,updated_at=now()
        WHERE id=$1 AND state='consumed'
        RETURNING provider_request_count AS "providerRequestCount"`,
      [attemptId],
    );
    if (!result.rowCount)
      throw new ConflictException({ code: "Q5_PROVIDER_REQUEST_OUTSIDE_CONSUMED_ATTEMPT" });
    return result.rows[0]!;
  }

  async settle(
    attemptId: string,
    state: "succeeded" | "failed" | "inconclusive" | "cancelled",
    evidenceManifestDigest?: string,
  ) {
    if ((state === "succeeded") !== Boolean(evidenceManifestDigest))
      throw new ConflictException({ code: "Q5_EVIDENCE_DIGEST_STATE_MISMATCH" });
    const result = await this.database.query<{ id: string; state: string }>(
      `UPDATE q5_authoritative_attempts
          SET state=$2,evidence_manifest_digest=$3,terminal_at=now(),updated_at=now()
        WHERE id=$1 AND state='consumed'
        RETURNING id::text,state`,
      [attemptId, state, evidenceManifestDigest ?? null],
    );
    if (!result.rowCount)
      throw new ConflictException({ code: "Q5_AUTHORITATIVE_ATTEMPT_NOT_CONSUMED" });
    return result.rows[0]!;
  }

  async evidenceBinding(attemptId: string) {
    const result = await this.database.query<{
      state: string;
      evidenceManifestDigest: string | null;
    }>(
      `SELECT state,evidence_manifest_digest AS "evidenceManifestDigest"
         FROM q5_authoritative_attempts WHERE id=$1`,
      [attemptId],
    );
    if (!result.rowCount)
      throw new NotFoundException({ code: "Q5_AUTHORITATIVE_ATTEMPT_NOT_FOUND" });
    return result.rows[0]!;
  }

  bindRuntime(attemptId: string, input: { runId?: string; praxisSessionId?: string }) {
    if (Boolean(input.runId) === Boolean(input.praxisSessionId))
      throw new ConflictException({ code: "Q5_RUNTIME_BINDING_EXACTLY_ONE_REQUIRED" });
    return this.database.transaction(async (client) => {
      await client.query(`SELECT id FROM q5_authoritative_attempts WHERE id=$1 FOR UPDATE`, [
        attemptId,
      ]);
      const result = input.runId
        ? await client.query(
            `UPDATE q5_authoritative_attempts attempt SET run_id=$2,updated_at=now()
              FROM runs run,qualification_campaign_authorizations campaign
             WHERE attempt.id=$1 AND attempt.state IN ('prepared','consumed')
               AND (attempt.run_id IS NULL OR attempt.run_id=$2)
               AND run.id=$2 AND campaign.id=attempt.campaign_authorization_id
               AND run.qualification_campaign_authorization_id=campaign.id
               AND run.project_id=campaign.project_id AND run.environment_id=campaign.environment_id
               AND run.mission_id=campaign.mission_id AND run.objective_id=campaign.objective_id
               AND run.agent_session_id=campaign.agent_session_id RETURNING attempt.id`,
            [attemptId, input.runId],
          )
        : await client.query(
            `UPDATE q5_authoritative_attempts attempt SET praxis_session_id=COALESCE(attempt.praxis_session_id,$2),updated_at=now()
              FROM adaptive_sessions session,qualification_campaign_authorizations campaign
             WHERE attempt.id=$1 AND attempt.state IN ('prepared','consumed')
               AND session.id=$2 AND campaign.id=attempt.campaign_authorization_id
               AND session.project_id=campaign.project_id AND session.environment_id=campaign.environment_id
               AND session.mission_id=campaign.mission_id AND session.active_objective_id=campaign.objective_id
               AND session.agent_session_id=campaign.agent_session_id
               AND session.state IN ('created','provisioning','active','suspended')
               AND NOT EXISTS (
                 SELECT 1 FROM adaptive_sessions prior
                 WHERE prior.id<>session.id AND prior.state IN ('created','provisioning','active','suspended')
                   AND (prior.id=attempt.praxis_session_id OR prior.id IN (
                     SELECT history.praxis_session_id FROM q5_attempt_praxis_sessions history WHERE history.attempt_id=attempt.id
                   ))
               ) RETURNING attempt.id`,
            [attemptId, input.praxisSessionId],
          );
      if (!result.rowCount) throw new ConflictException({ code: "Q5_RUNTIME_SCOPE_MISMATCH" });
      if (input.praxisSessionId)
        await client.query(
          `INSERT INTO q5_attempt_praxis_sessions(attempt_id,praxis_session_id,epoch)
         SELECT $1,$2,COALESCE(max(epoch),0)+1 FROM q5_attempt_praxis_sessions WHERE attempt_id=$1
         ON CONFLICT(attempt_id,praxis_session_id) DO NOTHING`,
          [attemptId, input.praxisSessionId],
        );
      return { bound: true };
    });
  }

  private async scopeQuery(client: PoolClient, predicate: string, values: unknown[]) {
    const result = await client.query<Q5AttemptScope>(
      `SELECT attempt.id::text AS "attemptId",attempt.state,
              attempt.prepared_scope_id::text AS "preparedScopeId",
              campaign.id::text AS "campaignId",application.id::text AS "canonicalApplicationId",
              application.identity AS "applicationIdentity",campaign.project_id::text AS "projectId",
              campaign.environment_id::text AS "environmentId",campaign.mission_id::text AS "missionId",
              campaign.objective_id::text AS "objectiveId",campaign.agent_session_id::text AS "agentSessionId",
              attempt.external_run_id::text AS "externalRunId",attempt.flow_draft_id::text AS "flowDraftId",
              attempt.flow_revision_id::text AS "flowRevisionId",campaign.target_origin AS "targetOrigin",
              ARRAY(SELECT jsonb_array_elements_text(application.allowed_origins)) AS "allowedOrigins",
              prepared.client_id_public_value_id::text AS "clientIdPublicValueId",
              prepared.client_secret_reference_id::text AS "clientSecretReferenceId",
              application.typed_value_references->'clientId'->>'valueAssetId' AS "clientIdValueAssetId",
              application.typed_value_references->'clientSecret'->>'valueAssetId' AS "clientSecretValueAssetId",
              attempt.run_id::text AS "runId",
              COALESCE((SELECT history.praxis_session_id FROM q5_attempt_praxis_sessions history
                WHERE history.attempt_id=attempt.id ORDER BY epoch DESC LIMIT 1),attempt.praxis_session_id)::text AS "praxisSessionId",
              ARRAY(SELECT DISTINCT id::text FROM (
                SELECT history.praxis_session_id AS id FROM q5_attempt_praxis_sessions history WHERE history.attempt_id=attempt.id
                UNION SELECT attempt.praxis_session_id WHERE attempt.praxis_session_id IS NOT NULL
              ) owners) AS "praxisSessionIds",
              attempt.source_commit AS "sourceCommit",attempt.source_manifest AS "sourceManifest",
              attempt.schema_fingerprint AS "schemaFingerprint",attempt.migration_digest AS "migrationDigest",
              attempt.provider,attempt.model
         FROM q5_authoritative_attempts attempt
         JOIN qualification_campaign_authorizations campaign
           ON campaign.id=attempt.campaign_authorization_id
         JOIN qualification_applications application
           ON application.id=attempt.canonical_application_id
         JOIN q5_prepared_scopes prepared ON prepared.id=attempt.prepared_scope_id
         JOIN environments environment ON environment.id=campaign.environment_id
        WHERE ${predicate}`,
      values,
    );
    return result.rows[0];
  }
}
