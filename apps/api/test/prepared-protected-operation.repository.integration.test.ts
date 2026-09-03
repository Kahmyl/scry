import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreparedOperationValueBinding, ProposedOperationContract } from "@scry/contracts";

import { OperationContractRegistry } from "../src/adaptive-sessions/operation-contract.registry.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { PreparedProtectedOperationRepository } from "../src/adaptive-sessions/repositories/prepared-protected-operation.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { compilePreparedProtectedOperation } from "../src/adaptive-sessions/prepared-protected-operation.compiler.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "../src/runtime/repositories/protected-output-persistence.repository.js";
import { MissionService } from "../src/missions/mission.service.js";

const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("canonical prepared execution authority", () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const ownerId = randomUUID();
  const userId = randomUUID();
  const principal = {
    kind: "user" as const,
    subject: userId,
    userId,
    email: "canonical@example.test",
    workspaceId,
    role: "owner" as const,
  };
  let sessionId: string;
  let database: Database;
  let sessions: AdaptiveSessionRepository;
  let contracts: OperationContractRegistry;
  let prepared: PreparedProtectedOperationRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    sessions = new AdaptiveSessionRepository(database);
    contracts = new OperationContractRegistry(database);
    prepared = new PreparedProtectedOperationRepository(database);
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Canonical',$2)`, [
      workspaceId,
      `canonical-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Canonical')`, [
      projectId,
      workspaceId,
    ]);
    await database.query(`INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$1,$2)`, [
      userId,
      principal.email,
    ]);
    await database.query(
      `INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')`,
      [workspaceId, userId],
    );
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Canonical','https://example.test',$3::jsonb)`,
      [
        environmentId,
        projectId,
        JSON.stringify({
          allowedOrigins: ["https://example.test"],
          trustedScriptOrigins: [],
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
      `INSERT INTO missions(id,project_id,title,original_instruction,max_business_mutation_dispatches)
       VALUES($1,$2,'Canonical','Create one item and one isolated loss control',2)`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
       VALUES($1,$2,'Create','{}'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','Canonical',$3)`,
      [agentSessionId, missionId, `canonical-agent-${agentSessionId}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,
         content,plan,created_by_agent_session_id)
       VALUES($1,$2,$3,$4,$5,'Canonical','{}'::jsonb,'{}'::jsonb,$6)`,
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
      idempotencyKey: `canonical-session-${randomUUID()}`,
      protection: "protected",
    });
    sessionId = created.id;
    await sessions.activateProvisionedSession(sessionId);
    await sessions.claimRuntimeLease({ sessionId, ownerId, leaseDurationMs: 60_000 });
  });

  afterAll(async () => database?.onModuleDestroy());

  it("separates durable semantics from interaction authority and allocates mutation identity once", async () => {
    const [entry] = await contracts.register(sessionId, [proposal(sessionId)]);
    expect(entry!.revision.facts.operation).not.toHaveProperty("activationControlReference");
    expect(entry!.revision.facts.inputs[0]).not.toHaveProperty("controlReference");
    expect(entry!.interaction).toMatchObject({ runtimeOwnerId: ownerId, fencingEpoch: 1 });
    expect((await contracts.readDurable(sessionId))[0]).not.toHaveProperty("interaction");
    const concurrent = await Promise.all([
      contracts.register(sessionId, [proposal(sessionId)]),
      contracts.register(sessionId, [proposal(sessionId)]),
    ]);
    expect(concurrent[0]![0]!.revision.id).toBe(concurrent[1]![0]!.revision.id);
    expect(concurrent[0]![0]!.interaction!.id).toBe(concurrent[1]![0]!.interaction!.id);

    const values = [
      {
        canonicalFieldKey: "itemName",
        targetReference: "context-control-22222222222222222222222222222222",
        presentationClass: "plain_text" as const,
        source: { kind: "literal_public" as const, value: "one item" },
      },
    ];
    const expectedOutputs = [{ key: "itemId", classification: "public" as const }];
    const reservation = await prepared.reserve(sessionId, {
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      publicOperationId: "public-create-item",
      operationContractRevisionId: entry!.revision.id,
      operationContractRevisionDigest: entry!.revision.digest,
      runtimeInteractionCapabilityId: entry!.interaction!.id,
      values,
      expectedOutputs,
    });
    expect(Date.parse(reservation.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(reservation.expiresAt)).toBeLessThanOrEqual(
      Date.parse(entry!.interaction!.expiresAt),
    );
    expect(Date.parse(reservation.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000);
    await expect(
      prepared.reserve(sessionId, {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        publicOperationId: "expired-explicit-deadline",
        operationContractRevisionId: entry!.revision.id,
        operationContractRevisionDigest: entry!.revision.digest,
        runtimeInteractionCapabilityId: entry!.interaction!.id,
        values,
        expectedOutputs,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ response: { code: "PREPARED_OPERATION_ALREADY_EXPIRED" } });
    expect(reservation.mutationIdentity).not.toBe(reservation.publicOperationId);
    const authority = await database.query(
      `SELECT operation.mutation_identity AS "operationMutationIdentity",
              capability.mutation_identity AS "capabilityMutationIdentity",
              operation.authority_model AS "authorityModel",capability.state,
              policy.digest AS "policyDigest",capability.target_commitment AS "targetCommitment"
         FROM protected_operations operation
         JOIN prepared_execution_capabilities capability
           ON capability.id=operation.prepared_execution_capability_id
         JOIN execution_policy_snapshots policy ON policy.id=capability.execution_policy_snapshot_id
        WHERE operation.id=$1`,
      [reservation.protectedOperationId],
    );
    expect(authority.rows[0]).toMatchObject({
      operationMutationIdentity: reservation.mutationIdentity,
      capabilityMutationIdentity: reservation.mutationIdentity,
      authorityModel: "canonical",
      state: "reserved",
    });
    expect(authority.rows[0]!.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(authority.rows[0]!.targetCommitment).toBe(
      digest(
        values.map((value) => ({
          key: value.canonicalFieldKey,
          targetReference: value.targetReference,
        })),
      ),
    );

    // Each adverse fact is transaction-local; exercise production admission and
    // roll back without contaminating the valid runtime used by the next case.
    for (const sql of [
      "UPDATE adaptive_session_runtime_leases SET owner_id=gen_random_uuid() WHERE session_id=$1",
      "UPDATE adaptive_session_runtime_leases SET fencing_token=fencing_token+1 WHERE session_id=$1",
      "UPDATE adaptive_session_runtime_leases SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1",
      "UPDATE runtime_interaction_capabilities SET state='expired' WHERE praxis_session_id=$1",
    ]) {
      await database.transaction(async (client) => {
        await client.query("SAVEPOINT runtime_case");
        try {
          await client.query(sql, [sessionId]);
          const scoped = new PreparedProtectedOperationRepository({
            transaction: async (work: (connection: typeof client) => Promise<unknown>) =>
              work(client),
          } as Database);
          await expect(
            scoped.reserve(sessionId, {
              projectId,
              environmentId,
              missionId,
              objectiveId,
              agentSessionId,
              publicOperationId: `refused-${randomUUID()}`,
              operationContractRevisionId: entry!.revision.id,
              operationContractRevisionDigest: entry!.revision.digest,
              runtimeInteractionCapabilityId: entry!.interaction!.id,
              values,
              expectedOutputs,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          ).rejects.toMatchObject({
            response: { code: "PREPARED_OPERATION_INTERACTION_AUTHORITY_INVALID" },
          });
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT runtime_case");
        }
      });
    }
    const replacement = proposal(sessionId);
    replacement.interaction.documentEpoch = 1;
    await contracts.register(sessionId, [replacement]);
    await expect(
      prepared.reserve(sessionId, {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        publicOperationId: "stale-interaction-must-fail",
        operationContractRevisionId: entry!.revision.id,
        operationContractRevisionDigest: entry!.revision.digest,
        runtimeInteractionCapabilityId: entry!.interaction!.id,
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
        values,
        expectedOutputs,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      response: { code: "PREPARED_OPERATION_INTERACTION_AUTHORITY_INVALID" },
    });

    await prepared.abandonReservedForSession(sessionId);
    await sessions.releaseRuntimeLease({ sessionId, ownerId, fencingToken: 1 });
    const durable = await contracts.readDurable(sessionId);
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({ executableInteractionAvailable: false });
    expect(durable[0]!.interaction).toBeUndefined();
  });
  it("keeps canonical Chronicle identity across owner rotation and grants only the exact read-only continuation", async () => {
    await sessions.closeAtSafeBoundary({ workspaceId, sessionId, idempotencyKey: "close-owner-a" });
    const openOwner = async () => {
      const created = await sessions.create(workspaceId, {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        flowDraftId,
        objective: "Canonical continuation",
        allowedOrigins: ["https://example.test"],
        protection: "protected",
        idempotencyKey: `owner-${randomUUID()}`,
      });
      sessionId = created.id;
      await sessions.activateProvisionedSession(sessionId);
      const owner = randomUUID();
      await sessions.claimRuntimeLease({ sessionId, ownerId: owner, leaseDurationMs: 60_000 });
      return owner;
    };
    const ownerB = await openOwner();
    const reserve = async (
      contract: ProposedOperationContract,
      values: PreparedOperationValueBinding[],
      continuationReference?: string,
    ) => {
      const [entry] = await contracts.register(sessionId, [contract]);
      const expectedOutputs = [{ key: "itemId", classification: "public" as const }];
      return prepared.reserve(sessionId, {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        publicOperationId: `canonical-${randomUUID()}`,
        operationContractRevisionId: entry!.revision.id,
        operationContractRevisionDigest: entry!.revision.digest,
        runtimeInteractionCapabilityId: entry!.interaction!.id,
        continuationReference,
        values,
        expectedOutputs,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    };
    const create = await reserve(proposal(sessionId), [
      {
        canonicalFieldKey: "itemName",
        targetReference: "context-control-22222222222222222222222222222222",
        presentationClass: "plain_text",
        source: { kind: "literal_public", value: "canonical-item" },
      },
    ]);
    const complete = async (reserved: Awaited<ReturnType<typeof reserve>>, identity: string) => {
      const exact = {
        protectedOperationId: reserved.protectedOperationId,
        preparedExecutionCapabilityId: reserved.preparedExecutionCapabilityId,
        publicOperationId: reserved.publicOperationId,
      };
      const material = await prepared.executionMaterial(sessionId, exact);
      const compiled = compilePreparedProtectedOperation({
        material,
        entryUrl: "https://example.test/items",
      });
      const protection = await prepared.finalizeExecutionCapability(
        exact.preparedExecutionCapabilityId,
        compiled.transaction,
      );
      await sessions.beginMissionOperation({
        workspaceId,
        sessionId,
        intent: compiled.intent,
        operationId: reserved.publicOperationId,
        idempotencyKey: reserved.publicOperationId,
        action: compiled.transaction,
        expectedEffect: { type: "none" },
        mode: "transact",
        protectedReservation: protection,
        earlyProtectedOperationId: reserved.protectedOperationId,
        preparedProtectedOperationId: reserved.protectedOperationId,
      });
      await prepared.consumeGeneratedBindings(reserved.protectedOperationId);
      const operations = new ProtectedOperationRepository(database);
      const leaseOwner = randomUUID();
      let claim = await operations.claim({
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId: reserved.publicOperationId,
        leaseOwner,
        leaseDurationMs: 60_000,
        binding: {
          projectId,
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
          flowDraftId,
          mutationIdentity: reserved.mutationIdentity,
          programDigest: protection.programDigest,
          dispatchSemantics: protection.dispatchSemantics,
          safeOutputManifest: protection.safeOutputManifest,
          preparedExecutionCapabilityId: exact.preparedExecutionCapabilityId,
        },
      });
      for (const next of [
        "preparing",
        "ready_to_dispatch",
        "dispatching",
        "dispatched",
        "acquiring",
        "persisting",
      ] as const) {
        claim = await operations.transition({
          id: claim.id,
          leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
          expected: claim.state,
          next,
          phase: next,
        });
        if (next === "dispatched")
          claim = await operations.settleMutationOutcome({
            id: claim.id,
            leaseOwner,
            fencingToken: claim.fencingToken,
            version: claim.version,
            outcome: protection.dispatchSemantics === "read_only" ? "not_applied" : "applied",
          });
      }
      const persisted = await new ProtectedOutputPersistenceRepository(
        database,
      ).persistOutputsAtomically(
        {
          protectedOperationId: claim.id,
          projectId,
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
          ownerKind: "authoring_session",
          ownerId: sessionId,
          operationId: reserved.publicOperationId,
          leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
        },
        [
          {
            reference: "itemId",
            classification: "public",
            storageName: protection.safeOutputManifest[0]!.storageName,
            value: identity,
            scope: "project",
          },
        ],
      );
      claim = { ...claim, ...persisted.claim };
      for (const next of ["reconciling", "completed"] as const)
        claim = await operations.transition({
          id: claim.id,
          leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
          expected: claim.state,
          next,
          phase: next,
        });
      await sessions.projectProtectedOperationForAuthoring({
        sessionId,
        operationId: reserved.publicOperationId,
      });
    };
    await complete(create, "item-exact-42");
    await expect(complete(create, "item-exact-42")).rejects.toBeDefined();
    const sourceSessionId = sessionId;
    await sessions.closeAtSafeBoundary({ workspaceId, sessionId, idempotencyKey: "close-owner-b" });
    await sessions.releaseRuntimeLease({ sessionId, ownerId: ownerB, fencingToken: 1 });
    await openOwner();
    const checkpoints = await prepared.listCheckpoints(sessionId);
    expect(checkpoints.checkpoints).toHaveLength(1);
    const checkpoint = checkpoints.checkpoints[0]!;
    const discovered = await prepared.listMissionValues({ projectId, environmentId, missionId });
    expect(discovered.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalOutputKey: "itemId",
          producerProtectedOperationId: create.protectedOperationId,
          producerMissionId: missionId,
          classification: "public",
        }),
      ]),
    );
    expect(JSON.stringify(discovered)).not.toContain("item-exact-42");
    expect(JSON.stringify(discovered)).not.toMatch(
      /ciphertext|projectCredentialId|runtimeOwnerId|fencingEpoch/,
    );
    expect(checkpoint).toMatchObject({
      state: "available",
      sourceProtectedOperationId: create.protectedOperationId,
      persistedReferences: {
        itemId: { classification: "public", identityRole: "resource_identity" },
      },
    });
    const retrieved: ProposedOperationContract = proposal(sessionId);
    delete retrieved.facts.resourceEffect;
    retrieved.facts.operation = {
      ...retrieved.facts.operation,
      key: "retrieveItem",
      label: "Retrieve item",
      method: "GET",
      pathTemplate: "/items/{itemId}",
      semantics: { dispatch: "read_only", effects: ["read"] },
    };
    delete retrieved.facts.response.mutationPolicy;
    retrieved.facts.response.continuation = "none";
    retrieved.facts.inputs = [
      {
        key: "itemId",
        label: "Item ID",
        aliases: [],
        classification: "generated_safe",
        required: true,
        acceptedPresentations: ["plain_text"],
      },
    ];
    retrieved.facts.retrieval = {
      canonicalTargetFieldKey: "itemId",
      pathTemplate: "/items/{itemId}",
    };
    retrieved.interaction.inputControlReferences = {
      itemId: "context-control-22222222222222222222222222222222",
    };
    const continuations = await prepared.listContinuations(sessionId);
    expect(continuations.continuations).toEqual([
      expect.objectContaining({
        continuationReference: checkpoint.id,
        sourceOperationId: create.protectedOperationId,
        readOnly: true,
      }),
    ]);
    expect(JSON.stringify(continuations)).not.toContain("item-exact-42");
    // A fully valid consumer in another Project cannot bind this Mission's asset.
    const foreign = Object.fromEntries(
      ["project", "environment", "mission", "objective", "agent", "draft", "owner"].map((key) => [
        key,
        randomUUID(),
      ]),
    ) as Record<string, string>;
    await database.query(
      "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Foreign consumer')",
      [foreign.project, workspaceId],
    );
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
      SELECT $1,$2,'Foreign','https://example.test',policy FROM environments WHERE id=$3`,
      [foreign.environment, foreign.project, environmentId],
    );
    await database.query(
      "INSERT INTO missions(id,project_id,title,original_instruction) VALUES($1,$2,'Foreign','Retrieve foreign item')",
      [foreign.mission, foreign.project],
    );
    await database.query(
      "INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'Retrieve','{}',0)",
      [foreign.objective, foreign.mission],
    );
    await database.query(
      "INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','Foreign',$3)",
      [foreign.agent, foreign.mission, `foreign-${foreign.agent}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,content,plan,created_by_agent_session_id)
      VALUES($1,$2,$3,$4,$5,'Foreign','{}','{}',$6)`,
      [
        foreign.draft,
        foreign.project,
        foreign.mission,
        foreign.objective,
        foreign.environment,
        foreign.agent,
      ],
    );
    const foreignSession = await sessions.create(workspaceId, {
      projectId: foreign.project!,
      environmentId: foreign.environment!,
      missionId: foreign.mission!,
      objectiveId: foreign.objective!,
      agentSessionId: foreign.agent!,
      flowDraftId: foreign.draft!,
      objective: "Retrieve",
      allowedOrigins: ["https://example.test"],
      protection: "protected",
      idempotencyKey: `foreign-${randomUUID()}`,
    });
    await sessions.activateProvisionedSession(foreignSession.id);
    await sessions.claimRuntimeLease({
      sessionId: foreignSession.id,
      ownerId: foreign.owner!,
      leaseDurationMs: 60_000,
    });
    const foreignContract = structuredClone(retrieved);
    foreignContract.provenance.sourcePraxisSessionId = foreignSession.id;
    foreignContract.interaction.praxisSessionId = foreignSession.id;
    const [foreignEntry] = await contracts.register(foreignSession.id, [foreignContract]);
    await expect(
      prepared.reserve(foreignSession.id, {
        projectId: foreign.project!,
        environmentId: foreign.environment!,
        missionId: foreign.mission!,
        objectiveId: foreign.objective!,
        agentSessionId: foreign.agent!,
        publicOperationId: `foreign-${randomUUID()}`,
        operationContractRevisionId: foreignEntry!.revision.id,
        operationContractRevisionDigest: foreignEntry!.revision.digest,
        runtimeInteractionCapabilityId: foreignEntry!.interaction!.id,
        values: [
          {
            canonicalFieldKey: "itemId",
            targetReference: foreignContract.interaction.inputControlReferences.itemId!,
            presentationClass: "plain_text",
            source: { kind: "generated_safe", valueAssetId: discovered.items[0]!.valueAssetId },
          },
        ],
        expectedOutputs: [{ key: "itemId", classification: "public" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ response: { code: "GENERATED_VALUE_ASSET_INVALID" } });
    await sessions.closeAtSafeBoundary({
      workspaceId,
      sessionId: foreignSession.id,
      idempotencyKey: "foreign-control-close",
    });
    await sessions.releaseRuntimeLease({
      sessionId: foreignSession.id,
      ownerId: foreign.owner!,
      fencingToken: 1,
    });

    const beforeRefusals = await database.query(
      "SELECT count(*)::int AS count FROM protected_operations WHERE mission_id=$1",
      [missionId],
    );
    await expect(
      reserve(
        retrieved,
        [
          {
            canonicalFieldKey: "itemId",
            targetReference: retrieved.interaction.inputControlReferences.itemId!,
            presentationClass: "plain_text",
            source: { kind: "generated_safe", valueAssetId: randomUUID() },
          },
        ],
        checkpoint.id,
      ),
    ).rejects.toMatchObject({ response: { code: "CONTINUATION_TARGET_ALREADY_BOUND" } });
    const incompatible = structuredClone(retrieved);
    incompatible.facts.operation.key = "incompatibleRetrieve";
    incompatible.facts.inputs[0]!.classification = "protected";
    incompatible.facts.inputs[0]!.acceptedPresentations = ["protected_text"];
    await expect(reserve(incompatible, [], checkpoint.id)).rejects.toMatchObject({
      response: { code: "CONTINUATION_TARGET_INCOMPATIBLE" },
    });
    await expect(reserve(retrieved, [], randomUUID())).rejects.toMatchObject({
      response: { code: "MISSION_OPERATION_CONTINUATION_UNAVAILABLE" },
    });
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM protected_operations WHERE mission_id=$1",
          [missionId],
        )
      ).rows,
    ).toEqual(beforeRefusals.rows);
    const contenders = await Promise.allSettled([
      reserve(retrieved, [], checkpoint.id),
      reserve(retrieved, [], checkpoint.id),
    ]);
    expect(contenders.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((item) => item.status === "rejected")).toHaveLength(1);
    const retrieve = (
      contenders.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<typeof reserve>>
      >
    ).value;
    await expect(reserve(retrieved, [], checkpoint.id)).rejects.toMatchObject({
      response: { code: "MISSION_OPERATION_CONTINUATION_UNAVAILABLE" },
    });
    const grants = await database.query(
      `SELECT canonical_field_key,use_count,state FROM value_use_grants WHERE consumer_protected_operation_id=$1`,
      [retrieve.protectedOperationId],
    );
    expect(grants.rows).toEqual([{ canonical_field_key: "itemId", use_count: 0, state: "active" }]);
    const approvals = await database.query(
      `SELECT count(*)::int AS count FROM mission_authorizations WHERE mission_id=$1`,
      [missionId],
    );
    expect(approvals.rows[0]!.count).toBe(0);
    await complete(retrieve, "item-exact-42");
    expect((await prepared.listCheckpoints(sessionId)).checkpoints[0]).toMatchObject({
      state: "completed",
      identityMatches: true,
      sourceMutationRepeatable: false,
    });
    const provenance = await database.query(
      `SELECT canonical_output_key,transport_extractor FROM typed_value_assets WHERE producer_protected_operation_id=$1`,
      [create.protectedOperationId],
    );
    expect(provenance.rows[0]).toMatchObject({
      canonical_output_key: "itemId",
      transport_extractor: { kind: "json_path", path: "$.data.id" },
    });
  });
  it("materializes synthetic inputs atomically under the reserved operation's canonical policy", async () => {
    await database.query(
      `UPDATE environments SET policy=jsonb_set(policy,'{protectedSyntheticInputs}',$2::jsonb) WHERE id=$1`,
      [
        environmentId,
        JSON.stringify({
          enabled: true,
          generators: [
            {
              contract: "opaque_operation_token",
              version: 1,
              purposes: ["test_order_qualification"],
              resourceScopes: [{ resourceKind: "item", operation: "create" }],
            },
          ],
        }),
      ],
    );
    const contract = proposal(sessionId);
    contract.facts.operation.key = "createSyntheticItem";
    delete contract.facts.resourceEffect!.correlationFieldKey;
    contract.facts.inputs[0]!.classification = "protected";
    contract.facts.inputs[0]!.acceptedPresentations = ["protected_text"];
    const [entry] = await contracts.register(sessionId, [contract]);
    const values: PreparedOperationValueBinding[] = [
      {
        canonicalFieldKey: "itemName",
        targetReference: contract.interaction.inputControlReferences.itemName!,
        presentationClass: "protected_text",
        source: {
          kind: "synthetic_protected",
          declaration: {
            semantic: "itemName",
            generatorContract: "opaque_operation_token",
            generatorVersion: 1,
            purpose: "test_order_qualification",
          },
        },
      },
    ];
    const expectedOutputs = [{ key: "itemId", classification: "public" as const }];
    const reserved = await prepared.reserve(sessionId, {
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      publicOperationId: `synthetic-${randomUUID()}`,
      operationContractRevisionId: entry!.revision.id,
      operationContractRevisionDigest: entry!.revision.digest,
      runtimeInteractionCapabilityId: entry!.interaction!.id,
      targetCommitment: digest(
        values.map((v) => ({ key: v.canonicalFieldKey, targetReference: v.targetReference })),
      ),
      inputCommitment: digest(
        values.map((v) => ({
          key: v.canonicalFieldKey,
          presentationClass: v.presentationClass,
          sourceCommitment: digest(v.source),
        })),
      ),
      outputCommitment: digest(expectedOutputs),
      values,
      expectedOutputs,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const binding = await database.query(
      `SELECT source.id,source.protected_operation_id,source.commitment,
      binding.source_reference_id FROM operation_bound_protected_inputs source
      JOIN operation_value_bindings binding ON binding.source_reference_id=source.id
      WHERE source.protected_operation_id=$1`,
      [reserved.protectedOperationId],
    );
    expect(binding.rows).toHaveLength(1);
    expect(binding.rows[0]).toMatchObject({
      protected_operation_id: reserved.protectedOperationId,
      source_reference_id: binding.rows[0]!.id,
      commitment: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(reserved)).not.toContain("ciphertext");
    const exact = {
      protectedOperationId: reserved.protectedOperationId,
      preparedExecutionCapabilityId: reserved.preparedExecutionCapabilityId,
      publicOperationId: reserved.publicOperationId,
    };
    const material = await prepared.executionMaterial(sessionId, exact);
    const compiled = compilePreparedProtectedOperation({
      material,
      entryUrl: "https://example.test/items",
    });
    const protection = await prepared.finalizeExecutionCapability(
      reserved.preparedExecutionCapabilityId,
      compiled.transaction,
    );
    await sessions.beginMissionOperation({
      workspaceId,
      sessionId,
      intent: compiled.intent,
      operationId: reserved.publicOperationId,
      idempotencyKey: reserved.publicOperationId,
      action: compiled.transaction,
      expectedEffect: { type: "none" },
      mode: "transact",
      protectedReservation: protection,
      earlyProtectedOperationId: reserved.protectedOperationId,
      preparedProtectedOperationId: reserved.protectedOperationId,
    });
    await expect(
      sessions.resolveProtectedInput(sessionId, "wrong-consumer", binding.rows[0]!.id),
    ).rejects.toBeDefined();
    const value = await sessions.resolveProtectedInput(
      sessionId,
      reserved.publicOperationId,
      binding.rows[0]!.id,
    );
    expect(createHash("sha256").update(value).digest("hex")).toBe(binding.rows[0]!.commitment);
    await expect(
      sessions.resolveProtectedInput(sessionId, reserved.publicOperationId, binding.rows[0]!.id),
    ).rejects.toBeDefined();
    await sessions.settlePreparedExecutionDeadline({
      sessionId,
      operationId: reserved.publicOperationId,
      reasonCode: "A1_SYNTHETIC_NO_DISPATCH",
    });
    await sessions.projectProtectedOperationForAuthoring({
      sessionId,
      operationId: reserved.publicOperationId,
    });
  });
  it("settles an intermediate observation boundary after fresh facts without hiding UNKNOWN", async () => {
    await database.transaction(async (client) => {
      await client.query("SAVEPOINT observation_readiness_fixture");
      try {
        const failedId = `recovered-login-${randomUUID()}`;
        const unknownId = `uncertain-resource-${randomUUID()}`;
        for (const [index, operationId, outcome] of [
          [0, failedId, "applied"],
          [1, unknownId, "unknown"],
        ] as const) {
          await client.query(
            `INSERT INTO adaptive_operations(session_id,operation_id,sequence,mode,state,
              semantic_intent,expected_effect,policy_digest,idempotency_key,mission_id,
              objective_id,flow_draft_id,authoring_intent,derived_action,mutation_outcome,
              functional_result,privacy_result,decision_boundary)
             VALUES($1,$2,9000+$3,'observe','failed','{}','{}',$4,$2,$5,$6,$7,
               '{"action":{"kind":"activate"}}','{}',$8,'failed','verified',
               '{"type":"effect_observation_required","reasonCode":"EXPECTED_EFFECT_NOT_OBSERVED"}')`,
            [
              sessionId,
              operationId,
              index,
              "a".repeat(64),
              missionId,
              objectiveId,
              flowDraftId,
              outcome,
            ],
          );
        }
        const service = new MissionService(database) as unknown as {
          loadCompletionReadiness: (
            query: unknown,
            missionId: string,
            objectiveId?: string,
          ) => Promise<{ blockers: Array<{ operationId?: string; code: string }> }>;
        };
        const read = (objective?: string) =>
          service.loadCompletionReadiness(client.query.bind(client), missionId, objective);
        await client.query(
          `INSERT INTO adaptive_observations(session_id,operation_id,document_epoch,safe_summary)
           VALUES($1,$2,1,'{}')`,
          [sessionId, failedId],
        );
        // A completed outcome alone cannot satisfy an outstanding request for fresh facts.
        expect((await read()).blockers).toContainEqual(
          expect.objectContaining({
            operationId: failedId,
            code: "EFFECT_OBSERVATION_REQUIRED",
          }),
        );
        await client.query(
          `INSERT INTO adaptive_observations(session_id,operation_id,document_epoch,safe_summary)
           VALUES($1,$2,2,'{}')`,
          [sessionId, unknownId],
        );
        for (const objective of [undefined, objectiveId]) {
          const readiness = await read(objective);
          expect(readiness.blockers.filter((b) => b.operationId === failedId)).toEqual([]);
          expect(readiness.blockers).toContainEqual(
            expect.objectContaining({
              operationId: unknownId,
              code: "MUTATION_RECONCILIATION_REQUIRED",
            }),
          );
        }
        expect(
          (
            await client.query(
              `SELECT state,mutation_outcome,decision_boundary->>'type' AS boundary FROM adaptive_operations
           WHERE session_id=$1 AND operation_id=$2`,
              [sessionId, failedId],
            )
          ).rows[0],
        ).toEqual({
          state: "failed",
          mutation_outcome: "applied",
          boundary: "effect_observation_required",
        });
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT observation_readiness_fixture");
      }
    });
  });

  it("atomically budgets different operation UUIDs and forbids replay after dispatch loss", async () => {
    const operationStore = new ProtectedOperationRepository(database);
    async function ready() {
      const [entry] = await contracts.register(sessionId, [proposal(sessionId)]);
      const reserved = await prepared.reserve(sessionId, {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        publicOperationId: `budget-${randomUUID()}`,
        operationContractRevisionId: entry!.revision.id,
        operationContractRevisionDigest: entry!.revision.digest,
        runtimeInteractionCapabilityId: entry!.interaction!.id,
        values: [
          {
            canonicalFieldKey: "itemName",
            targetReference: entry!.interaction!.inputControlReferences.itemName!,
            presentationClass: "plain_text",
            source: { kind: "literal_public", value: "budget control" },
          },
        ],
        expectedOutputs: [{ key: "itemId", classification: "public" }],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const exact = {
        protectedOperationId: reserved.protectedOperationId,
        preparedExecutionCapabilityId: reserved.preparedExecutionCapabilityId,
        publicOperationId: reserved.publicOperationId,
      };
      const material = await prepared.executionMaterial(sessionId, exact);
      const compiled = compilePreparedProtectedOperation({
        material,
        entryUrl: "https://example.test/items",
      });
      const protection = await prepared.finalizeExecutionCapability(
        reserved.preparedExecutionCapabilityId,
        compiled.transaction,
      );
      // Storage-boundary concurrency fixture: both independently compiled operations
      // are ready together, without depending on browser turn serialization.
      await database.query(
        `UPDATE protected_operations SET program_digest=$2,
        dispatch_semantics=$3,safe_output_manifest=$4::jsonb,version=version+1
        WHERE id=$1 AND program_digest IS NULL AND state='planned'`,
        [
          reserved.protectedOperationId,
          protection.programDigest,
          protection.dispatchSemantics,
          JSON.stringify(protection.safeOutputManifest),
        ],
      );
      const binding = {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        flowDraftId,
        mutationIdentity: reserved.mutationIdentity,
        programDigest: protection.programDigest,
        dispatchSemantics: protection.dispatchSemantics,
        safeOutputManifest: protection.safeOutputManifest,
        preparedExecutionCapabilityId: reserved.preparedExecutionCapabilityId,
      };
      const leaseOwner = randomUUID();
      let claim = await operationStore.claim({
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId: reserved.publicOperationId,
        leaseOwner,
        leaseDurationMs: 60_000,
        binding,
      });
      for (const next of ["preparing", "ready_to_dispatch"] as const)
        claim = await operationStore.transition({
          id: claim.id,
          leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
          expected: claim.state,
          next,
          phase: next,
        });
      return { claim, leaseOwner, binding, reserved, exact };
    }
    const before = (
      await database.query(
        "SELECT max_business_mutation_dispatches,business_mutation_dispatches_consumed FROM missions WHERE id=$1",
        [missionId],
      )
    ).rows[0]!;
    expect(before).toEqual({
      max_business_mutation_dispatches: 2,
      business_mutation_dispatches_consumed: 1,
    });
    const a = await ready(),
      b = await ready();
    expect(a.reserved.mutationIdentity).not.toBe(b.reserved.mutationIdentity);
    const contenders = await Promise.allSettled(
      [a, b].map(({ claim, leaseOwner }) =>
        operationStore.transition({
          id: claim.id,
          leaseOwner,
          fencingToken: claim.fencingToken,
          version: claim.version,
          expected: "ready_to_dispatch",
          next: "dispatching",
          phase: "dispatching",
        }),
      ),
    );
    expect(contenders.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const denied = contenders.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(String(denied.reason)).toContain("MISSION_BUSINESS_MUTATION_BUDGET_EXHAUSTED");
    const winnerIndex = contenders.findIndex((item) => item.status === "fulfilled");
    const winner = [a, b][winnerIndex]!;
    const dispatched = (contenders[winnerIndex] as PromiseFulfilledResult<typeof winner.claim>)
      .value;
    expect(
      (
        await database.query(
          "SELECT business_mutation_dispatches_consumed AS count FROM missions WHERE id=$1",
          [missionId],
        )
      ).rows[0]!.count,
    ).toBe(2);
    expect(
      (
        await database.query(
          "SELECT count(*)::int AS count FROM protected_operation_transitions WHERE protected_operation_id=ANY($1::uuid[]) AND to_state='dispatching'",
          [[a.claim.id, b.claim.id]],
        )
      ).rows[0]!.count,
    ).toBe(1);

    // Inject loss only after durable dispatch-start. No acknowledgement or response is invented.
    await database.query(
      "UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [winner.claim.id],
    );
    const recoveryOwner = randomUUID();
    const recovered = await new ProtectedOperationRepository(database).claim({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      operationId: winner.reserved.publicOperationId,
      leaseOwner: recoveryOwner,
      leaseDurationMs: 60_000,
      binding: winner.binding,
    });
    expect(recovered).toMatchObject({ state: "recovery_required", mutationOutcome: "unknown" });
    expect(recovered.fencingToken).toBeGreaterThan(dispatched.fencingToken);
    await expect(
      operationStore.transition({
        id: dispatched.id,
        leaseOwner: winner.leaseOwner,
        fencingToken: dispatched.fencingToken,
        version: dispatched.version,
        expected: "dispatching",
        next: "dispatched",
        phase: "late_ack",
      }),
    ).rejects.toBeDefined();
    await expect(
      operationStore.transition({
        id: recovered.id,
        leaseOwner: recoveryOwner,
        fencingToken: recovered.fencingToken,
        version: recovered.version,
        expected: "recovery_required",
        next: "ready_to_dispatch",
        phase: "unsafe_replay",
      }),
    ).rejects.toBeDefined();
    await expect(prepared.executionMaterial(sessionId, winner.exact)).rejects.toBeDefined();
    expect(
      (
        await database.query(
          "SELECT dispatch_state,mutation_outcome FROM protected_operations WHERE id=$1",
          [winner.claim.id],
        )
      ).rows[0],
    ).toEqual({ dispatch_state: "started", mutation_outcome: "unknown" });
  });
});

function proposal(sessionId: string): ProposedOperationContract {
  return {
    facts: {
      application: { key: "example", provider: "example" },
      adapter: { key: "registered", version: 1 },
      operation: {
        key: "createItem",
        label: "Create item",
        method: "POST" as const,
        pathTemplate: "/items",
        transports: ["fetch" as const],
        semantics: { dispatch: "mutation" as const, effects: ["business_effect" as const] },
      },
      inputs: [
        {
          key: "itemName",
          label: "Item name",
          aliases: [],
          required: true,
          classification: "public" as const,
          acceptedPresentations: ["plain_text" as const],
        },
      ],
      auth: { presentationClasses: [] },
      response: {
        statusClasses: [2],
        mutationPolicy: { confirmedNotAppliedStatuses: [400, 409, 422] },
        outputs: [
          {
            key: "itemId",
            label: "id",
            classification: "public" as const,
            extractor: { kind: "json_path" as const, path: "$.data.id" },
            identityRole: "resource_identity" as const,
            generatedValueEligible: true,
          },
        ],
        continuation: "read_only_retrieve" as const,
      },
      resourceEffect: {
        operation: "create" as const,
        provider: "example",
        resourceKind: "item",
        resourceScope: "application-1",
        identityContractVersion: 1,
        identityOutputKey: "itemId",
        correlationFieldKey: "itemName",
      },
    },
    provenance: {
      sourceKind: "runtime_observation" as const,
      observationId: "canonical-integration",
      origin: "https://example.test",
      observedAt: new Date().toISOString(),
      sourcePraxisSessionId: sessionId,
      sourceDocumentEpoch: 0,
    },
    interaction: {
      praxisSessionId: sessionId,
      documentEpoch: 0,
      origin: "https://example.test",
      activationControlReference: "context-control-11111111111111111111111111111111",
      inputControlReferences: {
        itemName: "context-control-22222222222222222222222222222222",
      },
    },
  };
}

function digest(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
