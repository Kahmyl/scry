import { createHash, randomUUID } from "node:crypto";

import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  observedOperationContractSchema,
  reservePreparedProtectedOperationSchema,
  resumePreparedProtectedOperationSchema,
  type ObservedOperationContract,
  type PreparedOperationValueBinding,
  type ReservePreparedProtectedOperationInput,
  type ResumePreparedProtectedOperationInput,
  type ClaimMissionOperationContinuationInput,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";

@Injectable()
export class PreparedProtectedOperationRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async recordObservedContracts(contracts: ObservedOperationContract[]) {
    const canonical: ObservedOperationContract[] = [];
    for (const candidate of contracts) {
      const contract = observedOperationContractSchema.parse(candidate);
      const facts = {
        operation: contract.operation,
        inputs: contract.inputs,
        auth: contract.auth,
        response: contract.response,
        ...(contract.retrieval ? { retrieval: contract.retrieval } : {}),
        ...(contract.resourceEffect ? { resourceEffect: contract.resourceEffect } : {}),
      };
      const expectedDigest = digest({
        praxisSessionId: contract.praxisSessionId,
        documentEpoch: contract.documentEpoch,
        origin: contract.origin,
        sourceKind: contract.sourceKind,
        observationId: contract.observationId,
        facts,
      });
      if (expectedDigest !== contract.digest)
        throw new ConflictException({ code: "OBSERVED_OPERATION_CONTRACT_DIGEST_MISMATCH" });
      const result = await this.database.query<{ id: string }>(
        `INSERT INTO observed_operation_contracts(
           id,praxis_session_id,document_epoch,origin,source_kind,observation_id,
           operation_key,facts,digest
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT(praxis_session_id,document_epoch,digest) DO NOTHING
         RETURNING id`,
        [
          contract.id,
          contract.praxisSessionId,
          contract.documentEpoch,
          contract.origin,
          contract.sourceKind,
          contract.observationId,
          contract.operation.key,
          JSON.stringify(facts),
          contract.digest,
        ],
      );
      const id =
        result.rows[0]?.id ??
        (
          await this.database.query<{ id: string }>(
            `SELECT id FROM observed_operation_contracts
             WHERE praxis_session_id=$1 AND document_epoch=$2 AND digest=$3`,
            [contract.praxisSessionId, contract.documentEpoch, contract.digest],
          )
        ).rows[0]?.id;
      if (!id)
        throw new ConflictException({ code: "OBSERVED_OPERATION_CONTRACT_PERSISTENCE_RACE" });
      canonical.push({ ...contract, id });
    }
    return canonical;
  }

  async reserve(raw: ReservePreparedProtectedOperationInput) {
    const input = reservePreparedProtectedOperationSchema.parse(raw);
    return this.database.transaction(async (client) => {
      const authority = await client.query<{
        flowDraftId: string;
        ownerId: string;
        fencingToken: number;
        contractId: string;
        contractFacts: ObservedOperationContract;
      }>(
        `SELECT session.flow_draft_id AS "flowDraftId",lease.owner_id AS "ownerId",
                lease.fencing_token AS "fencingToken",contract.id AS "contractId",
                contract.facts AS "contractFacts"
         FROM adaptive_sessions session
         JOIN adaptive_session_runtime_leases lease ON lease.session_id=session.id
           AND lease.lease_expires_at>now()
         JOIN observed_operation_contracts contract
           ON contract.id=$7 AND contract.digest=$8 AND contract.praxis_session_id=session.id
          AND contract.document_epoch=$9
         WHERE session.id=$6 AND session.project_id=$1 AND session.environment_id=$2
           AND session.mission_id=$3 AND session.active_objective_id=$4
           AND session.agent_session_id=$5 AND session.protection='protected'
           AND session.state='active'
         FOR SHARE OF session,lease,contract`,
        [
          input.projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          input.praxisSessionId,
          input.observedOperationContractId,
          input.observedOperationContractDigest,
          input.documentEpoch,
        ],
      );
      if (!authority.rowCount)
        throw new ConflictException({ code: "PREPARED_OPERATION_RUNTIME_AUTHORITY_INVALID" });
      if (new Date(input.expiresAt).getTime() <= Date.now())
        throw new ConflictException({ code: "PREPARED_OPERATION_ALREADY_EXPIRED" });
      const protectedOperationId = randomUUID();
      const owner = authority.rows[0]!;
      const contractInputs = new Map(owner.contractFacts.inputs.map((value) => [value.key, value]));
      const valueKeys = input.values.map((value) => value.canonicalFieldKey);
      if (
        new Set(valueKeys).size !== valueKeys.length ||
        owner.contractFacts.inputs.some(
          (field) => field.required && !valueKeys.includes(field.key),
        ) ||
        input.values.some((value) => {
          const field = contractInputs.get(value.canonicalFieldKey);
          if (!field || !field.acceptedPresentations.includes(value.presentationClass)) return true;
          if (field.controlReference && field.controlReference !== value.targetReference)
            return true;
          const actualClass = ["protected_reference", "synthetic_protected"].includes(
            value.source.kind,
          )
            ? "protected"
            : value.source.kind === "generated_safe"
              ? "generated_safe"
              : "public";
          return actualClass !== field.classification;
        }) ||
        input.expectedOutputs.some((output) => {
          const declared = owner.contractFacts.response.safeOutputs.find(
            (candidate) => candidate.key === output.key,
          );
          return !declared || declared.classification !== output.classification;
        })
      )
        throw new ConflictException({ code: "PREPARED_OPERATION_CONTRACT_SELECTION_INVALID" });
      const canonicalValues = [...input.values].sort((left, right) =>
        left.canonicalFieldKey.localeCompare(right.canonicalFieldKey),
      );
      if (
        digest(
          canonicalValues.map((value) => ({
            key: value.canonicalFieldKey,
            targetReference: value.targetReference,
          })),
        ) !== input.targetCommitment ||
        digest(
          canonicalValues.map((value) => ({
            key: value.canonicalFieldKey,
            presentationClass: value.presentationClass,
            sourceCommitment: digest(value.source),
          })),
        ) !== input.inputCommitment ||
        digest(
          [...input.expectedOutputs].sort((left, right) => left.key.localeCompare(right.key)),
        ) !== input.outputCommitment
      )
        throw new ConflictException({ code: "PREPARED_OPERATION_COMMITMENT_MISMATCH" });
      const inserted = await client.query(
        `INSERT INTO protected_operations(
           id,operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,
           environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,
           authorization_id,program_digest,state,phase,safe_output_manifest,praxis_session_id,
           runtime_owner_id,runtime_fencing_epoch,document_epoch,observed_operation_contract_id,
           observed_operation_contract_digest,target_commitment,input_commitment,output_commitment,
           reservation_expires_at
         ) VALUES($1,$2,$3,'authoring_session',$4,$5,$6,$7,$8,$9,$10,
           NULL,NULL,'reserved','reserved',$20::jsonb,$4,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          protectedOperationId,
          input.publicOperationId,
          `prepared:${digest(input.publicOperationId).slice(0, 32)}`,
          input.praxisSessionId,
          input.projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          owner.flowDraftId,
          owner.ownerId,
          owner.fencingToken,
          input.documentEpoch,
          owner.contractId,
          input.observedOperationContractDigest,
          input.targetCommitment,
          input.inputCommitment,
          input.outputCommitment,
          input.expiresAt,
          JSON.stringify(input.expectedOutputs),
        ],
      );
      if (!inserted.rowCount)
        throw new ConflictException({ code: "PREPARED_OPERATION_ID_ALREADY_RESERVED" });
      for (const value of input.values) {
        await this.insertValueBinding(client, {
          protectedOperationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          ownerFencingEpoch: owner.fencingToken,
          expiresAt: input.expiresAt,
          value,
        });
      }
      await client.query(
        `INSERT INTO protected_operation_transitions(
           protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics
         ) VALUES($1,1,NULL,'reserved','reserved',$2,'{}'::jsonb)`,
        [protectedOperationId, owner.fencingToken],
      );
      return {
        protectedOperationId,
        publicOperationId: input.publicOperationId,
        state: "reserved" as const,
        contractDigest: input.observedOperationContractDigest,
        authorizationRequired: true as const,
        expiresAt: input.expiresAt,
        authorization: {
          missionId: input.missionId,
          objectiveId: input.objectiveId,
          environmentId: input.environmentId,
          agentSessionId: input.agentSessionId,
          praxisSessionId: input.praxisSessionId,
          protectedOperationId,
          publicOperationId: input.publicOperationId,
          operationLabel: owner.contractFacts.operation.label,
          method: owner.contractFacts.operation.method,
          targetClass: owner.contractFacts.operation.classification,
          contractDigest: input.observedOperationContractDigest,
          expiresAt: input.expiresAt,
        },
      };
    });
  }

  async abandonReservedForSession(praxisSessionId: string) {
    return this.database.transaction(async (client) => {
      const abandoned = await client.query<{ id: string; fencingToken: number }>(
        `UPDATE protected_operations
            SET state='abandoned',phase='abandoned_before_authorization',version=version+1,
                program_digest=encode(digest(concat_ws('|','abandoned-preauthorization-v1',
                  target_commitment,input_commitment,output_commitment),'sha256'),'hex'),
                mutation_outcome='not_applied',failure_code='PREPARED_OPERATION_ABANDONED',
                recovery_class='do_not_retry',completed_at=now(),updated_at=now(),
                safe_diagnostics=jsonb_build_object('dispatchAttempted',false)
          WHERE praxis_session_id=$1 AND state='reserved' AND authorization_id IS NULL
            AND dispatch_state='not_started'
        RETURNING id,runtime_fencing_epoch AS "fencingToken"`,
        [praxisSessionId],
      );
      for (const operation of abandoned.rows) {
        await client.query(
          `UPDATE operation_value_bindings
              SET state='revoked',revoked_at=now()
            WHERE consumer_protected_operation_id=$1 AND state='active'`,
          [operation.id],
        );
        await client.query(
          `INSERT INTO protected_operation_transitions(
             protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics
           ) SELECT $1,COALESCE(max(sequence),0)+1,'reserved','abandoned',
                    'abandoned_before_authorization',$2,jsonb_build_object('dispatchAttempted',false)
               FROM protected_operation_transitions WHERE protected_operation_id=$1`,
          [operation.id, operation.fencingToken],
        );
      }
      return { abandoned: abandoned.rows.map((operation) => operation.id) };
    });
  }

  async assertResumable(raw: ResumePreparedProtectedOperationInput) {
    const input = resumePreparedProtectedOperationSchema.parse(raw);
    const result = await this.database.query<{
      authorizationId: string;
      state: "planned" | "preparing" | "ready_to_dispatch";
      operationContractId: string;
      documentEpoch: number;
    }>(
      `SELECT operation.authorization_id AS "authorizationId",operation.state,
              operation.observed_operation_contract_id AS "operationContractId",
              operation.document_epoch AS "documentEpoch"
       FROM protected_operations operation
       JOIN adaptive_session_runtime_leases lease ON lease.session_id=operation.praxis_session_id
         AND lease.owner_id=operation.runtime_owner_id
         AND lease.fencing_token=operation.runtime_fencing_epoch
         AND lease.lease_expires_at>now()
       JOIN mission_authorizations authority ON authority.id=operation.authorization_id
         AND authority.protected_operation_id=operation.id
         AND authority.operation_id=operation.operation_id
         AND authority.praxis_session_id=operation.praxis_session_id
         AND authority.protected_operation_contract_digest=operation.observed_operation_contract_digest
         AND authority.status='approved' AND authority.expires_at>now()
       WHERE operation.id=$1 AND operation.operation_id=$2 AND operation.praxis_session_id=$3
         AND operation.observed_operation_contract_digest=$4
         AND operation.target_commitment=$5 AND operation.input_commitment=$6
         AND operation.output_commitment=$7 AND operation.reservation_expires_at>now()
         AND operation.state IN ('planned','preparing','ready_to_dispatch')`,
      [
        input.protectedOperationId,
        input.publicOperationId,
        input.praxisSessionId,
        input.observedOperationContractDigest,
        input.targetCommitment,
        input.inputCommitment,
        input.outputCommitment,
      ],
    );
    if (!result.rowCount)
      throw new ConflictException({ code: "PREPARED_OPERATION_RESUME_AUTHORITY_INVALID" });
    return {
      ...result.rows[0]!,
      protectedOperationId: input.protectedOperationId,
      publicOperationId: input.publicOperationId,
      praxisSessionId: input.praxisSessionId,
    };
  }

  async executionMaterial(raw: ResumePreparedProtectedOperationInput) {
    const input = resumePreparedProtectedOperationSchema.parse(raw);
    await this.assertResumable(input);
    const result = await this.database.query<{
      protectedOperationId: string;
      publicOperationId: string;
      projectId: string;
      environmentId: string;
      missionId: string;
      objectiveId: string;
      agentSessionId: string;
      praxisSessionId: string;
      flowDraftId: string;
      authorizationId: string;
      contractFacts: ObservedOperationContract;
      documentEpoch: number;
      origin: string;
      values: Array<{
        canonicalFieldKey: string;
        targetReference: string;
        presentationClass: "plain_text" | "protected_text" | "json_public" | "json_protected";
        sourceKind:
          | "literal_public"
          | "stored_public"
          | "protected_reference"
          | "generated_safe"
          | "synthetic_protected";
        sourceReferenceId: string | null;
        publicValue: string | null;
        storedPublicValue: string | null;
      }>;
      expectedOutputs: Array<{
        key: string;
        classification: "public" | "protected";
      }>;
    }>(
      `SELECT operation.id AS "protectedOperationId",operation.operation_id AS "publicOperationId",
              operation.project_id AS "projectId",operation.environment_id AS "environmentId",
              operation.mission_id AS "missionId",operation.objective_id AS "objectiveId",
              operation.agent_session_id AS "agentSessionId",operation.praxis_session_id AS "praxisSessionId",
              operation.flow_draft_id AS "flowDraftId",operation.authorization_id AS "authorizationId",
              contract.facts AS "contractFacts",operation.document_epoch AS "documentEpoch",
              contract.origin,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'canonicalFieldKey',binding.canonical_field_key,
                  'targetReference',binding.target_reference,
                  'presentationClass',binding.presentation_class,
                  'sourceKind',binding.source_kind,
                  'sourceReferenceId',binding.source_reference_id,
                  'publicValue',binding.public_value,
                  'storedPublicValue',stored.value
                ) ORDER BY binding.canonical_field_key)
                FROM operation_value_bindings binding
                LEFT JOIN generated_public_values stored ON stored.id=binding.source_reference_id
                  AND binding.source_kind IN ('stored_public','generated_safe')
                WHERE binding.consumer_protected_operation_id=operation.id
                  AND binding.state IN ('active','consumed') AND binding.expires_at>now()
                  AND binding.owner_fencing_epoch=operation.runtime_fencing_epoch
              ),'[]'::jsonb) AS values,
              operation.safe_output_manifest AS "expectedOutputs"
       FROM protected_operations operation
       JOIN observed_operation_contracts contract
         ON contract.id=operation.observed_operation_contract_id
        AND contract.digest=operation.observed_operation_contract_digest
       JOIN adaptive_session_runtime_leases lease ON lease.session_id=operation.praxis_session_id
        AND lease.owner_id=operation.runtime_owner_id
        AND lease.fencing_token=operation.runtime_fencing_epoch
        AND lease.lease_expires_at>now()
       WHERE operation.id=$1 AND operation.operation_id=$2 AND operation.praxis_session_id=$3
         AND operation.observed_operation_contract_digest=$4
         AND operation.target_commitment=$5 AND operation.input_commitment=$6
         AND operation.output_commitment=$7 AND operation.state='planned'
       FOR SHARE OF operation,contract,lease`,
      [
        input.protectedOperationId,
        input.publicOperationId,
        input.praxisSessionId,
        input.observedOperationContractDigest,
        input.targetCommitment,
        input.inputCommitment,
        input.outputCommitment,
      ],
    );
    const material = result.rows[0];
    if (!material)
      throw new ConflictException({ code: "PREPARED_OPERATION_EXECUTION_AUTHORITY_INVALID" });
    if (
      material.values.some(
        (value) =>
          ["literal_public", "stored_public", "generated_safe"].includes(value.sourceKind) &&
          value.publicValue === null &&
          value.storedPublicValue === null,
      )
    )
      throw new ConflictException({ code: "PREPARED_OPERATION_PUBLIC_VALUE_UNAVAILABLE" });
    return material;
  }

  async consumeGeneratedBindings(protectedOperationId: string) {
    await this.database.query(
      `UPDATE operation_value_bindings SET use_count=use_count+1,state='consumed',consumed_at=now()
       WHERE consumer_protected_operation_id=$1 AND source_kind='generated_safe'
         AND state='active' AND expires_at>now() AND use_count<max_uses`,
      [protectedOperationId],
    );
  }

  async claimContinuation(praxisSessionId: string, input: ClaimMissionOperationContinuationInput) {
    return this.database.transaction(async (client) => {
      const checkpoint = await client.query<{
        sourceProtectedOperationId: string;
        projectId: string;
        environmentId: string;
        missionId: string;
        objectiveId: string;
        mutationOutcome: "applied" | "unknown";
        persistedReferences: Record<string, { valueId?: string }>;
        permittedContinuations: string[];
        fencingEpoch: number;
        operationClassification: "read_only" | "mutation";
        method: string;
      }>(
        `SELECT checkpoint.source_protected_operation_id AS "sourceProtectedOperationId",
                consumer.project_id AS "projectId",consumer.environment_id AS "environmentId",
                consumer.mission_id AS "missionId",consumer.objective_id AS "objectiveId",
                checkpoint.mutation_outcome AS "mutationOutcome",
                checkpoint.persisted_references AS "persistedReferences",
                checkpoint.permitted_continuations AS "permittedContinuations",
                consumer.runtime_fencing_epoch AS "fencingEpoch",
                contract.facts->'operation'->>'classification' AS "operationClassification",
                contract.facts->'operation'->>'method' AS method
         FROM mission_operation_checkpoints checkpoint
         JOIN protected_operations consumer ON consumer.id=$2
           AND consumer.id<>checkpoint.source_protected_operation_id
           AND consumer.praxis_session_id=$4
           AND consumer.mission_id=checkpoint.mission_id
           AND consumer.objective_id=checkpoint.objective_id
           AND consumer.environment_id=checkpoint.environment_id
           AND consumer.state IN ('reserved','planned')
           AND consumer.dispatch_state='not_started'
           AND consumer.reservation_expires_at>now()
         JOIN adaptive_session_runtime_leases lease
           ON lease.session_id=consumer.praxis_session_id
          AND lease.owner_id=consumer.runtime_owner_id
          AND lease.fencing_token=consumer.runtime_fencing_epoch
          AND lease.lease_expires_at>now()
         JOIN observed_operation_contracts contract
           ON contract.id=consumer.observed_operation_contract_id
          AND contract.digest=consumer.observed_operation_contract_digest
         WHERE checkpoint.id=$1 AND checkpoint.state='available'
           AND $3=ANY(checkpoint.permitted_continuations)
         FOR UPDATE OF checkpoint,consumer,lease`,
        [
          input.checkpointId,
          input.consumerProtectedOperationId,
          input.continuation,
          praxisSessionId,
        ],
      );
      const row = checkpoint.rows[0];
      if (!row) throw new ConflictException({ code: "MISSION_OPERATION_CONTINUATION_UNAVAILABLE" });
      if (
        input.continuation === "read_only_retrieve" &&
        (row.mutationOutcome !== "applied" ||
          row.operationClassification !== "read_only" ||
          row.method !== "GET")
      )
        throw new ConflictException({ code: "MISSION_OPERATION_CONTINUATION_NOT_READ_ONLY" });
      if (input.continuation === "read_only_retrieve") {
        const valueId = row.persistedReferences[input.sourceOutputReference!]?.valueId;
        if (!valueId)
          throw new ConflictException({
            code: "MISSION_OPERATION_CONTINUATION_OUTPUT_UNAVAILABLE",
          });
        const capability = await client.query(
          `SELECT binding.id
           FROM operation_value_bindings binding
           WHERE binding.consumer_protected_operation_id=$1
             AND binding.source_kind='generated_safe'
             AND binding.source_reference_id=$2
             AND binding.producer_protected_operation_id=$3
             AND binding.canonical_field_key=$4
             AND binding.target_reference=$5
             AND binding.presentation_class=$6
             AND binding.owner_fencing_epoch=$7
             AND binding.expires_at=$8::timestamptz
             AND binding.state='active' AND binding.use_count=0
           FOR UPDATE`,
          [
            input.consumerProtectedOperationId,
            valueId,
            row.sourceProtectedOperationId,
            input.canonicalFieldKey,
            input.targetReference,
            input.presentationClass,
            row.fencingEpoch,
            input.expiresAt,
          ],
        );
        if (!capability.rowCount)
          throw new ConflictException({
            code: "MISSION_OPERATION_CONTINUATION_CAPABILITY_MISMATCH",
          });
      }
      const claimed = await client.query(
        `UPDATE mission_operation_checkpoints SET state='claimed',
           claimed_by_protected_operation_id=$2,claimed_at=now()
         WHERE id=$1 AND state='available' RETURNING id`,
        [input.checkpointId, input.consumerProtectedOperationId],
      );
      if (!claimed.rowCount)
        throw new ConflictException({ code: "MISSION_OPERATION_CONTINUATION_RACE_LOST" });
      return {
        checkpointId: input.checkpointId,
        consumerProtectedOperationId: input.consumerProtectedOperationId,
        continuation: input.continuation,
        sourceMutationRepeatable: false as const,
        state: "claimed" as const,
      };
    });
  }

  async listCheckpoints(praxisSessionId: string) {
    const result = await this.database.query(
      `SELECT checkpoint.id,checkpoint.source_protected_operation_id AS "sourceProtectedOperationId",
              checkpoint.mutation_receipt_digest AS "mutationReceiptDigest",
              checkpoint.mutation_outcome AS "mutationOutcome",
              checkpoint.dispatch_acknowledged AS "dispatchAcknowledged",
              checkpoint.persisted_references AS "persistedReferences",
              checkpoint.permitted_continuations AS "permittedContinuations",
              checkpoint.source_mutation_repeatable AS "sourceMutationRepeatable",
              checkpoint.state,checkpoint.created_identity_digest AS "createdIdentityDigest",
              checkpoint.retrieved_identity_digest AS "retrievedIdentityDigest",
              checkpoint.identity_matches AS "identityMatches"
       FROM mission_operation_checkpoints checkpoint
       JOIN protected_operations source ON source.id=checkpoint.source_protected_operation_id
       WHERE source.authoring_session_id=$1
       ORDER BY checkpoint.created_at,checkpoint.id`,
      [praxisSessionId],
    );
    return { checkpoints: result.rows };
  }

  private async insertValueBinding(
    client: { query: (sql: string, values?: unknown[]) => Promise<any> },
    input: {
      protectedOperationId: string;
      projectId: string;
      environmentId: string;
      ownerFencingEpoch: number;
      expiresAt: string;
      value: PreparedOperationValueBinding;
    },
  ) {
    const source = input.value.source;
    let sourceReferenceId: string | null = null;
    let producerProtectedOperationId: string | null = null;
    let publicValue: string | null = null;
    if (source.kind === "literal_public") {
      publicValue = source.value;
    } else if (source.kind === "stored_public") {
      const stored = await client.query(
        `SELECT value,source_protected_operation_id AS "producerProtectedOperationId"
         FROM generated_public_values WHERE id=$1 AND project_id=$2
           AND source_protected_operation_id IS NULL`,
        [source.valueId, input.projectId],
      );
      if (!stored.rowCount) throw new ConflictException({ code: "OPERATION_VALUE_SOURCE_INVALID" });
      sourceReferenceId = source.valueId;
      producerProtectedOperationId = stored.rows[0]!.producerProtectedOperationId;
    } else if (source.kind === "generated_safe") {
      const stored = await client.query(
        `SELECT value.source_protected_operation_id AS "producerProtectedOperationId"
         FROM generated_public_values value
         JOIN protected_operations producer ON producer.id=value.source_protected_operation_id
         JOIN protected_operations consumer ON consumer.id=$3
           AND consumer.project_id=producer.project_id
           AND consumer.environment_id=producer.environment_id
           AND consumer.mission_id=producer.mission_id
           AND consumer.objective_id=producer.objective_id
         WHERE value.id=$1 AND value.project_id=$2
           AND producer.state IN ('persisted','completed')`,
        [source.valueId, input.projectId, input.protectedOperationId],
      );
      if (!stored.rowCount) throw new ConflictException({ code: "OPERATION_VALUE_SOURCE_INVALID" });
      sourceReferenceId = source.valueId;
      producerProtectedOperationId = stored.rows[0]!.producerProtectedOperationId;
    } else if (source.kind === "protected_reference") {
      const stored = await client.query(
        `SELECT credential.origin_protected_operation_id AS "producerProtectedOperationId"
         FROM project_credentials credential
         JOIN protected_operations consumer ON consumer.id=$3
         JOIN environments environment ON environment.id=consumer.environment_id
         LEFT JOIN protected_operations producer
           ON producer.id=credential.origin_protected_operation_id
         WHERE credential.id=$1 AND credential.project_id=$2 AND credential.deleted_at IS NULL
           AND credential.security_status='active'
           AND (environment.secret_refs ? credential.id::text OR (
             producer.project_id=consumer.project_id
             AND producer.environment_id=consumer.environment_id
             AND producer.mission_id=consumer.mission_id
             AND producer.state IN ('persisted','completed')
           ))`,
        [source.referenceId, input.projectId, input.protectedOperationId],
      );
      if (!stored.rowCount) throw new ConflictException({ code: "OPERATION_VALUE_SOURCE_INVALID" });
      sourceReferenceId = source.referenceId;
      producerProtectedOperationId = stored.rows[0]!.producerProtectedOperationId;
    } else {
      const stored = await client.query(
        `SELECT synthetic.protected_operation_id AS "producerProtectedOperationId"
         FROM operation_bound_protected_inputs synthetic
         JOIN protected_operations producer ON producer.id=synthetic.protected_operation_id
         JOIN protected_operations consumer ON consumer.id=$4
           AND consumer.project_id=producer.project_id
           AND consumer.environment_id=producer.environment_id
           AND consumer.mission_id=producer.mission_id
           AND consumer.objective_id=producer.objective_id
         WHERE synthetic.id=$1 AND synthetic.project_id=$2 AND synthetic.environment_id=$3
           AND synthetic.lifecycle='active'`,
        [source.referenceId, input.projectId, input.environmentId, input.protectedOperationId],
      );
      if (!stored.rowCount) throw new ConflictException({ code: "OPERATION_VALUE_SOURCE_INVALID" });
      sourceReferenceId = source.referenceId;
      producerProtectedOperationId = stored.rows[0]!.producerProtectedOperationId;
    }
    await client.query(
      `INSERT INTO operation_value_bindings(
         consumer_protected_operation_id,source_kind,source_reference_id,
         producer_protected_operation_id,canonical_field_key,target_reference,presentation_class,
         public_value,source_commitment,owner_fencing_epoch,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.protectedOperationId,
        source.kind,
        sourceReferenceId,
        producerProtectedOperationId,
        input.value.canonicalFieldKey,
        input.value.targetReference,
        input.value.presentationClass,
        publicValue,
        digest(source),
        input.ownerFencingEpoch,
        input.expiresAt,
      ],
    );
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
