import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { PreparedProtectedOperationRepository } from "../src/adaptive-sessions/repositories/prepared-protected-operation.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { OrchestrationService } from "../src/orchestration/index.js";

const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("prepared protected operation repository", () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const ownerId = randomUUID();
  let sessionId: string;
  let database: Database;
  let sessions: AdaptiveSessionRepository;
  let prepared: PreparedProtectedOperationRepository;
  let orchestration: OrchestrationService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    sessions = new AdaptiveSessionRepository(database);
    prepared = new PreparedProtectedOperationRepository(database);
    orchestration = new OrchestrationService(database);
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Prepared',$2)`, [
      workspaceId,
      `prepared-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Prepared')`, [
      projectId,
      workspaceId,
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Prepared','https://example.test',$3::jsonb)`,
      [
        environmentId,
        projectId,
        JSON.stringify({
          allowedOrigins: ["https://example.test"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 20,
          maxDurationMs: 30_000,
          maxNavigations: 10,
        }),
      ],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
       VALUES($1,$2,'Prepared','Create one item')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
       VALUES($1,$2,'Create','{}'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','Prepared',$3)`,
      [agentSessionId, missionId, `prepared-agent-${agentSessionId}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,
         content,plan,created_by_agent_session_id)
       VALUES($1,$2,$3,$4,$5,'Prepared','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
    const created = await sessions.create(workspaceId, {
      projectId,
      missionId,
      objectiveId,
      flowDraftId,
      environmentId,
      agentSessionId,
      objective: "Create one item",
      allowedOrigins: ["https://example.test"],
      idempotencyKey: `prepared-session-${randomUUID()}`,
      protection: "protected",
    });
    sessionId = created.id;
    await sessions.activateProvisionedSession(sessionId);
    await sessions.claimRuntimeLease({ sessionId, ownerId, leaseDurationMs: 60_000 });
  });

  afterAll(async () => database?.onModuleDestroy());

  it("reserves without dispatch, binds exact authorization, refuses altered resume, and converges owner loss", async () => {
    const facts = {
      operation: {
        key: "createItem",
        label: "Create item",
        method: "POST" as const,
        pathTemplate: "/items",
        transports: ["fetch" as const],
        classification: "mutation" as const,
        activationControlReference: "context-control-11111111111111111111111111111111",
      },
      inputs: [
        {
          key: "clientId",
          label: "Client ID",
          aliases: ["Client"],
          required: true,
          classification: "public" as const,
          acceptedPresentations: ["plain_text" as const],
          controlReference: "context-control-22222222222222222222222222222222",
        },
      ],
      auth: { presentationClasses: [] },
      response: {
        statusClasses: [2],
        confirmedNotAppliedStatuses: [400, 401, 403, 422],
        safeOutputKeys: ["itemId"],
        safeOutputs: [{ key: "itemId", label: "id", classification: "public" as const }],
        publicIdentityOutputPath: "$.itemId",
        continuation: "read_only_retrieve" as const,
      },
    };
    const provenance = {
      praxisSessionId: sessionId,
      documentEpoch: 0,
      origin: "https://example.test",
      sourceKind: "public_document" as const,
      observationId: "prepared-observation",
    };
    const contractDigest = digest({ ...provenance, facts });
    const [contract] = await prepared.recordObservedContracts([
      { id: randomUUID(), digest: contractDigest, ...provenance, ...facts },
    ]);
    const [reobserved] = await prepared.recordObservedContracts([
      { id: randomUUID(), digest: contractDigest, ...provenance, ...facts },
    ]);
    expect(reobserved!.id).toBe(contract!.id);
    const passwordFacts = {
      ...facts,
      operation: { ...facts.operation, key: "authenticate", label: "Sign in" },
      inputs: [
        {
          key: "password",
          label: "Password",
          aliases: ["Login password"],
          required: true,
          classification: "protected" as const,
          acceptedPresentations: ["protected_text" as const],
          controlReference: "context-control-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      response: {
        ...facts.response,
        safeOutputKeys: ["authenticated"],
        safeOutputs: [
          { key: "authenticated", label: "authenticated", classification: "public" as const },
        ],
        continuation: "none" as const,
      },
    };
    const passwordDigest = digest({ ...provenance, facts: passwordFacts });
    await expect(
      prepared.recordObservedContracts([
        { id: randomUUID(), digest: passwordDigest, ...provenance, ...passwordFacts },
      ]),
    ).resolves.toHaveLength(1);
    const values = [
      {
        canonicalFieldKey: "clientId",
        targetReference: "context-control-22222222222222222222222222222222",
        presentationClass: "plain_text" as const,
        source: { kind: "literal_public" as const, value: "public-client" },
      },
    ];
    const expectedOutputs = [{ key: "itemId", classification: "public" as const }];
    const commitments = {
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
      outputCommitment: digest(expectedOutputs),
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const misclassifiedOutputs = [{ key: "itemId", classification: "protected" as const }];
    await expect(
      prepared.reserve({
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        praxisSessionId: sessionId,
        publicOperationId: `misclassified-${randomUUID()}`,
        observedOperationContractId: contract!.id,
        observedOperationContractDigest: contractDigest,
        documentEpoch: 0,
        ...commitments,
        outputCommitment: digest(misclassifiedOutputs),
        values,
        expectedOutputs: misclassifiedOutputs,
        expiresAt,
      }),
    ).rejects.toMatchObject({
      response: { code: "PREPARED_OPERATION_CONTRACT_SELECTION_INVALID" },
    });
    const reservation = await prepared.reserve({
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      praxisSessionId: sessionId,
      publicOperationId: `prepared-${randomUUID()}`,
      observedOperationContractId: contract!.id,
      observedOperationContractDigest: contractDigest,
      documentEpoch: 0,
      ...commitments,
      values,
      expectedOutputs,
      expiresAt,
    });
    const untouched = await database.query<{ state: string; dispatchState: string }>(
      `SELECT state,dispatch_state AS "dispatchState" FROM protected_operations WHERE id=$1`,
      [reservation.protectedOperationId],
    );
    expect(untouched.rows[0]).toEqual({ state: "reserved", dispatchState: "not_started" });
    const principal = {
      kind: "user" as const,
      subject: workspaceId,
      userId: randomUUID(),
      email: "prepared@example.test",
      workspaceId,
      role: "owner" as const,
    };
    const authorization = {
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      kind: "protected_mutation" as const,
      reason: "Prepared integration",
      confirmedUserAuthorized: true as const,
      expiresAt,
      operationId: reservation.publicOperationId,
      praxisSessionId: sessionId,
      preparedOperation: {
        protectedOperationId: reservation.protectedOperationId,
        publicOperationId: reservation.publicOperationId,
        contractDigest,
      },
    };
    await expect(
      orchestration.grantAuthorization(principal, missionId, {
        ...authorization,
        preparedOperation: { ...authorization.preparedOperation, contractDigest: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({
      response: { code: "AUTHORIZATION_PREPARED_OPERATION_SCOPE_MISMATCH" },
    });
    await expect(
      orchestration.grantAuthorization(principal, missionId, {
        ...authorization,
        expiresAt: new Date(new Date(expiresAt).getTime() + 1_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      response: { code: "AUTHORIZATION_PREPARED_OPERATION_SCOPE_MISMATCH" },
    });
    const granted = await orchestration.grantAuthorization(principal, missionId, authorization);
    const authorizationId = granted.id;
    expect(granted).toMatchObject({ status: "approved", kind: "protected_mutation" });
    const exactBinding = await database.query(
      `SELECT protected_operation_id AS "protectedOperationId",
              protected_operation_contract_digest AS "contractDigest"
       FROM mission_authorizations WHERE id=$1`,
      [authorizationId],
    );
    expect(exactBinding.rows[0]).toEqual({
      protectedOperationId: reservation.protectedOperationId,
      contractDigest,
    });
    const resume = {
      protectedOperationId: reservation.protectedOperationId,
      publicOperationId: reservation.publicOperationId,
      praxisSessionId: sessionId,
      observedOperationContractDigest: contractDigest,
      ...commitments,
    };
    await expect(prepared.assertResumable(resume)).resolves.toMatchObject({
      authorizationId,
      documentEpoch: 0,
    });
    await expect(
      prepared.assertResumable({ ...resume, inputCommitment: "f".repeat(64) }),
    ).rejects.toMatchObject({ response: { code: "PREPARED_OPERATION_RESUME_AUTHORITY_INVALID" } });
    const createdValueId = randomUUID();
    const createdOrderId = `order-${randomUUID()}`;
    await database.query(
      `INSERT INTO generated_public_values(
         id,project_id,source_run_id,source_protected_operation_id,run_id,operation_id,
         name,reference,scope,mission_id,objective_id,value
       ) VALUES($1,$2,NULL,$3,NULL,$4,'Created order ID','itemId','project',$5,$6,$7)`,
      [
        createdValueId,
        projectId,
        reservation.protectedOperationId,
        reservation.publicOperationId,
        missionId,
        objectiveId,
        createdOrderId,
      ],
    );
    await database.query(
      `UPDATE protected_operations SET program_digest=$2,dispatch_semantics='mutation',
         dispatch_state='acknowledged',mutation_outcome='applied',state='persisted',
         phase='persistence_committed',persisted_references=$3::jsonb
       WHERE id=$1`,
      [
        reservation.protectedOperationId,
        "e".repeat(64),
        JSON.stringify({ itemId: { classification: "public", valueId: createdValueId } }),
      ],
    );
    const initialCheckpoints = await prepared.listCheckpoints(sessionId);
    expect(initialCheckpoints).toMatchObject({
      checkpoints: [
        {
          sourceProtectedOperationId: reservation.protectedOperationId,
          mutationOutcome: "applied",
          dispatchAcknowledged: true,
          permittedContinuations: ["read_only_retrieve", "reconcile"],
          sourceMutationRepeatable: false,
          createdIdentityDigest: createHash("sha256").update(createdOrderId).digest("hex"),
        },
      ],
    });
    await expect(prepared.assertResumable(resume)).rejects.toMatchObject({
      response: { code: "PREPARED_OPERATION_RESUME_AUTHORITY_INVALID" },
    });

    const retrieveFacts = {
      operation: {
        key: "retrieveItem",
        label: "Retrieve item",
        method: "GET" as const,
        pathTemplate: "/items/{itemId}",
        transports: ["fetch" as const],
        classification: "read_only" as const,
        activationControlReference: "context-control-33333333333333333333333333333333",
      },
      inputs: [
        {
          key: "itemId",
          label: "Item ID",
          aliases: ["Order ID"],
          required: true,
          classification: "generated_safe" as const,
          acceptedPresentations: ["plain_text" as const],
          controlReference: "context-control-44444444444444444444444444444444",
        },
      ],
      auth: { presentationClasses: [] },
      response: {
        statusClasses: [2],
        confirmedNotAppliedStatuses: [],
        safeOutputKeys: ["itemId"],
        safeOutputs: [{ key: "itemId", label: "id", classification: "public" as const }],
        publicIdentityOutputPath: "$.itemId",
        continuation: "none" as const,
      },
      retrieval: { canonicalTargetFieldKey: "itemId", pathTemplate: "/items/{itemId}" },
    };
    const retrieveDigest = digest({ ...provenance, facts: retrieveFacts });
    const [retrieveContract] = await prepared.recordObservedContracts([
      { id: randomUUID(), digest: retrieveDigest, ...provenance, ...retrieveFacts },
    ]);
    const retrieveValues = [
      {
        canonicalFieldKey: "itemId",
        targetReference: "context-control-44444444444444444444444444444444",
        presentationClass: "plain_text" as const,
        source: { kind: "generated_safe" as const, valueId: createdValueId },
      },
    ];
    const retrieveOutputs = [{ key: "itemId", classification: "public" as const }];
    const retrieveCommitments = {
      targetCommitment: digest(
        retrieveValues.map((value) => ({
          key: value.canonicalFieldKey,
          targetReference: value.targetReference,
        })),
      ),
      inputCommitment: digest(
        retrieveValues.map((value) => ({
          key: value.canonicalFieldKey,
          presentationClass: value.presentationClass,
          sourceCommitment: digest(value.source),
        })),
      ),
      outputCommitment: digest(retrieveOutputs),
    };
    const retrieveReservation = await prepared.reserve({
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      praxisSessionId: sessionId,
      publicOperationId: `prepared-retrieve-${randomUUID()}`,
      observedOperationContractId: retrieveContract!.id,
      observedOperationContractDigest: retrieveDigest,
      documentEpoch: 0,
      ...retrieveCommitments,
      values: retrieveValues,
      expectedOutputs: retrieveOutputs,
      expiresAt,
    });
    const continuationClaim = {
      checkpointId: initialCheckpoints.checkpoints[0]!.id,
      consumerProtectedOperationId: retrieveReservation.protectedOperationId,
      continuation: "read_only_retrieve",
      sourceOutputReference: "itemId",
      canonicalFieldKey: "itemId",
      targetReference: "context-control-44444444444444444444444444444444",
      presentationClass: "plain_text",
      expiresAt,
    } as const;
    await expect(prepared.claimContinuation(randomUUID(), continuationClaim)).rejects.toMatchObject(
      {
        response: { code: "MISSION_OPERATION_CONTINUATION_UNAVAILABLE" },
      },
    );
    await prepared.claimContinuation(sessionId, continuationClaim);
    const retrieveAuthorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(id,mission_id,objective_id,environment_id,kind,reason,
         status,granted_by_agent_session_id,expires_at,operation_id,praxis_session_id,
         protected_operation_id,protected_operation_contract_digest)
       VALUES($1,$2,$3,$4,'protected_mutation','Retrieve integration','approved',$5,$6,$7,$8,$9,$10)`,
      [
        retrieveAuthorizationId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        expiresAt,
        retrieveReservation.publicOperationId,
        sessionId,
        retrieveReservation.protectedOperationId,
        retrieveDigest,
      ],
    );
    await database.query(
      `UPDATE protected_operations SET authorization_id=$2,state='planned',phase='planned'
       WHERE id=$1 AND state='reserved'`,
      [retrieveReservation.protectedOperationId, retrieveAuthorizationId],
    );
    const retrievedValueId = randomUUID();
    await database.query(
      `INSERT INTO generated_public_values(
         id,project_id,source_run_id,source_protected_operation_id,run_id,operation_id,
         name,reference,scope,mission_id,objective_id,value
       ) VALUES($1,$2,NULL,$3,NULL,$4,'Retrieved order ID','itemId','project',$5,$6,$7)`,
      [
        retrievedValueId,
        projectId,
        retrieveReservation.protectedOperationId,
        retrieveReservation.publicOperationId,
        missionId,
        objectiveId,
        createdOrderId,
      ],
    );
    await database.query(
      `UPDATE protected_operations SET program_digest=$2,dispatch_semantics='read_only',
         dispatch_state='acknowledged',mutation_outcome='not_applied',state='persisted',
         phase='persistence_committed',persisted_references=$3::jsonb
       WHERE id=$1`,
      [
        retrieveReservation.protectedOperationId,
        "d".repeat(64),
        JSON.stringify({ itemId: { classification: "public", valueId: retrievedValueId } }),
      ],
    );
    await expect(prepared.listCheckpoints(sessionId)).resolves.toMatchObject({
      checkpoints: [
        {
          state: "completed",
          sourceMutationRepeatable: false,
          retrievedIdentityDigest: createHash("sha256").update(createdOrderId).digest("hex"),
          identityMatches: true,
        },
      ],
    });

    const abandonedReservation = await prepared.reserve({
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      praxisSessionId: sessionId,
      publicOperationId: `prepared-abandoned-${randomUUID()}`,
      observedOperationContractId: contract!.id,
      observedOperationContractDigest: contractDigest,
      documentEpoch: 0,
      ...commitments,
      values,
      expectedOutputs,
      expiresAt,
    });
    await expect(prepared.abandonReservedForSession(sessionId)).resolves.toEqual({
      abandoned: [abandonedReservation.protectedOperationId],
    });
    const abandonedTruth = await database.query(
      `SELECT operation.state,operation.mutation_outcome AS "mutationOutcome",
              operation.dispatch_state AS "dispatchState",operation.authorization_id AS "authorizationId",
              binding.state AS "bindingState",transition.from_state AS "fromState",
              transition.to_state AS "toState"
         FROM protected_operations operation
         JOIN operation_value_bindings binding
           ON binding.consumer_protected_operation_id=operation.id
         JOIN protected_operation_transitions transition
           ON transition.protected_operation_id=operation.id AND transition.to_state='abandoned'
        WHERE operation.id=$1`,
      [abandonedReservation.protectedOperationId],
    );
    expect(abandonedTruth.rows[0]).toEqual({
      state: "abandoned",
      mutationOutcome: "not_applied",
      dispatchState: "not_started",
      authorizationId: null,
      bindingState: "revoked",
      fromState: "reserved",
      toState: "abandoned",
    });
    await expect(prepared.abandonReservedForSession(sessionId)).resolves.toEqual({ abandoned: [] });

    const lossReservation = await prepared.reserve({
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      praxisSessionId: sessionId,
      publicOperationId: `prepared-loss-${randomUUID()}`,
      observedOperationContractId: contract!.id,
      observedOperationContractDigest: contractDigest,
      documentEpoch: 0,
      ...commitments,
      values,
      expectedOutputs,
      expiresAt,
    });
    const lossAuthorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(id,mission_id,objective_id,environment_id,kind,reason,
         status,granted_by_agent_session_id,expires_at,operation_id,praxis_session_id,
         protected_operation_id,protected_operation_contract_digest)
       VALUES($1,$2,$3,$4,'protected_mutation','Loss integration','approved',$5,$6,$7,$8,$9,$10)`,
      [
        lossAuthorizationId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        expiresAt,
        lossReservation.publicOperationId,
        sessionId,
        lossReservation.protectedOperationId,
        contractDigest,
      ],
    );
    await database.query(
      `UPDATE protected_operations SET authorization_id=$2,state='planned',phase='planned'
       WHERE id=$1 AND state='reserved'`,
      [lossReservation.protectedOperationId, lossAuthorizationId],
    );
    const unknownReservation = await prepared.reserve({
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      praxisSessionId: sessionId,
      publicOperationId: `prepared-unknown-${randomUUID()}`,
      observedOperationContractId: contract!.id,
      observedOperationContractDigest: contractDigest,
      documentEpoch: 0,
      ...commitments,
      values,
      expectedOutputs,
      expiresAt,
    });
    const unknownAuthorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(id,mission_id,objective_id,environment_id,kind,reason,
         status,granted_by_agent_session_id,expires_at,operation_id,praxis_session_id,
         protected_operation_id,protected_operation_contract_digest)
       VALUES($1,$2,$3,$4,'protected_mutation','Unknown integration','approved',$5,$6,$7,$8,$9,$10)`,
      [
        unknownAuthorizationId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        expiresAt,
        unknownReservation.publicOperationId,
        sessionId,
        unknownReservation.protectedOperationId,
        contractDigest,
      ],
    );
    await database.query(
      `UPDATE protected_operations SET authorization_id=$2,state='dispatching',phase='dispatching',
         program_digest=$3,dispatch_semantics='mutation',dispatch_state='started',
         mutation_outcome='unknown'
       WHERE id=$1 AND state='reserved'`,
      [unknownReservation.protectedOperationId, unknownAuthorizationId, "c".repeat(64)],
    );
    await sessions.settleRuntimeOwnerLoss({
      sessionId,
      ownerId,
      fencingToken: 1,
      runtimePresent: false,
      recoveryObservationAvailable: false,
      reasonCode: "TEST_PROCESS_LOSS",
    });
    const converged = await database.query<{ state: string; mutationOutcome: string }>(
      `SELECT state,mutation_outcome AS "mutationOutcome" FROM protected_operations WHERE id=$1`,
      [lossReservation.protectedOperationId],
    );
    expect(converged.rows[0]).toEqual({
      state: "failed_not_applied",
      mutationOutcome: "not_applied",
    });
    const unknownConverged = await database.query<{
      state: string;
      mutationOutcome: string;
      recoveryClass: string;
    }>(
      `SELECT state,mutation_outcome AS "mutationOutcome",
              recovery_class AS "recoveryClass"
       FROM protected_operations WHERE id=$1`,
      [unknownReservation.protectedOperationId],
    );
    expect(unknownConverged.rows[0]).toEqual({
      state: "recovery_required",
      mutationOutcome: "unknown",
      recoveryClass: "reconciliation_required",
    });
  });
});

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
