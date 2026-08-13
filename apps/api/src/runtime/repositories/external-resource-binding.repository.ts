import { ConflictException, Inject, Injectable } from "@nestjs/common";

import { Database } from "../../infrastructure/index.js";

export type TrustedExternalResourceBinding = {
  sourceProtectedOperationId: string;
  projectId: string;
  environmentId: string;
  provider: string;
  resourceKind: string;
  resourceScope: string;
  externalIdentity: string;
  identityContractVersion: number;
};

@Injectable()
export class ExternalResourceBindingRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async resolveActiveForCredential(input: {
    credentialId: string;
    projectId: string;
    environmentId: string;
    provider: string;
    resourceKind: string;
    resourceScope: string;
  }): Promise<TrustedExternalResourceBinding> {
    const result = await this.database.query<TrustedExternalResourceBinding>(
      `SELECT binding.source_protected_operation_id AS "sourceProtectedOperationId",
              binding.project_id AS "projectId",binding.environment_id AS "environmentId",
              binding.provider,binding.resource_kind AS "resourceKind",
              binding.resource_scope AS "resourceScope",
              binding.canonical_external_identity AS "externalIdentity",
              binding.identity_contract_version AS "identityContractVersion"
         FROM project_credentials credential
         JOIN external_resource_bindings binding
           ON binding.source_protected_operation_id=credential.origin_protected_operation_id
          AND binding.project_id=credential.project_id
         JOIN generated_public_values value
           ON value.id=binding.generated_public_value_id
          AND value.source_protected_operation_id=binding.source_protected_operation_id
          AND value.project_id=binding.project_id
          AND value.value=binding.canonical_external_identity
        WHERE credential.id=$1 AND credential.project_id=$2
          AND credential.security_status='active' AND credential.deleted_at IS NULL
          AND binding.environment_id=$3 AND binding.provider=$4
          AND binding.resource_kind=$5 AND binding.resource_scope=$6
          AND binding.lifecycle_state='active'
          AND binding.required_for_destructive_lifecycle=true`,
      [input.credentialId,input.projectId,input.environmentId,input.provider,
        input.resourceKind,input.resourceScope],
    );
    if (result.rowCount !== 1)
      throw new ConflictException({ code: "EXTERNAL_RESOURCE_BINDING_UNAVAILABLE" });
    return result.rows[0]!;
  }
}
