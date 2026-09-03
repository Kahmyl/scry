import { createHash, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import { SyntheticInputGeneratorRegistry } from "../synthetic-input-generator.registry.js";
import {
  executionPolicyAllowsProtectedSyntheticInput,
  type ExecutionPolicy,
} from "@scry/contracts";
import { decryptCredential, encryptCredential } from "../../access/index.js";
import { Database } from "../../infrastructure/index.js";
import type { QueryResult, QueryResultRow } from "pg";

export type SyntheticProtectedInputDeclaration = Readonly<{
  semantic: string;
  generatorContract:
    | "reserved_test_email"
    | "synthetic_person_name"
    | "sandbox_shipping_address_json"
    | "opaque_operation_token"
    | "nested_client_order_json";
  generatorVersion: 1;
  purpose: "test_order_qualification";
}>;
type Owner = { protectedOperationId: string; projectId: string; environmentId: string };
type MaterializeInput = Owner & {
  declaration: SyntheticProtectedInputDeclaration;
  policy: ExecutionPolicy;
  resourceKind: string;
  operation: string;
};

@Injectable()
export class OperationBoundProtectedInputRepository {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Optional()
    @Inject(SyntheticInputGeneratorRegistry)
    private readonly generators = new SyntheticInputGeneratorRegistry(),
  ) {}

  async materialize(input: MaterializeInput) {
    return this.database.transaction((client) => this.materializeUsing(client, input));
  }

  async materializeUsing(
    client: {
      query<T extends QueryResultRow = any>(
        sql: string,
        values?: unknown[],
      ): Promise<QueryResult<T>>;
    },
    input: MaterializeInput,
  ) {
    if (
      !executionPolicyAllowsProtectedSyntheticInput(input.policy, {
        contract: input.declaration.generatorContract,
        version: input.declaration.generatorVersion,
        purpose: input.declaration.purpose,
        resourceKind: input.resourceKind,
        operation: input.operation,
      })
    )
      throw new ConflictException("SYNTHETIC_PROTECTED_INPUT_POLICY_DENIED");
    const value = this.generators.generate(input.declaration);
    const encrypted = encryptCredential(value);
    const commitment = createHash("sha256").update(value).digest("hex");
    const owner = await client.query<{ projectId: string; environmentId: string; state: string }>(
      `SELECT project_id AS "projectId",environment_id AS "environmentId",state FROM protected_operations WHERE id=$1 FOR UPDATE`,
      [input.protectedOperationId],
    );
    const operation = owner.rows[0];
    if (
      !operation ||
      operation.projectId !== input.projectId ||
      operation.environmentId !== input.environmentId
    )
      throw new ConflictException("SYNTHETIC_PROTECTED_INPUT_OWNER_MISMATCH");
    if (operation.state !== "reserved")
      throw new ConflictException("SYNTHETIC_PROTECTED_INPUT_OPERATION_NOT_RESERVED");
    await client.query(
      `INSERT INTO operation_bound_protected_inputs(id,protected_operation_id,project_id,environment_id,semantic,generator_contract,generator_version,purpose,ciphertext,initialization_vector,authentication_tag,lifecycle,commitment)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
         ON CONFLICT(protected_operation_id,semantic) DO NOTHING`,
      [
        randomUUID(),
        input.protectedOperationId,
        input.projectId,
        input.environmentId,
        input.declaration.semantic,
        input.declaration.generatorContract,
        input.declaration.generatorVersion,
        input.declaration.purpose,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        commitment,
      ],
    );
    const authoritative = await client.query<{ id: string }>(
      `SELECT id FROM operation_bound_protected_inputs WHERE protected_operation_id=$1 AND semantic=$2 AND lifecycle='active'
           AND generator_contract=$3 AND generator_version=$4 AND purpose=$5`,
      [
        input.protectedOperationId,
        input.declaration.semantic,
        input.declaration.generatorContract,
        input.declaration.generatorVersion,
        input.declaration.purpose,
      ],
    );
    if (!authoritative.rowCount)
      throw new ConflictException("SYNTHETIC_PROTECTED_INPUT_DECLARATION_CONFLICT");
    return { referenceId: authoritative.rows[0]!.id };
  }

  async resolve(input: Owner & { operationId: string; referenceId: string }) {
    const result = await this.database.query<any>(
      `SELECT operation.operation_id AS "operationId",source.project_id AS "projectId",source.environment_id AS "environmentId",
              source.ciphertext,source.initialization_vector AS "initializationVector",source.authentication_tag AS "authenticationTag"
       FROM operation_bound_protected_inputs source JOIN protected_operations operation ON operation.id=source.protected_operation_id
       WHERE source.id=$1 AND source.protected_operation_id=$2 AND source.lifecycle='active'
         AND operation.state IN ('reserved','planned','preparing','ready_to_dispatch')`,
      [input.referenceId, input.protectedOperationId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.operationId !== input.operationId ||
      row.projectId !== input.projectId ||
      row.environmentId !== input.environmentId
    )
      throw new ConflictException("SYNTHETIC_PROTECTED_INPUT_UNAVAILABLE");
    return decryptCredential({
      ciphertext: Buffer.from(row.ciphertext, "base64"),
      initializationVector: Buffer.from(row.initializationVector, "base64"),
      authenticationTag: Buffer.from(row.authenticationTag, "base64"),
    });
  }

  destroyForTerminalOperation(protectedOperationId: string) {
    return this.database.query(
      `UPDATE operation_bound_protected_inputs SET ciphertext=NULL,initialization_vector=NULL,authentication_tag=NULL,lifecycle='destroyed',destroyed_at=now()
       WHERE protected_operation_id=$1 AND lifecycle='active'`,
      [protectedOperationId],
    );
  }
}
