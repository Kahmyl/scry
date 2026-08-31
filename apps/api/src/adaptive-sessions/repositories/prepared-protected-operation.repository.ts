import { retireUnusedPreparedOperations } from "./retire-unused-prepared-operations.js";
import { createHash, randomUUID } from "node:crypto";

import { ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import { SyntheticInputGeneratorRegistry } from "../synthetic-input-generator.registry.js";
import type { QueryResult, QueryResultRow } from "pg";
import {
  operationContractFactsSchema,
  executionPolicySchema,
  reservePreparedProtectedOperationSchema,
  resumePreparedProtectedOperationSchema,
  type OperationContractFacts,
  type PreparedOperationValueBinding,
  type ReservePreparedProtectedOperationInput,
  type ResumePreparedProtectedOperationInput,
} from "@scry/contracts";

import { Database } from "../../infrastructure/index.js";
import { missionAuthoringProtectedOperationReservation } from "../mission-authoring-protected-transaction.js";
import { OperationBoundProtectedInputRepository } from "./operation-bound-protected-input.repository.js";

type Client = {
  query<T extends QueryResultRow = any>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
};

@Injectable()
export class PreparedProtectedOperationRepository {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Optional()
    @Inject(SyntheticInputGeneratorRegistry)
    private readonly generators = new SyntheticInputGeneratorRegistry(),
  ) {}

  async listMissionValues(input: { projectId: string; environmentId: string; missionId: string }) {
    const result = await this.database.query(
      `SELECT asset.id AS "valueAssetId",asset.application_key AS "applicationKey",
              asset.classification,asset.canonical_output_key AS "canonicalOutputKey",
              asset.identity_role AS "identityRole",
              asset.producer_protected_operation_id AS "producerProtectedOperationId",
              producer.mission_id AS "producerMissionId",
              asset.operation_contract_revision_id AS "contractRevisionId",asset.state
         FROM typed_value_assets asset
         JOIN protected_operations producer ON producer.id=asset.producer_protected_operation_id
        WHERE asset.project_id=$1 AND asset.environment_id=$2 AND producer.mission_id=$3
          AND producer.authority_model='canonical' AND producer.persistence_state='committed'
        ORDER BY asset.created_at,asset.id`,
      [input.projectId, input.environmentId, input.missionId],
    );
    return { items: result.rows };
  }

  async reserve(praxisSessionId: string, raw: ReservePreparedProtectedOperationInput) {
    const request = reservePreparedProtectedOperationSchema.parse(raw);
    return this.database.transaction(async (client) => {
      let input = {
        ...request,
        expiresAt: request.expiresAt ?? new Date(Date.now() + 120_000).toISOString(),
      };
      const authority = await client.query<{
        flowDraftId: string;
        ownerId: string;
        fencingEpoch: number;
        documentEpoch: number;
        origin: string;
        contractFacts: OperationContractFacts;
        applicationKey: string;
        policy: Record<string, unknown>;
        inputControlReferences: Record<string, string>;
        interactionExpiresAt: string;
      }>(
        `SELECT session.flow_draft_id AS "flowDraftId",lease.owner_id AS "ownerId",
                lease.fencing_token AS "fencingEpoch",capability.document_epoch AS "documentEpoch",
                capability.origin,revision.facts AS "contractFacts",
                revision.application_key AS "applicationKey",environment.policy,
                capability.input_control_references AS "inputControlReferences",
                capability.expires_at::text AS "interactionExpiresAt"
           FROM adaptive_sessions session
           JOIN missions mission ON mission.id=session.mission_id AND mission.status NOT IN ('cancelled','completed','failed')
           JOIN agent_sessions agent ON agent.id=session.agent_session_id AND agent.mission_id=mission.id AND agent.status='active'
           JOIN adaptive_session_runtime_leases lease ON lease.session_id=session.id
             AND lease.lease_expires_at>now()
           JOIN runtime_interaction_capabilities capability
             ON capability.id=$7 AND capability.praxis_session_id=session.id
            AND capability.runtime_owner_id=lease.owner_id
            AND capability.fencing_epoch=lease.fencing_token
            AND capability.state='active' AND capability.expires_at>now()
           JOIN operation_contract_revisions revision
             ON revision.id=$6 AND revision.semantic_digest=$8
            AND revision.id=capability.operation_contract_revision_id
            AND revision.semantic_digest=capability.operation_contract_revision_digest
            AND revision.project_id=session.project_id
            AND revision.retention_state='active' AND revision.staleness='current'
           JOIN environments environment ON environment.id=session.environment_id
             AND environment.project_id=session.project_id
          WHERE session.id=$5 AND session.project_id=$1 AND session.environment_id=$2
            AND session.mission_id=$3 AND session.active_objective_id=$4
            AND session.agent_session_id=$9 AND session.protection='protected'
            AND session.state='active'
          FOR SHARE OF session,lease,capability,revision,environment,mission,agent`,
        [
          input.projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          praxisSessionId,
          input.operationContractRevisionId,
          input.runtimeInteractionCapabilityId,
          input.operationContractRevisionDigest,
          input.agentSessionId,
        ],
      );
      const owner = authority.rows[0];
      if (!owner)
        throw new ConflictException({ code: "PREPARED_OPERATION_INTERACTION_AUTHORITY_INVALID" });
      if (request.expiresAt === undefined)
        input.expiresAt = new Date(
          Math.min(
            new Date(input.expiresAt).getTime(),
            new Date(owner.interactionExpiresAt).getTime(),
          ),
        ).toISOString();
      if (new Date(input.expiresAt).getTime() <= Date.now())
        throw new ConflictException({ code: "PREPARED_OPERATION_ALREADY_EXPIRED" });
      const facts = operationContractFactsSchema.parse(owner.contractFacts);
      const continuation = input.continuationReference
        ? await this.deriveContinuation(client, input, facts, owner.inputControlReferences)
        : null;
      if (continuation) input = { ...input, values: [...input.values, continuation.value] };
      const commitments = selectionCommitments(input);
      for (const key of ["targetCommitment", "inputCommitment", "outputCommitment"] as const)
        if (request[key] !== undefined && request[key] !== commitments[key])
          throw new ConflictException({ code: "PREPARED_OPERATION_COMMITMENT_MISMATCH" });
      input = { ...input, ...commitments };
      validateSelections(facts, input);

      const mutationIdentity = randomUUID();
      const protectedOperationId = randomUUID();
      const preparedExecutionCapabilityId = randomUUID();
      const policy = canonicalPolicy(owner.policy);
      const policyDigest = digest({
        version: 1,
        projectId: input.projectId,
        environmentId: input.environmentId,
        applicationKey: owner.applicationKey,
        policy,
      });
      const policySnapshot = await client.query<{ id: string }>(
        `WITH inserted AS (
           INSERT INTO execution_policy_snapshots(
             project_id,environment_id,application_key,policy_version,allowed_origins,
             trusted_script_origins,policy,digest
           ) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,$6::jsonb,$7)
           ON CONFLICT(project_id,environment_id,application_key,digest) DO NOTHING
           RETURNING id
         ) SELECT id FROM inserted UNION ALL
           SELECT id FROM execution_policy_snapshots
            WHERE project_id=$1 AND environment_id=$2 AND application_key=$3 AND digest=$7
              AND NOT EXISTS(SELECT 1 FROM inserted)`,
        [
          input.projectId,
          input.environmentId,
          owner.applicationKey,
          JSON.stringify(policy.allowedOrigins),
          JSON.stringify(policy.trustedScriptOrigins),
          JSON.stringify(policy),
          policyDigest,
        ],
      );
      const expectedOutputs = facts.response.outputs
        .filter((output) => input.expectedOutputs.some((candidate) => candidate.key === output.key))
        .map((output) => ({
          reference: output.key,
          classification: output.classification,
          storageName: `${facts.operation.label} ${output.key}`.slice(0, 200),
          extractor: output.extractor ?? null,
          identityRole: output.identityRole ?? null,
          generatedValueEligible: output.generatedValueEligible,
        }));
      const inserted = await client.query(
        `INSERT INTO protected_operations(
           id,operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,
           environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,
           authorization_id,program_digest,state,phase,safe_output_manifest,praxis_session_id,
           runtime_owner_id,runtime_fencing_epoch,document_epoch,target_commitment,input_commitment,
           output_commitment,reservation_expires_at,authority_model
         ) VALUES($1,$2,$3,'authoring_session',$4,$5,$6,$7,$8,$9,$10,
           NULL,NULL,'reserved','reserved',$11::jsonb,$4,$12,$13,$14,$15,$16,$17,$18,'canonical')
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          protectedOperationId,
          input.publicOperationId,
          mutationIdentity,
          praxisSessionId,
          input.projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          owner.flowDraftId,
          JSON.stringify(expectedOutputs),
          owner.ownerId,
          owner.fencingEpoch,
          owner.documentEpoch,
          input.targetCommitment,
          input.inputCommitment,
          input.outputCommitment,
          input.expiresAt,
        ],
      );
      if (!inserted.rowCount)
        throw new ConflictException({ code: "PREPARED_OPERATION_ID_ALREADY_RESERVED" });
      await client.query(
        `INSERT INTO prepared_execution_capabilities(
           id,protected_operation_id,mutation_identity,operation_contract_revision_id,
           operation_contract_revision_digest,runtime_interaction_capability_id,
           execution_policy_snapshot_id,execution_policy_snapshot_digest,project_id,environment_id,
           mission_id,objective_id,agent_session_id,application_key,dispatch_semantics,
           effect_semantics,target_commitment,input_commitment,output_commitment,resource_effect,
           expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)`,
        [
          preparedExecutionCapabilityId,
          protectedOperationId,
          mutationIdentity,
          input.operationContractRevisionId,
          input.operationContractRevisionDigest,
          input.runtimeInteractionCapabilityId,
          policySnapshot.rows[0]!.id,
          policyDigest,
          input.projectId,
          input.environmentId,
          input.missionId,
          input.objectiveId,
          input.agentSessionId,
          owner.applicationKey,
          facts.operation.semantics.dispatch,
          facts.operation.semantics.effects,
          input.targetCommitment,
          input.inputCommitment,
          input.outputCommitment,
          facts.resourceEffect ? JSON.stringify(facts.resourceEffect) : null,
          input.expiresAt,
        ],
      );
      await client.query(
        `UPDATE protected_operations SET prepared_execution_capability_id=$2 WHERE id=$1`,
        [protectedOperationId, preparedExecutionCapabilityId],
      );
      if (continuation) {
        const claimed = await client.query(
          `UPDATE mission_operation_checkpoints SET state='claimed',
             claimed_by_protected_operation_id=$2,claimed_at=now()
           WHERE id=$1 AND state='available' RETURNING id`,
          [input.continuationReference, protectedOperationId],
        );
        if (claimed.rowCount !== 1)
          throw new ConflictException({ code: "MISSION_OPERATION_CONTINUATION_RACE_LOST" });
      }
      for (const value of input.values)
        await this.insertValueBinding(client, {
          protectedOperationId,
          preparedExecutionCapabilityId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          missionId: input.missionId,
          applicationKey: owner.applicationKey,
          contractFacts: facts,
          policy: owner.policy,
          expiresAt: input.expiresAt,
          value,
        });
      await client.query(
        `UPDATE protected_operations SET state='planned',phase='planned' WHERE id=$1 AND state='reserved'`,
        [protectedOperationId],
      );
      await client.query(
        `INSERT INTO protected_operation_transitions(
           protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics
         ) VALUES($1,1,NULL,'planned','planned',$2,'{}'::jsonb)`,
        [protectedOperationId, owner.fencingEpoch],
      );
      return {
        protectedOperationId,
        preparedExecutionCapabilityId,
        publicOperationId: input.publicOperationId,
        mutationIdentity,
        state: "reserved" as const,
        contractDigest: input.operationContractRevisionDigest,
        expiresAt: input.expiresAt,
      };
    });
  }

  async assertResumable(praxisSessionId: string, raw: ResumePreparedProtectedOperationInput) {
    const input = resumePreparedProtectedOperationSchema.parse(raw);
    const result = await this.database.query<{
      state: "planned" | "preparing" | "ready_to_dispatch";
      operationContractRevisionId: string;
      runtimeInteractionCapabilityId: string;
      documentEpoch: number;
      origin: string;
    }>(
      `SELECT operation.state,
              capability.operation_contract_revision_id AS "operationContractRevisionId",
              capability.runtime_interaction_capability_id AS "runtimeInteractionCapabilityId",
              interaction.document_epoch AS "documentEpoch",interaction.origin
         FROM protected_operations operation
         JOIN missions mission ON mission.id=operation.mission_id AND mission.status NOT IN ('cancelled','completed','failed')
         JOIN prepared_execution_capabilities capability
           ON capability.id=$2 AND capability.protected_operation_id=operation.id
          AND capability.state IN ('reserved','finalized') AND capability.expires_at>now()
         JOIN operation_contract_revisions revision ON revision.id=capability.operation_contract_revision_id
          AND revision.retention_state='active' AND revision.staleness='current'
         JOIN runtime_interaction_capabilities interaction
           ON interaction.id=capability.runtime_interaction_capability_id
          AND interaction.state='active' AND interaction.expires_at>now()
          AND interaction.praxis_session_id=$4
         JOIN adaptive_session_runtime_leases lease ON lease.session_id=interaction.praxis_session_id
          AND lease.owner_id=interaction.runtime_owner_id
          AND lease.fencing_token=interaction.fencing_epoch AND lease.lease_expires_at>now()
        WHERE operation.id=$1 AND operation.operation_id=$3 AND operation.authority_model='canonical'
          AND operation.state IN ('planned','preparing','ready_to_dispatch')
          AND NOT EXISTS(
            SELECT 1 FROM operation_value_bindings binding
             WHERE binding.consumer_protected_operation_id=operation.id
               AND binding.source_kind IN ('generated_safe','generated_protected')
               AND NOT EXISTS(
                 SELECT 1 FROM value_use_grants grant_authority
                  WHERE grant_authority.id=binding.value_use_grant_id
                    AND grant_authority.consumer_prepared_execution_capability_id=capability.id
                    AND grant_authority.canonical_field_key=binding.canonical_field_key
                    AND grant_authority.presentation_class=binding.presentation_class
                    AND grant_authority.max_uses=1 AND grant_authority.state='active' AND grant_authority.revoked_at IS NULL AND grant_authority.expires_at>now()
                    AND grant_authority.use_count<grant_authority.max_uses))`,
      [
        input.protectedOperationId,
        input.preparedExecutionCapabilityId,
        input.publicOperationId,
        praxisSessionId,
      ],
    );
    if (!result.rowCount)
      throw new ConflictException({ code: "PREPARED_OPERATION_RESUME_AUTHORITY_INVALID" });
    return {
      ...result.rows[0]!,
      protectedOperationId: input.protectedOperationId,
      preparedExecutionCapabilityId: input.preparedExecutionCapabilityId,
      publicOperationId: input.publicOperationId,
    };
  }

  async executionMaterial(praxisSessionId: string, raw: ResumePreparedProtectedOperationInput) {
    const input = resumePreparedProtectedOperationSchema.parse(raw);
    await this.assertResumable(praxisSessionId, input);
    const result = await this.database.query<{
      protectedOperationId: string;
      preparedExecutionCapabilityId: string;
      mutationIdentity: string;
      publicOperationId: string;
      objectiveId: string;
      flowDraftId: string;
      contractFacts: OperationContractFacts;
      activationControlReference: string;
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
          | "generated_protected"
          | "synthetic_protected";
        sourceReferenceId: string | null;
        publicValue: string | null;
        storedPublicValue: string | null;
      }>;
      expectedOutputs: Array<{
        reference: string;
        classification: "public" | "protected";
        storageName: string;
      }>;
    }>(
      `SELECT operation.id AS "protectedOperationId",capability.id AS "preparedExecutionCapabilityId",
              capability.mutation_identity AS "mutationIdentity",operation.operation_id AS "publicOperationId",
              operation.objective_id AS "objectiveId",operation.flow_draft_id AS "flowDraftId",
              revision.facts AS "contractFacts",
              interaction.activation_control_reference AS "activationControlReference",
              interaction.document_epoch AS "documentEpoch",interaction.origin,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'canonicalFieldKey',binding.canonical_field_key,'targetReference',binding.target_reference,
                'presentationClass',binding.presentation_class,'sourceKind',binding.source_kind,
                'sourceReferenceId',CASE WHEN binding.source_kind='generated_protected'
                  THEN asset.project_credential_id ELSE binding.source_reference_id END,
                'publicValue',binding.public_value,'storedPublicValue',public_value.value)
                ORDER BY binding.canonical_field_key)
                FROM operation_value_bindings binding
                LEFT JOIN typed_value_assets asset ON asset.id=binding.source_reference_id
                  AND binding.source_kind IN ('generated_safe','generated_protected')
                LEFT JOIN generated_public_values public_value
                  ON public_value.id=CASE WHEN binding.source_kind='generated_safe'
                    THEN asset.generated_public_value_id ELSE binding.source_reference_id END
               WHERE binding.consumer_protected_operation_id=operation.id
                 AND binding.state IN ('active','consumed') AND binding.expires_at>now()),'[]'::jsonb) AS values,
              operation.safe_output_manifest AS "expectedOutputs"
         FROM protected_operations operation
         JOIN prepared_execution_capabilities capability
           ON capability.id=$2 AND capability.protected_operation_id=operation.id
         JOIN operation_contract_revisions revision
           ON revision.id=capability.operation_contract_revision_id
          AND revision.semantic_digest=capability.operation_contract_revision_digest
         JOIN runtime_interaction_capabilities interaction
           ON interaction.id=capability.runtime_interaction_capability_id
        WHERE operation.id=$1 AND operation.operation_id=$3 AND operation.state='planned'
          AND operation.authority_model='canonical'`,
      [input.protectedOperationId, input.preparedExecutionCapabilityId, input.publicOperationId],
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

  async finalizeExecutionCapability(
    preparedExecutionCapabilityId: string,
    transaction: import("@scry/contracts").ProtectedTransaction,
  ) {
    return this.database.transaction(async (client) => {
      const owner = await client.query<{
        protectedOperationId: string;
        mutationIdentity: string;
        allowedOrigins: string[];
        state: string;
      }>(
        `SELECT capability.protected_operation_id AS "protectedOperationId",
                capability.mutation_identity AS "mutationIdentity",
                policy.allowed_origins AS "allowedOrigins",capability.state
           FROM prepared_execution_capabilities capability
           JOIN execution_policy_snapshots policy ON policy.id=capability.execution_policy_snapshot_id
             AND policy.digest=capability.execution_policy_snapshot_digest
          WHERE capability.id=$1 FOR UPDATE OF capability`,
        [preparedExecutionCapabilityId],
      );
      const capability = owner.rows[0];
      if (!capability)
        throw new ConflictException({ code: "PREPARED_EXECUTION_CAPABILITY_MISSING" });
      const reservation = missionAuthoringProtectedOperationReservation(
        transaction,
        capability.allowedOrigins,
        capability.mutationIdentity,
        preparedExecutionCapabilityId,
      );
      const manifest = {
        version: 1,
        programDigest: reservation.programDigest,
        dispatchSemantics: reservation.dispatchSemantics,
        safeOutputManifest: reservation.safeOutputManifest,
        requestContract: reservation.requestContract ?? null,
      };
      if (capability.state === "reserved") {
        const finalized = await client.query(
          `UPDATE prepared_execution_capabilities SET state='finalized',program_manifest=$2::jsonb,
             program_digest=$3,finalized_at=now()
           WHERE id=$1 AND state='reserved' RETURNING id`,
          [preparedExecutionCapabilityId, JSON.stringify(manifest), reservation.programDigest],
        );
        if (!finalized.rowCount)
          throw new ConflictException({ code: "PREPARED_EXECUTION_CAPABILITY_FINALIZATION_RACE" });
      } else {
        const exact = await client.query(
          `SELECT 1 FROM prepared_execution_capabilities
            WHERE id=$1 AND state='finalized' AND program_digest=$2 AND program_manifest=$3::jsonb`,
          [preparedExecutionCapabilityId, reservation.programDigest, JSON.stringify(manifest)],
        );
        if (!exact.rowCount)
          throw new ConflictException({
            code: "PREPARED_EXECUTION_CAPABILITY_FINALIZATION_MISMATCH",
          });
      }
      return reservation;
    });
  }

  async consumeGeneratedBindings(protectedOperationId: string) {
    await this.database.transaction(async (client) => {
      const grants = await client.query<{ id: string }>(
        `UPDATE value_use_grants grant_authority SET use_count=grant_authority.use_count+1,
           state=CASE WHEN grant_authority.use_count+1>=grant_authority.max_uses
             THEN 'consumed' ELSE grant_authority.state END,
           consumed_at=CASE WHEN grant_authority.use_count+1>=grant_authority.max_uses
             THEN now() ELSE grant_authority.consumed_at END
          FROM operation_value_bindings binding
         WHERE binding.consumer_protected_operation_id=$1
           AND binding.value_use_grant_id=grant_authority.id
           AND binding.source_kind IN ('generated_safe','generated_protected')
           AND grant_authority.max_uses=1 AND grant_authority.state='active' AND grant_authority.expires_at>now()
           AND grant_authority.use_count<grant_authority.max_uses RETURNING grant_authority.id`,
        [protectedOperationId],
      );
      const expected = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM operation_value_bindings
          WHERE consumer_protected_operation_id=$1
            AND source_kind IN ('generated_safe','generated_protected')`,
        [protectedOperationId],
      );
      const expectedCount = Number(expected.rows[0]!.count);
      if (grants.rowCount !== expectedCount) {
        const alreadyConsumed = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM operation_value_bindings binding
             JOIN value_use_grants grant_authority ON grant_authority.id=binding.value_use_grant_id
            WHERE binding.consumer_protected_operation_id=$1
              AND binding.source_kind IN ('generated_safe','generated_protected')
              AND binding.state='consumed' AND binding.use_count=1
              AND grant_authority.max_uses=1 AND grant_authority.state='consumed' AND grant_authority.use_count=1`,
          [protectedOperationId],
        );
        if (Number(alreadyConsumed.rows[0]!.count) !== expectedCount)
          throw new ConflictException({ code: "VALUE_USE_GRANT_CONSUMPTION_FAILED" });
        return;
      }
      await client.query(
        `UPDATE operation_value_bindings SET use_count=use_count+1,state='consumed',consumed_at=now()
          WHERE consumer_protected_operation_id=$1
            AND source_kind IN ('generated_safe','generated_protected')
            AND state='active' AND expires_at>now() AND use_count<max_uses`,
        [protectedOperationId],
      );
      const consumed = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM operation_value_bindings
          WHERE consumer_protected_operation_id=$1
            AND source_kind IN ('generated_safe','generated_protected')
            AND state='consumed' AND use_count=1`,
        [protectedOperationId],
      );
      if (Number(consumed.rows[0]!.count) !== expectedCount)
        throw new ConflictException({ code: "VALUE_USE_GRANT_CONSUMPTION_FAILED" });
    });
  }

  private async deriveContinuation(
    client: Client,
    input: ReservePreparedProtectedOperationInput,
    facts: OperationContractFacts,
    controls: Record<string, string>,
  ): Promise<{ value: PreparedOperationValueBinding }> {
    const targetKey = facts.retrieval?.canonicalTargetFieldKey;
    const candidates = facts.inputs.filter((field) => field.key === targetKey);
    if (facts.operation.semantics.dispatch !== "read_only" || candidates.length !== 1)
      throw new ConflictException({
        code: "CONTINUATION_TARGET_AMBIGUOUS",
        alternatives: facts.inputs.map(({ key, label }) => ({ key, label })),
      });
    const field = candidates[0]!;
    if (input.values.some((value) => value.canonicalFieldKey === field.key))
      throw new ConflictException({ code: "CONTINUATION_TARGET_ALREADY_BOUND" });
    const source = await client.query<{
      valueAssetId: string;
      classification: "public" | "protected";
    }>(
      `SELECT asset.id AS "valueAssetId",asset.classification
         FROM mission_operation_checkpoints checkpoint
         JOIN typed_value_assets asset ON asset.id=checkpoint.created_identity_value_asset_id
          AND asset.producer_protected_operation_id=checkpoint.source_protected_operation_id
          AND asset.project_id=$2 AND asset.environment_id=$3
          AND asset.application_key=$5 AND asset.state='active' AND asset.identity_role IS NOT NULL
         JOIN canonical_completed_executions producer ON producer.id=asset.producer_protected_operation_id
          AND producer.mission_id=$4 AND producer.project_id=$2 AND producer.environment_id=$3
         JOIN operation_contract_revisions revision ON revision.id=asset.operation_contract_revision_id
          AND revision.retention_state='active' AND revision.staleness='current'
        WHERE checkpoint.id=$1 AND checkpoint.mission_id=$4 AND checkpoint.environment_id=$3
          AND checkpoint.state='available' AND checkpoint.mutation_outcome='applied'
          AND 'read_only_retrieve'=ANY(checkpoint.permitted_continuations)
          AND checkpoint.canonical_output_references->asset.canonical_output_key->>'valueAssetId'=asset.id::text
          AND (SELECT count(*) FROM typed_value_assets identity
               WHERE identity.producer_protected_operation_id=producer.id AND identity.identity_role IS NOT NULL)=1
        FOR UPDATE OF checkpoint`,
      [
        input.continuationReference,
        input.projectId,
        input.environmentId,
        input.missionId,
        facts.application.key,
      ],
    );
    const asset = source.rows[0];
    if (source.rowCount !== 1 || !asset)
      throw new ConflictException({ code: "MISSION_OPERATION_CONTINUATION_UNAVAILABLE" });
    const presentationClass = asset.classification === "public" ? "plain_text" : "protected_text";
    if (
      !controls[field.key] ||
      !field.acceptedPresentations.includes(presentationClass) ||
      field.classification !== (asset.classification === "public" ? "generated_safe" : "protected")
    )
      throw new ConflictException({ code: "CONTINUATION_TARGET_INCOMPATIBLE" });
    return {
      value: {
        canonicalFieldKey: field.key,
        targetReference: controls[field.key]!,
        presentationClass,
        source: {
          kind: asset.classification === "public" ? "generated_safe" : "generated_protected",
          valueAssetId: asset.valueAssetId,
        },
      },
    };
  }

  async listContinuations(praxisSessionId: string) {
    const result = await this.database.query(
      `SELECT checkpoint.id AS "continuationReference",producer.id AS "sourceOperationId",
              COALESCE(asset.resource_effect->>'resourceKind','resource') AS "resourceType",
              asset.id AS "canonicalIdentityReference",true AS "readOnly",
              'Retrieve the exact resource produced by ' || (source.facts->'operation'->>'label') AS description,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'operationContractRevisionId',target.id,'operationKey',target.operation_key,
                'description',target.facts->'operation'->>'label','readOnly',true) ORDER BY target.operation_key)
                FROM operation_contract_revisions target
                WHERE target.project_id=session.project_id AND target.application_key=asset.application_key
                  AND target.retention_state='active' AND target.staleness='current'
                  AND target.facts->'operation'->'semantics'->>'dispatch'='read_only'
                  AND EXISTS(SELECT 1 FROM jsonb_array_elements(target.facts->'inputs') field
                    WHERE field->>'key'=target.facts->'retrieval'->>'canonicalTargetFieldKey'
                      AND field->>'classification'=CASE WHEN asset.classification='public' THEN 'generated_safe' ELSE 'protected' END)
              ),'[]'::jsonb) AS "eligibleOperations"
         FROM adaptive_sessions session
         JOIN mission_operation_checkpoints checkpoint ON checkpoint.mission_id=session.mission_id
          AND checkpoint.environment_id=session.environment_id AND checkpoint.state='available'
          AND checkpoint.mutation_outcome='applied'
          AND 'read_only_retrieve'=ANY(checkpoint.permitted_continuations)
         JOIN canonical_completed_executions producer ON producer.id=checkpoint.source_protected_operation_id
          AND producer.project_id=session.project_id AND producer.mission_id=session.mission_id
         JOIN typed_value_assets asset ON asset.id=checkpoint.created_identity_value_asset_id
          AND asset.producer_protected_operation_id=producer.id AND asset.state='active'
         JOIN operation_contract_revisions source ON source.id=asset.operation_contract_revision_id
        WHERE session.id=$1 ORDER BY checkpoint.created_at,checkpoint.id LIMIT 100`,
      [praxisSessionId],
    );
    return { continuations: result.rows };
  }

  async listCheckpoints(praxisSessionId: string) {
    const result = await this.database.query(
      `SELECT checkpoint.id,checkpoint.source_protected_operation_id AS "sourceProtectedOperationId",
              checkpoint.mutation_receipt_digest AS "mutationReceiptDigest",
              checkpoint.mutation_outcome AS "mutationOutcome",
              checkpoint.dispatch_acknowledged AS "dispatchAcknowledged",
              checkpoint.canonical_output_references AS "persistedReferences",
              checkpoint.permitted_continuations AS "permittedContinuations",
              checkpoint.source_mutation_repeatable AS "sourceMutationRepeatable",
              checkpoint.state,checkpoint.created_identity_digest AS "createdIdentityDigest",
              checkpoint.retrieved_identity_digest AS "retrievedIdentityDigest",
              checkpoint.identity_matches AS "identityMatches"
         FROM mission_operation_checkpoints checkpoint
         JOIN protected_operations source ON source.id=checkpoint.source_protected_operation_id
         JOIN adaptive_sessions current_session
           ON current_session.id=$1 AND current_session.mission_id=checkpoint.mission_id
          AND current_session.project_id=source.project_id
        ORDER BY checkpoint.created_at,checkpoint.id`,
      [praxisSessionId],
    );
    return { checkpoints: result.rows };
  }

  async abandonReservedForSession(praxisSessionId: string) {
    return this.database.transaction((client) =>
      retireUnusedPreparedOperations(client, praxisSessionId),
    );
  }

  private async insertValueBinding(
    client: Client,
    input: {
      protectedOperationId: string;
      preparedExecutionCapabilityId: string;
      projectId: string;
      environmentId: string;
      missionId: string;
      applicationKey: string;
      contractFacts: OperationContractFacts;
      policy: Record<string, unknown>;
      expiresAt: string;
      value: PreparedOperationValueBinding;
    },
  ) {
    const source = input.value.source;
    let sourceReferenceId: string | null = null;
    let producerProtectedOperationId: string | null = null;
    let publicValue: string | null = null;
    if (source.kind === "literal_public") publicValue = source.value;
    else if (source.kind === "stored_public") {
      const stored = await client.query(
        `SELECT id FROM generated_public_values WHERE id=$1 AND project_id=$2
          AND source_protected_operation_id IS NULL`,
        [source.valueId, input.projectId],
      );
      if (!stored.rowCount) throw new ConflictException({ code: "OPERATION_VALUE_SOURCE_INVALID" });
      sourceReferenceId = source.valueId;
    } else if (source.kind === "protected_reference") {
      const credential = await client.query(
        `SELECT credential.id FROM project_credentials credential
         JOIN environments environment ON environment.id=$2 AND environment.project_id=credential.project_id
        WHERE credential.id=$1 AND credential.project_id=$3 AND credential.security_status='active'
          AND credential.origin_protected_operation_id IS NULL
          AND credential.deleted_at IS NULL AND environment.secret_refs ? credential.id::text`,
        [source.referenceId, input.environmentId, input.projectId],
      );
      if (!credential.rowCount)
        throw new ConflictException({ code: "OPERATION_VALUE_SOURCE_INVALID" });
      sourceReferenceId = source.referenceId;
    } else if (source.kind === "synthetic_protected") {
      const effect = input.contractFacts.resourceEffect;
      if (!effect || source.declaration.semantic !== input.value.canonicalFieldKey)
        throw new ConflictException({ code: "SYNTHETIC_PROTECTED_INPUT_CONTRACT_MISMATCH" });
      const synthetic = await new OperationBoundProtectedInputRepository(
        this.database,
        this.generators,
      ).materializeUsing(client, {
        protectedOperationId: input.protectedOperationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        declaration: source.declaration,
        policy: executionPolicySchema.parse(input.policy),
        resourceKind: effect.resourceKind,
        operation: effect.operation,
      });
      sourceReferenceId = synthetic.referenceId;
    } else {
      const asset = await client.query<{
        producerProtectedOperationId: string;
        requiresCheckpoint: boolean;
      }>(
        `SELECT asset.producer_protected_operation_id AS "producerProtectedOperationId",
                (asset.identity_role IS NOT NULL AND
                 revision.facts->'response'->>'continuation'='read_only_retrieve') AS "requiresCheckpoint"
           FROM typed_value_assets asset
           JOIN operation_contract_revisions revision ON revision.id=asset.operation_contract_revision_id
            AND revision.retention_state='active' AND revision.staleness='current'
           JOIN protected_operations producer ON producer.id=asset.producer_protected_operation_id
            AND producer.authority_model='canonical' AND producer.persistence_state='committed'
            AND producer.state IN ('persisted','completed') AND producer.mission_id=$6
          WHERE asset.id=$1 AND asset.project_id=$2
            AND asset.application_key=$3 AND asset.state='active' AND asset.classification=$4
            AND asset.environment_id=$5
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(revision.facts->'response'->'outputs') output
              WHERE output->>'key'=asset.canonical_output_key
                AND output->>'generatedValueEligible'='true')`,
        [
          source.valueAssetId,
          input.projectId,
          input.applicationKey,
          source.kind === "generated_safe" ? "public" : "protected",
          input.environmentId,
          input.missionId,
        ],
      );
      if (!asset.rowCount) throw new ConflictException({ code: "GENERATED_VALUE_ASSET_INVALID" });
      sourceReferenceId = source.valueAssetId;
      producerProtectedOperationId = asset.rows[0]!.producerProtectedOperationId;
      if (asset.rows[0]!.requiresCheckpoint) {
        const claimed = await client.query(
          `SELECT 1 FROM mission_operation_checkpoints
            WHERE created_identity_value_asset_id=$1 AND mission_id=$2
              AND state='claimed' AND claimed_by_protected_operation_id=$3`,
          [source.valueAssetId, input.missionId, input.protectedOperationId],
        );
        if (claimed.rowCount !== 1)
          throw new ConflictException({ code: "GENERATED_VALUE_CONTINUATION_REQUIRED" });
      }
    }
    const inserted = await client.query(
      `INSERT INTO operation_value_bindings(
         consumer_protected_operation_id,source_kind,source_reference_id,
         producer_protected_operation_id,canonical_field_key,target_reference,presentation_class,
         public_value,source_commitment,owner_fencing_epoch,expires_at,max_uses,value_use_grant_id
       ) SELECT $1,$2,$3,$4,$5,interaction.input_control_references->>$5,$6,$7,$8,
           interaction.fencing_epoch,$9,1,$10
         FROM prepared_execution_capabilities capability
         JOIN runtime_interaction_capabilities interaction
           ON interaction.id=capability.runtime_interaction_capability_id
        WHERE capability.id=$11 AND interaction.input_control_references->>$5=$12`,
      [
        input.protectedOperationId,
        source.kind,
        sourceReferenceId,
        producerProtectedOperationId,
        input.value.canonicalFieldKey,
        input.value.presentationClass,
        publicValue,
        digest(source),
        input.expiresAt,
        null,
        input.preparedExecutionCapabilityId,
        input.value.targetReference,
      ],
    );
    if (!inserted.rowCount) throw new ConflictException({ code: "OPERATION_VALUE_TARGET_INVALID" });
    if (source.kind === "generated_safe" || source.kind === "generated_protected")
      await this.issueValueUseGrant(client, {
        valueAssetId: source.valueAssetId,
        producerProtectedOperationId: producerProtectedOperationId!,
        missionId: input.missionId,
        consumerProtectedOperationId: input.protectedOperationId,
        consumerPreparedExecutionCapabilityId: input.preparedExecutionCapabilityId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        applicationKey: input.applicationKey,
        canonicalFieldKey: input.value.canonicalFieldKey,
        presentationClass: input.value.presentationClass,
        expiresAt: input.expiresAt,
      });
  }

  private async issueValueUseGrant(
    client: Client,
    input: {
      valueAssetId: string;
      producerProtectedOperationId: string;
      missionId: string;
      consumerProtectedOperationId: string;
      consumerPreparedExecutionCapabilityId: string;
      projectId: string;
      environmentId: string;
      applicationKey: string;
      canonicalFieldKey: string;
      presentationClass: string;
      expiresAt: string;
    },
  ) {
    const result = await client.query(
      `INSERT INTO value_use_grants(
         value_asset_id,producer_protected_operation_id,mission_id,consumer_protected_operation_id,
         consumer_prepared_execution_capability_id,project_id,environment_id,application_key,
         canonical_field_key,presentation_class,expires_at
       ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
         FROM typed_value_assets asset
         JOIN protected_operations producer ON producer.id=asset.producer_protected_operation_id
          AND producer.authority_model='canonical' AND producer.persistence_state='committed'
          AND producer.state IN ('persisted','completed') AND producer.mission_id=$3
         JOIN prepared_execution_capabilities capability
           ON capability.id=$5 AND capability.protected_operation_id=$4
          AND capability.mission_id=$3 AND capability.project_id=$6
          AND capability.environment_id=$7 AND capability.application_key=$8
          AND capability.state IN ('reserved','finalized') AND capability.expires_at>now()
          AND $11::timestamptz<=capability.expires_at
         JOIN operation_contract_revisions revision ON revision.id=asset.operation_contract_revision_id
          AND revision.retention_state='active' AND revision.staleness='current'
         JOIN operation_value_bindings binding
           ON binding.consumer_protected_operation_id=$4
          AND binding.source_reference_id=asset.id
          AND binding.canonical_field_key=$9
          AND binding.presentation_class=$10
          AND binding.source_kind IN ('generated_safe','generated_protected')
          AND binding.state='active' AND binding.expires_at>now()
        WHERE asset.id=$1 AND asset.producer_protected_operation_id=$2 AND asset.project_id=$6
          AND asset.application_key=$8 AND asset.state='active'
          AND asset.environment_id=$7
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(revision.facts->'response'->'outputs') output
            WHERE output->>'key'=asset.canonical_output_key
              AND output->>'generatedValueEligible'='true')
       ON CONFLICT(consumer_prepared_execution_capability_id,canonical_field_key)
       DO UPDATE SET state=value_use_grants.state RETURNING id`,
      [
        input.valueAssetId,
        input.producerProtectedOperationId,
        input.missionId,
        input.consumerProtectedOperationId,
        input.consumerPreparedExecutionCapabilityId,
        input.projectId,
        input.environmentId,
        input.applicationKey,
        input.canonicalFieldKey,
        input.presentationClass,
        input.expiresAt,
      ],
    );
    if (!result.rowCount) throw new ConflictException({ code: "VALUE_USE_GRANT_INVALID" });
    await client.query(
      `UPDATE operation_value_bindings SET value_use_grant_id=$2
        WHERE consumer_protected_operation_id=$1 AND canonical_field_key=$3
          AND source_reference_id=$4 AND value_use_grant_id IS NULL`,
      [
        input.consumerProtectedOperationId,
        result.rows[0]!.id,
        input.canonicalFieldKey,
        input.valueAssetId,
      ],
    );
    return result.rows[0]!;
  }
}

function validateSelections(
  facts: OperationContractFacts,
  input: ReservePreparedProtectedOperationInput,
) {
  const fields = new Map(facts.inputs.map((field) => [field.key, field]));
  const keys = input.values.map((value) => value.canonicalFieldKey);
  if (
    new Set(keys).size !== keys.length ||
    facts.inputs.some((field) => field.required && !keys.includes(field.key)) ||
    input.values.some((value) => {
      const field = fields.get(value.canonicalFieldKey);
      if (!field || !field.acceptedPresentations.includes(value.presentationClass)) return true;
      const actual =
        value.source.kind === "generated_safe"
          ? "generated_safe"
          : value.source.kind === "generated_protected" ||
              value.source.kind === "protected_reference" ||
              value.source.kind === "synthetic_protected"
            ? "protected"
            : "public";
      return actual !== field.classification;
    }) ||
    input.expectedOutputs.some((output) => {
      const declared = facts.response.outputs.find((candidate) => candidate.key === output.key);
      return !declared || declared.classification !== output.classification;
    })
  )
    throw new ConflictException({ code: "PREPARED_OPERATION_CONTRACT_SELECTION_INVALID" });
}

function selectionCommitments(input: ReservePreparedProtectedOperationInput) {
  const values = [...input.values].sort((left, right) =>
    left.canonicalFieldKey.localeCompare(right.canonicalFieldKey),
  );
  return {
    targetCommitment: digest(
      values.map((value) => ({
        key: value.canonicalFieldKey,
        targetReference: value.targetReference,
      })),
    ),
    inputCommitment: digest(
      values.map((value) => ({
        key: value.canonicalFieldKey,
        presentationClass: value.presentationClass,
        sourceCommitment: digest(value.source),
      })),
    ),
    outputCommitment: digest(
      [...input.expectedOutputs].sort((left, right) => left.key.localeCompare(right.key)),
    ),
  };
}

function canonicalPolicy(raw: Record<string, unknown>) {
  const allowedOrigins = stringArray(raw.allowedOrigins);
  if (!allowedOrigins.length)
    throw new ConflictException({ code: "EXECUTION_POLICY_ALLOWED_ORIGINS_MISSING" });
  return {
    ...raw,
    allowedOrigins: [...new Set(allowedOrigins)].sort(),
    trustedScriptOrigins: [...new Set(stringArray(raw.trustedScriptOrigins))].sort(),
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function digest(value: unknown) {
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
