import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import { Database } from "../../infrastructure/index.js";
import {
  Q5_CANONICAL_SCOPE,
  type Q5CanonicalEnvironment,
  type Q5CanonicalProject,
  type Q5CredentialPair,
  type Q5PreparedScope,
  type Q5ScopeBootstrapStore,
} from "../q5-scope-bootstrap.js";

/** Canonical provisioning command for the local Q5 qualification installation. */
export class Q5ScopeBootstrapRepository implements Q5ScopeBootstrapStore {
  private client: PoolClient | undefined;
  private pendingProjectId: string | undefined;

  constructor(
    private readonly database: Database,
    private readonly workspaceId: string,
  ) {}

  exclusively<T>(qualificationKey: string, operation: () => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `q5-scope-bootstrap:${qualificationKey}`,
      ]);
      this.client = client;
      try {
        return await operation();
      } finally {
        this.client = undefined;
        this.pendingProjectId = undefined;
      }
    });
  }

  async findCanonicalProjects(designation: string): Promise<Q5CanonicalProject[]> {
    const result = await this.query<{ id: string; designation: string }>(
      `SELECT project.id::text,designation.qualification_key AS designation
         FROM q5_canonical_scope_designations designation
         JOIN projects project ON project.id=designation.project_id
        WHERE designation.qualification_key=$1 AND project.workspace_id=$2`,
      [designation, this.workspaceId],
    );
    return result.rows;
  }

  async createCanonicalProject(designation: string): Promise<Q5CanonicalProject> {
    const result = await this.query<{ id: string }>(
      `INSERT INTO projects(workspace_id,name,description)
       VALUES($1,'Scry Q5 Vitract Preview/Test qualification',
         'Canonical generated Project for the authoritative Q5 qualification scope')
       ON CONFLICT(workspace_id,name) DO UPDATE SET updated_at=projects.updated_at
       RETURNING id::text`,
      [this.workspaceId],
    );
    this.pendingProjectId = result.rows[0]!.id;
    return { id: result.rows[0]!.id, designation };
  }

  async findCanonicalEnvironments(projectId: string): Promise<Q5CanonicalEnvironment[]> {
    const result = await this.query<any>(
      `SELECT environment.id::text,environment.project_id::text AS "projectId",
              designation.application_identity AS "applicationIdentity",
              designation.environment_class AS "environmentClass",
              environment.base_origin AS "baseOrigin",environment.policy->'allowedOrigins' AS "allowedOrigins",
              designation.protected_policy AS "protectedPolicy",true AS "qualificationCompatible"
         FROM q5_canonical_scope_designations designation
         JOIN environments environment ON environment.id=designation.environment_id
        WHERE designation.qualification_key=$1 AND designation.project_id=$2`,
      [Q5_CANONICAL_SCOPE.qualificationKey, projectId],
    );
    return result.rows;
  }

  async createCanonicalEnvironment(projectId: string): Promise<Q5CanonicalEnvironment> {
    if (this.pendingProjectId && this.pendingProjectId !== projectId)
      throw new Error("Q5_CANONICAL_PROJECT_TRANSACTION_MISMATCH");
    const policy = {
      allowedOrigins: [...Q5_CANONICAL_SCOPE.allowedOrigins],
      allowPrivateNetwork: false,
      allowDownloads: false,
      allowPopups: false,
      maxActions: 80,
      maxDurationMs: 1_800_000,
      maxNavigations: 20,
    };
    const created = await this.query<{ id: string }>(
      `INSERT INTO environments(project_id,name,base_origin,policy,secret_refs)
       VALUES($1,'Vitract Preview/Test', $2, $3::jsonb, '[]'::jsonb)
       ON CONFLICT(project_id,name) DO UPDATE SET name=environments.name
       RETURNING id::text`,
      [projectId, Q5_CANONICAL_SCOPE.targetOrigin, JSON.stringify(policy)],
    );
    const environmentId = created.rows[0]!.id;
    await this.query(
      `INSERT INTO q5_canonical_scope_designations(
         qualification_key,project_id,environment_id,application_identity,environment_class,
         target_origin,protected_policy,qualification_policy_version
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        Q5_CANONICAL_SCOPE.qualificationKey,
        projectId,
        environmentId,
        Q5_CANONICAL_SCOPE.applicationIdentity,
        Q5_CANONICAL_SCOPE.environmentClass,
        Q5_CANONICAL_SCOPE.targetOrigin,
        Q5_CANONICAL_SCOPE.protectedPolicy,
        Q5_CANONICAL_SCOPE.qualificationPolicyVersion,
      ],
    );
    return {
      id: environmentId,
      projectId,
      applicationIdentity: Q5_CANONICAL_SCOPE.applicationIdentity,
      environmentClass: Q5_CANONICAL_SCOPE.environmentClass,
      baseOrigin: Q5_CANONICAL_SCOPE.targetOrigin,
      allowedOrigins: Q5_CANONICAL_SCOPE.allowedOrigins,
      protectedPolicy: Q5_CANONICAL_SCOPE.protectedPolicy,
      qualificationCompatible: true,
    };
  }

  async findCredentialPairs(projectId: string, environmentId: string): Promise<Q5CredentialPair[]> {
    const result = await this.query<any>(
      `WITH issued AS (
         SELECT operation.id AS issuance_id,operation.project_id,operation.environment_id,
                operation.persisted_references,operation.safe_output_manifest,
                operation.persisted_references->'clientId'->>'valueId' AS client_id,
                operation.persisted_references->'clientSecret'->>'credentialId' AS client_secret
           FROM protected_operations operation
           JOIN observed_operation_contracts contract ON contract.id=operation.observed_operation_contract_id
           JOIN mission_authorizations mission_authority
             ON mission_authority.id=operation.authorization_id
          WHERE operation.project_id=$1 AND operation.environment_id=$2
            AND operation.state='completed' AND operation.persistence_state='committed'
            AND operation.mutation_outcome='applied'
            AND operation.dispatch_state='acknowledged'
            AND contract.operation_key='issuePartnerCredential'
            AND contract.facts->'operation'->>'classification'='mutation'
            AND contract.facts->'resourceEffect'->>'provider'='vitract'
            AND contract.facts->'resourceEffect'->>'resourceKind'='credential_record'
            AND mission_authority.kind='protected_mutation'
            AND mission_authority.status='approved'
            AND mission_authority.revoked_at IS NULL
            AND (mission_authority.expires_at IS NULL OR mission_authority.expires_at>now())
       )
       SELECT encode(digest(issuance_id::text||':'||client_id||':'||client_secret,'sha256'),'hex') AS digest,
              issued.project_id::text AS "projectId",
              issued.environment_id::text AS "environmentId",
              issuance_id::text AS "issuanceOperationId",client_id AS "clientIdPublicValueId",
              client_secret AS "clientSecretReferenceId",
              (safe_output_manifest @> '[{"key":"clientId","classification":"public"}]'::jsonb
                OR safe_output_manifest @> '[{"reference":"clientId","classification":"public"}]'::jsonb)
                AND (safe_output_manifest @> '[{"key":"clientSecret","classification":"protected"}]'::jsonb
                  OR safe_output_manifest @> '[{"reference":"clientSecret","classification":"protected"}]'::jsonb)
                AND client_id_value.source_protected_operation_id=issuance_id
                AND client_secret_credential.origin_protected_operation_id=issuance_id
                AS atomic
         FROM issued
         JOIN generated_public_values client_id_value
          ON client_id_value.id::text=issued.client_id
          AND client_id_value.project_id=issued.project_id
          AND client_id_value.reference='clientId'
         JOIN project_credentials client_secret_credential
           ON client_secret_credential.id::text=issued.client_secret
          AND client_secret_credential.project_id=issued.project_id
          AND client_secret_credential.security_status='active' AND client_secret_credential.deleted_at IS NULL
         JOIN external_resource_bindings resource_binding
           ON resource_binding.source_protected_operation_id=issued.issuance_id
          AND resource_binding.project_id=issued.project_id
          AND resource_binding.environment_id=issued.environment_id
          AND resource_binding.provider='vitract'
          AND resource_binding.resource_kind='credential_record'
          AND resource_binding.lifecycle_state='active'
          AND resource_binding.generated_public_value_id::text=
                issued.persisted_references->'credentialRecordId'->>'valueId'
        WHERE client_id IS NOT NULL AND client_secret IS NOT NULL`,
      [projectId, environmentId],
    );
    return result.rows
      .filter((row: any) => row.atomic === true)
      .map((row: any) => ({
        pairReferenceId: uuidFromDigest(row.digest),
        projectId: row.projectId,
        environmentId: row.environmentId,
        applicationIdentity: Q5_CANONICAL_SCOPE.applicationIdentity,
        issuanceOperationId: row.issuanceOperationId,
        clientIdPublicValueId: row.clientIdPublicValueId,
        clientSecretReferenceId: row.clientSecretReferenceId,
        clientIdentityClass: "generated_safe",
        clientSecretClass: "protected_reference",
        credentialType: Q5_CANONICAL_SCOPE.credentialType,
        protectedPolicy: Q5_CANONICAL_SCOPE.protectedPolicy,
        provenance: "supported_protected_issuance",
        issuanceState: "completed",
        persistenceState: "committed",
        atomic: true,
        active: true,
        revoked: false,
        expiresAt: null,
        privacySealed: true,
        exactConsumerBindingSupported: true,
      }));
  }

  async freezePreparedScope(
    input: Omit<Q5PreparedScope, "id" | "state">,
  ): Promise<Q5PreparedScope> {
    const result = await this.query<{ id: string }>(
      `INSERT INTO q5_prepared_scopes(
         qualification_key,project_id,environment_id,application_identity,environment_class,
         target_origin,allowed_origins,credential_pair_reference_id,client_id_public_value_id,
         client_secret_reference_id,issuance_operation_id,credential_type,protected_policy,
         credential_provenance,source_commit,source_manifest,schema_fingerprint,migration_identity,
         q5_mcp_profile,q5_mcp_contract_digest,qualification_policy_version,binding_digest
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT(qualification_key) DO NOTHING RETURNING id::text`,
      [
        Q5_CANONICAL_SCOPE.qualificationKey,
        input.projectId,
        input.environmentId,
        input.applicationIdentity,
        input.environmentClass,
        input.targetOrigin,
        JSON.stringify(input.allowedOrigins),
        input.credentialPairReferenceId,
        input.clientIdPublicValueId,
        input.clientSecretReferenceId,
        input.issuanceOperationId,
        input.credentialType,
        input.protectedPolicy,
        input.credentialProvenance,
        input.sourceCommit,
        input.sourceManifest,
        input.schemaFingerprint,
        input.migrationIdentity,
        input.q5McpProfile,
        input.q5McpContractDigest,
        input.qualificationPolicyVersion,
        input.bindingDigest,
      ],
    );
    if (!result.rowCount) throw new Error("Q5_PREPARED_SCOPE_ALREADY_EXISTS");
    return { ...input, id: result.rows[0]!.id, state: "prepared" };
  }

  private query<T extends QueryResultRow = any>(text: string, values?: unknown[]) {
    if (!this.client) throw new Error("Q5_SCOPE_BOOTSTRAP_TRANSACTION_REQUIRED");
    return this.client.query<T>(text, values);
  }
}

function uuidFromDigest(value: string) {
  const digest = /^[a-f0-9]{64}$/.test(value)
    ? value
    : createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
