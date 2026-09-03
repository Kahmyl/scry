import { createHash, randomUUID } from "node:crypto";
import { SyntheticInputGeneratorRegistry } from "../src/adaptive-sessions/synthetic-input-generator.registry.js";
import { vitractSyntheticInputGenerators } from "../src/adaptive-sessions/vitract-synthetic-input.provider.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operationContractFactsSchema, operationContractProvenanceSchema } from "@scry/contracts";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "../src/runtime/repositories/protected-output-persistence.repository.js";
import { OperationBoundProtectedInputRepository } from "../src/adaptive-sessions/repositories/operation-bound-protected-input.repository.js";

const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("protected operation repository integration", () => {
  let database: Database;
  let operations: ProtectedOperationRepository;
  let outputs: ProtectedOutputPersistenceRepository;
  let syntheticInputs: OperationBoundProtectedInputRepository;
  let sessionId: string;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    operations = new ProtectedOperationRepository(database);
    outputs = new ProtectedOutputPersistenceRepository(database);
    syntheticInputs = new OperationBoundProtectedInputRepository(
      database,
      new SyntheticInputGeneratorRegistry(vitractSyntheticInputGenerators),
    );
    await database.query(
      `INSERT INTO workspaces(id,name,slug) VALUES($1,'Protected integration',$2)`,
      [workspaceId, `protected-${workspaceId}`],
    );
    await database.query(
      `INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Protected integration')`,
      [projectId, workspaceId],
    );
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,'Protected','https://example.test',$3::jsonb)`,
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
      `INSERT INTO missions(id,project_id,title,original_instruction,max_business_mutation_dispatches) VALUES($1,$2,'Protected','Acquire outputs',1000)`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'Acquire','{}'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','Protected integration',$3)`,
      [agentSessionId, missionId, `agent-${agentSessionId}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,content,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,'Protected','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
    const session = await new AdaptiveSessionRepository(database).create(workspaceId, {
      projectId,
      missionId,
      objectiveId,
      flowDraftId,
      environmentId,
      agentSessionId,
      objective: "Acquire outputs",
      allowedOrigins: ["https://example.test"],
      idempotencyKey: `session-${randomUUID()}`,
    });
    sessionId = session.id;
    await new AdaptiveSessionRepository(database).activateProvisionedSession(sessionId);
    await new AdaptiveSessionRepository(database).claimRuntimeLease({
      sessionId,
      ownerId: fixtureOwner,
      leaseDurationMs: 600_000,
    });
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  // Repository fixtures seed mechanical authority explicitly. No approval row
  // substitutes for a prepared capability; production admission remains intact.
  const fixtureOwner = randomUUID();
  const expiredFixtureIds = new Set<string>();
  const fixtureIds = new Map<
    string,
    { id: string; capabilityId: string; mutationIdentity: string }
  >();
  type FixtureOperation = Pick<
    Awaited<ReturnType<ProtectedOperationRepository["create"]>>,
    | "id"
    | "state"
    | "phase"
    | "version"
    | "fencingToken"
    | "leaseOwner"
    | "leaseExpiresAt"
    | "dispatchState"
    | "mutationOutcome"
    | "persistedReferences"
    | "dispatchSemantics"
  >;
  const fixturePromises = new Map<string, Promise<FixtureOperation>>();
  const fixturePolicyId = randomUUID();
  const fixturePolicy = {
    allowedOrigins: ["https://example.test"],
    trustedScriptOrigins: [],
    allowPrivateNetwork: false,
    allowDownloads: false,
    allowPopups: false,
    maxActions: 20,
    maxDurationMs: 30000,
    maxNavigations: 10,
  };
  function fixtureIdentity(operationId: string) {
    let x = fixtureIds.get(operationId);
    if (!x) {
      x = { id: randomUUID(), capabilityId: randomUUID(), mutationIdentity: randomUUID() };
      fixtureIds.set(operationId, x);
    }
    return x;
  }
  const fixtureManifest = [
    { reference: "clientId", classification: "public", storageName: "Client ID" },
    { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
  ];
  const fixtureOutputs = fixtureManifest.map((x) => ({
    key: x.reference,
    classification: x.classification,
  }));
  const canonicalHash = (x: unknown): string =>
    createHash("sha256").update(stableFixture(x)).digest("hex");
  function stableFixture(x: unknown): string {
    if (Array.isArray(x)) return `[${x.map(stableFixture).join(",")}]`;
    if (x && typeof x === "object")
      return `{${Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableFixture(v))
        .join(",")}}`;
    return JSON.stringify(x);
  }
  async function seedFixture(
    operationId: string,
    dispatchSemantics: "mutation" | "read_only",
    state: "reserved" | "planned",
    programDigest: string | null,
    finalized: boolean,
  ): Promise<FixtureOperation> {
    const existing = fixturePromises.get(operationId);
    if (existing) return existing;
    const promise = database.transaction(async (client) => {
      const ids = fixtureIdentity(operationId),
        revisionId = randomUUID(),
        interactionId = randomUUID(),
        policyId = fixturePolicyId;
      const operationKey = "op" + revisionId.replaceAll("-", "");
      const facts = operationContractFactsSchema.parse({
        application: { key: "fixture", provider: "fixture" },
        adapter: { key: "fixture", version: 1 },
        operation: {
          key: operationKey,
          label: "Acquire credentials",
          method: dispatchSemantics === "mutation" ? "POST" : "GET",
          pathTemplate: "/credentials",
          transports: ["fetch"],
          semantics: {
            dispatch: dispatchSemantics,
            effects:
              dispatchSemantics === "mutation"
                ? ["business_effect", "protected_acquisition"]
                : ["read", "protected_acquisition"],
          },
        },
        inputs: [],
        auth: { presentationClasses: [] },
        response: {
          statusClasses: [2],
          ...(dispatchSemantics === "mutation"
            ? { mutationPolicy: { confirmedNotAppliedStatuses: [400, 409, 422] } }
            : {}),
          outputs: fixtureManifest.map((x) => ({
            key: x.reference,
            label: x.storageName,
            classification: x.classification,
            generatedValueEligible: true,
          })),
          continuation: "none",
        },
      });
      const provenance = operationContractProvenanceSchema.parse({
        sourceKind: "runtime_observation",
        observationId: "fixture-" + revisionId,
        origin: "https://example.test",
        observedAt: new Date().toISOString(),
        sourcePraxisSessionId: sessionId,
        sourceDocumentEpoch: 0,
      });
      const revisionDigest = canonicalHash(facts),
        policyDigest = canonicalHash({
          version: 1,
          projectId,
          environmentId,
          applicationKey: "fixture",
          policy: fixturePolicy,
        });
      await client.query(
        `INSERT INTO operation_contract_revisions(id,project_id,application_key,provider_key,adapter_key,adapter_version,operation_key,revision,facts,provenance,semantic_digest) VALUES($1,$2,'fixture','fixture','fixture',1,$3,1,$4::jsonb,$5::jsonb,$6)`,
        [
          revisionId,
          projectId,
          operationKey,
          JSON.stringify(facts),
          JSON.stringify(provenance),
          revisionDigest,
        ],
      );
      await client.query(
        `INSERT INTO runtime_interaction_capabilities(id,operation_contract_revision_id,operation_contract_revision_digest,praxis_session_id,runtime_owner_id,fencing_epoch,document_epoch,origin,activation_control_reference,expires_at) VALUES($1,$2,$3,$4,$5,1,0,'https://example.test','context-control-11111111111111111111111111111111',now()+interval '10 minutes')`,
        [interactionId, revisionId, revisionDigest, sessionId, fixtureOwner],
      );
      await client.query(
        `INSERT INTO execution_policy_snapshots(id,project_id,environment_id,application_key,policy_version,allowed_origins,policy,digest) VALUES($1,$2,$3,'fixture',1,'["https://example.test"]'::jsonb,$5::jsonb,$4) ON CONFLICT(id) DO NOTHING`,
        [policyId, projectId, environmentId, policyDigest, JSON.stringify(fixturePolicy)],
      );
      await client.query(
        `INSERT INTO protected_operations(id,operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,authorization_id,program_digest,dispatch_semantics,state,phase,safe_output_manifest,authority_model,praxis_session_id,runtime_owner_id,runtime_fencing_epoch,document_epoch) VALUES($1,$2,$3,'authoring_session',$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,$13,$13,$14::jsonb,'canonical',$4,$15,1,0)`,
        [
          ids.id,
          operationId,
          ids.mutationIdentity,
          sessionId,
          projectId,
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
          flowDraftId,
          programDigest,
          dispatchSemantics,
          state,
          JSON.stringify(state === "reserved" ? [] : fixtureManifest),
          fixtureOwner,
        ],
      );
      await client.query(
        `INSERT INTO prepared_execution_capabilities(id,protected_operation_id,mutation_identity,operation_contract_revision_id,operation_contract_revision_digest,runtime_interaction_capability_id,execution_policy_snapshot_id,execution_policy_snapshot_digest,project_id,environment_id,mission_id,objective_id,agent_session_id,application_key,dispatch_semantics,effect_semantics,target_commitment,input_commitment,output_commitment,program_manifest,program_digest,state,expires_at,finalized_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'fixture',$14,$21::text[],$15,$15,$16,CASE WHEN $17 THEN $18::jsonb ELSE NULL END,CASE WHEN $17 THEN $19 ELSE NULL END,CASE WHEN $17 THEN 'finalized' ELSE 'reserved' END,CASE WHEN $20 THEN now()-interval '1 minute' ELSE now()+interval '10 minutes' END,CASE WHEN $17 THEN now() ELSE NULL END)`,
        [
          ids.capabilityId,
          ids.id,
          ids.mutationIdentity,
          revisionId,
          revisionDigest,
          interactionId,
          policyId,
          policyDigest,
          projectId,
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
          dispatchSemantics,
          "b".repeat(64),
          canonicalHash(fixtureOutputs),
          finalized,
          JSON.stringify({ programDigest: "a".repeat(64) }),
          "a".repeat(64),
          expiredFixtureIds.has(operationId),
          facts.operation.semantics.effects,
        ],
      );
      await client.query(
        "UPDATE protected_operations SET prepared_execution_capability_id=$2 WHERE id=$1",
        [ids.id, ids.capabilityId],
      );
      await client.query(
        `INSERT INTO protected_operation_transitions(protected_operation_id,sequence,from_state,to_state,phase,fencing_token,safe_diagnostics) VALUES($1,1,NULL,$2,$2,0,'{}'::jsonb)`,
        [ids.id, state],
      );
      const inserted = (
        await client.query<FixtureOperation>(
          `SELECT id,state,phase,version,fencing_token AS "fencingToken",lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt",dispatch_state AS "dispatchState",mutation_outcome AS "mutationOutcome",persisted_references AS "persistedReferences",dispatch_semantics AS "dispatchSemantics" FROM protected_operations WHERE id=$1`,
          [ids.id],
        )
      ).rows[0];
      if (!inserted) throw new Error("CANONICAL_FIXTURE_INSERT_MISSING");
      return inserted;
    });
    fixturePromises.set(operationId, promise);
    return promise;
  }
  async function canonicalCreate(input: Parameters<ProtectedOperationRepository["create"]>[0]) {
    return seedFixture(
      input.operationId,
      input.dispatchSemantics ?? "mutation",
      "planned",
      input.programDigest,
      true,
    );
  }
  async function canonicalReserve(input: Parameters<ProtectedOperationRepository["reserve"]>[0]) {
    return seedFixture(input.operationId, "mutation", "reserved", null, false);
  }
  async function canonicalClaim(input: Parameters<ProtectedOperationRepository["claim"]>[0]) {
    const ids = fixtureIdentity(input.operationId);
    await database.query(
      `UPDATE prepared_execution_capabilities capability SET state='finalized',program_manifest=jsonb_build_object('programDigest',operation.program_digest),program_digest=operation.program_digest,finalized_at=now() FROM protected_operations operation WHERE capability.id=$1 AND operation.id=capability.protected_operation_id AND capability.state='reserved' AND operation.program_digest IS NOT NULL`,
      [ids.capabilityId],
    );
    const binding = input.binding;
    return operations.claim({
      ...input,
      binding: {
        ...binding,
        preparedExecutionCapabilityId: ids.capabilityId,
        mutationIdentity: binding.mutationIdentity,
      },
    });
  }

  function create(operationId: string, dispatchSemantics: "mutation" | "read_only" = "mutation") {
    return canonicalCreate({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      flowDraftId,
      operationId,
      mutationIdentity: fixtureIdentity(operationId).mutationIdentity,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      programDigest: "a".repeat(64),
      dispatchSemantics,
      safeOutputManifest: [
        { reference: "clientId", classification: "public", storageName: "Client ID" },
        { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
      ],
    });
  }

  function claimOperation(
    operationId: string,
    leaseOwner: string,
    leaseDurationMs = 30_000,
    dispatchSemantics: "mutation" | "read_only" = "mutation",
  ) {
    return canonicalClaim({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      operationId,
      leaseOwner,
      leaseDurationMs,
      binding: {
        mutationIdentity: fixtureIdentity(operationId).mutationIdentity,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        programDigest: "a".repeat(64),
        flowDraftId,
        dispatchSemantics,
        safeOutputManifest: [
          { reference: "clientId", classification: "public", storageName: "Client ID" },
          { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
        ],
      },
    });
  }

  it("materializes exactly one encrypted operation-bound value across a concurrent race and restart", async () => {
    const operationId = `synthetic-${randomUUID()}`;
    const reserved = await canonicalReserve({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      flowDraftId,
      operationId,
      mutationIdentity: fixtureIdentity(operationId).mutationIdentity,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
    });
    const policy = {
      allowedOrigins: ["https://example.test"],
      allowPrivateNetwork: false,
      allowDownloads: false as const,
      allowPopups: false as const,
      maxActions: 20,
      maxDurationMs: 30_000,
      maxNavigations: 10,
      protectedSyntheticInputs: {
        enabled: true as const,
        generators: [
          {
            contract: "nested_client_order_json",
            version: 1 as const,
            purposes: ["test_order_qualification"],
            resourceScopes: [{ resourceKind: "order", operation: "create" }],
          },
        ],
      },
    };
    const declaration = {
      semantic: "nested_client_payload",
      generatorContract: "nested_client_order_json" as const,
      generatorVersion: 1 as const,
      purpose: "test_order_qualification" as const,
    };
    const input = {
      protectedOperationId: reserved.id,
      projectId,
      environmentId,
      policy,
      resourceKind: "order",
      operation: "create",
      declaration,
    };
    const [first, second] = await Promise.all([
      syntheticInputs.materialize(input),
      syntheticInputs.materialize(input),
    ]);
    expect(first.referenceId).toBe(second.referenceId);
    const plaintext = await new OperationBoundProtectedInputRepository(database).resolve({
      protectedOperationId: reserved.id,
      operationId,
      projectId,
      environmentId,
      referenceId: first.referenceId,
    });
    expect(JSON.parse(plaintext)).toMatchObject({
      orderedFor: "client",
      kitType: "gut-scan",
      deliveryMode: "dropship",
    });
    const rows = await database.query<{ count: string; plaintext: boolean }>(
      `SELECT count(*)::text AS count,bool_or(ciphertext IS NULL) AS plaintext
       FROM operation_bound_protected_inputs WHERE protected_operation_id=$1 AND semantic=$2`,
      [reserved.id, declaration.semantic],
    );
    expect(rows.rows[0]).toEqual({ count: "1", plaintext: false });
    await operations.bindProgram({
      id: reserved.id,
      programDigest: "a".repeat(64),
      safeOutputManifest: [],
    });
    const claimed = await canonicalClaim({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      operationId,
      leaseOwner: "synthetic-terminal-owner",
      leaseDurationMs: 30_000,
      binding: {
        mutationIdentity: fixtureIdentity(operationId).mutationIdentity,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        flowDraftId,
        programDigest: "a".repeat(64),
        safeOutputManifest: [],
      },
    });
    await operations.transition({
      id: claimed.id,
      leaseOwner: "synthetic-terminal-owner",
      fencingToken: claimed.fencingToken,
      version: claimed.version,
      expected: "planned",
      next: "failed_not_applied",
      phase: "qualification_withheld",
      reasonCode: "PROTECTED_DISPATCH_WITHHELD_BY_QUALIFICATION_POLICY",
    });
    await expect(
      syntheticInputs.resolve({
        protectedOperationId: reserved.id,
        operationId,
        projectId,
        environmentId,
        referenceId: first.referenceId,
      }),
    ).rejects.toThrow("SYNTHETIC_PROTECTED_INPUT_UNAVAILABLE");
    const destroyed = await database.query<{ destroyed: boolean }>(
      `SELECT lifecycle='destroyed' AND ciphertext IS NULL AND initialization_vector IS NULL
              AND authentication_tag IS NULL AS destroyed
         FROM operation_bound_protected_inputs WHERE id=$1`,
      [first.referenceId],
    );
    expect(destroyed.rows[0]?.destroyed).toBe(true);
  });

  async function beginAdaptiveProtectedOperation(
    operationId: string,
    reserve = false,
    reservationMutationIdentity = fixtureIdentity(operationId).mutationIdentity,
    protectedInputReferences: string[] = [],
  ) {
    const fixture = fixtureIdentity(operationId);
    if (reserve) await seedFixture(operationId, "mutation", "planned", null, true);
    const intent = {
      intentId: operationId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["prepared"],
        mutation: {
          kind: "one_time",
          target: { concept: "generate", role: "button", name: "Generate", exact: true },
        },
        outputs: [
          {
            reference: "clientId",
            classification: "public",
            target: { concept: "client id", role: "textbox", name: "Client ID", exact: true },
            storageName: "Client ID",
          },
          {
            reference: "clientSecret",
            classification: "protected",
            target: {
              concept: "client secret",
              role: "textbox",
              name: "Client secret",
              exact: true,
            },
            storageName: "Client secret",
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: {
        kind: "prepared_execution",
        preparedExecutionCapabilityId: fixture.capabilityId,
      },
      protectedInputReferences,
    };
    await new AdaptiveSessionRepository(database).beginMissionOperation({
      workspaceId,
      sessionId,
      operationId,
      idempotencyKey: `adaptive-${operationId}`,
      intent: intent as never,
      action: { type: "protectedTransaction", transaction: {} } as never,
      expectedEffect: { type: "none" },
      mode: "transact",
      ...(reserve
        ? {
            preparedProtectedOperationId: fixture.id,
            earlyProtectedOperationId: fixture.id,
            protectedReservation: {
              preparedExecutionCapabilityId: fixture.capabilityId,
              requestContract: {
                method: "POST",
                pathTemplate: "/credentials",
                transports: ["fetch"],
              },
              mutationIdentity: reservationMutationIdentity,
              programDigest: "a".repeat(64),
              safeOutputManifest: [
                {
                  reference: "clientId",
                  classification: "public" as const,
                  storageName: "Client ID",
                },
                {
                  reference: "clientSecret",
                  classification: "protected" as const,
                  storageName: "Client secret",
                },
              ],
            },
          }
        : {}),
    });
  }

  it("reserves the authoritative row atomically before continuation can project", async () => {
    const operationId = "reserved-before-pending";
    await beginAdaptiveProtectedOperation(operationId, true);
    const projection = await new AdaptiveSessionRepository(
      database,
    ).projectProtectedOperationForAuthoring({ sessionId, operationId });
    expect(projection).toMatchObject({ status: "pending", state: "planned", leaseActive: false });
    const proof = await database.query<{
      operationState: string;
      protectedState: string;
      transitions: number;
    }>(
      `SELECT adaptive.state AS "operationState",protected.state AS "protectedState",
              (SELECT count(*) FROM protected_operation_transitions transition
                WHERE transition.protected_operation_id=protected.id)::int AS transitions
         FROM adaptive_operations adaptive
         JOIN protected_operations protected
           ON protected.authoring_session_id=adaptive.session_id
          AND protected.operation_id=adaptive.operation_id
        WHERE adaptive.session_id=$1 AND adaptive.operation_id=$2`,
      [sessionId, operationId],
    );
    expect(proof.rows[0]).toEqual({
      operationState: "running",
      protectedState: "planned",
      transitions: 1,
    });
    const claimed = await canonicalClaim({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      operationId,
      leaseOwner: "reservation-owner",
      leaseDurationMs: 30_000,
      binding: {
        mutationIdentity: fixtureIdentity(operationId).mutationIdentity,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        programDigest: "a".repeat(64),
        flowDraftId,
        safeOutputManifest: [
          { reference: "clientId", classification: "public", storageName: "Client ID" },
          { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
        ],
      },
    });
    expect(claimed).toMatchObject({ state: "planned", leaseOwner: "reservation-owner" });
  });

  it("serializes concurrent reservation replay without duplicating durable identity", async () => {
    const operationId = "concurrent-reservation";
    await Promise.all([
      beginAdaptiveProtectedOperation(operationId, true),
      beginAdaptiveProtectedOperation(operationId, true),
    ]);
    const proof = await database.query<{
      adaptive: number;
      protected: number;
      transitions: number;
    }>(
      `SELECT
         (SELECT count(*) FROM adaptive_operations
           WHERE session_id=$1 AND operation_id=$2)::int AS adaptive,
         (SELECT count(*) FROM protected_operations
           WHERE authoring_session_id=$1 AND operation_id=$2)::int AS protected,
         (SELECT count(*) FROM protected_operation_transitions transition
           JOIN protected_operations protected ON protected.id=transition.protected_operation_id
          WHERE protected.authoring_session_id=$1 AND protected.operation_id=$2)::int AS transitions`,
      [sessionId, operationId],
    );
    expect(proof.rows[0]).toEqual({ adaptive: 1, protected: 1, transitions: 1 });
  });

  it("rolls back adaptive admission while retaining the untouched prepared reservation", async () => {
    const operationId = "invalid-reservation";
    await expect(
      beginAdaptiveProtectedOperation(operationId, true, `${operationId}-different`),
    ).rejects.toMatchObject({
      response: {
        code: "PREPARED_OPERATION_EXECUTION_CONTRACT_MISMATCH",
      },
    });
    const proof = await database.query<{ adaptive: number; protected: number }>(
      `SELECT
         (SELECT count(*) FROM adaptive_operations
           WHERE session_id=$1 AND operation_id=$2)::int AS adaptive,
         (SELECT count(*) FROM protected_operations
           WHERE authoring_session_id=$1 AND operation_id=$2)::int AS protected`,
      [sessionId, operationId],
    );
    expect(proof.rows[0]).toEqual({ adaptive: 0, protected: 1 });
  });

  it("fences concurrent owners and makes expired post-dispatch work recovery-only", async () => {
    await create("fenced-operation");
    let claim = await claimOperation("fenced-operation", "owner-a");
    await operations.record({
      id: claim.id,
      leaseOwner: "owner-a",
      fencingToken: claim.fencingToken,
      phase: "safe_context_parking",
      safeDiagnostics: {},
      durationMs: 1.25,
    });
    const recorded = await database.query<{ phase: string; phaseTimings: Record<string, number> }>(
      `SELECT phase,phase_timings AS "phaseTimings" FROM protected_operations WHERE id=$1`,
      [claim.id],
    );
    expect(recorded.rows[0]).toEqual({
      phase: "safe_context_parking",
      phaseTimings: { safe_context_parking: 1.25 },
    });
    const idempotentClaim = await claimOperation("fenced-operation", "owner-a");
    expect(idempotentClaim.fencingToken).toBe(claim.fencingToken);
    await expect(claimOperation("fenced-operation", "owner-b")).rejects.toThrow(
      "PROTECTED_OPERATION_LEASE_HELD",
    );
    await expect(
      canonicalClaim({
        ...({
          ownerKind: "authoring_session",
          ownerId: sessionId,
          operationId: "fenced-operation",
          leaseOwner: "owner-a",
          leaseDurationMs: 30_000,
        } as const),
        binding: {
          mutationIdentity: "different-mutation",
          projectId,
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
          programDigest: "a".repeat(64),
          flowDraftId,
          safeOutputManifest: [
            {
              reference: "clientSecret",
              classification: "protected",
              storageName: "Client secret",
            },
          ],
        },
      }),
    ).rejects.toThrow("PROTECTED_OPERATION_BINDING_MISMATCH");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      claim = await operations.transition({
        id: claim.id,
        leaseOwner: "owner-a",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    await database.query(
      `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [claim.id],
    );
    const recovered = await claimOperation("fenced-operation", "owner-b");
    expect(recovered).toMatchObject({ state: "recovery_required", mutationOutcome: "unknown" });
    await expect(
      operations.transition({
        id: recovered.id,
        leaseOwner: "owner-b",
        fencingToken: recovered.fencingToken,
        version: recovered.version,
        expected: "recovery_required",
        next: "ready_to_dispatch",
        phase: "illegal",
      }),
    ).rejects.toThrow("PROTECTED_OPERATION_TRANSITION_INVALID");
    await expect(
      new AdaptiveSessionRepository(database).validateIntentAdmission({
        sessionId,
        intent: {
          intentId: "fresh-mutation",
          objectiveId,
          flowDraftId,
          action: {
            kind: "activate",
            semanticEffect: "unknown",
            target: { concept: "another mutation", role: "button", name: "Mutate", exact: true },
          },
          expectedEffect: { kind: "none" },
          constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
          authorization: { kind: "ordinary" },
          protectedInputReferences: [],
        },
      }),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_OPERATION_UNRESOLVED" },
    });
  });

  it("makes expired read-only dispatch retry-safe without weakening mutation recovery", async () => {
    await create("read-only-expiry", "read_only");
    let claim = await claimOperation("read-only-expiry", "reader-a", 30_000, "read_only");
    for (const next of [
      "preparing",
      "ready_to_dispatch",
      "dispatching",
      "dispatched",
      "acquiring",
    ] as const) {
      claim = await operations.transition({
        id: claim.id,
        leaseOwner: "reader-a",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    await database.query(
      `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [claim.id],
    );
    const recovered = await claimOperation("read-only-expiry", "reader-b", 30_000, "read_only");
    expect(recovered).toMatchObject({
      state: "failed_not_applied",
      mutationOutcome: "not_applied",
    });

    await create("mutation-cannot-abort-after-dispatch");
    let mutation = await claimOperation("mutation-cannot-abort-after-dispatch", "writer-a");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      mutation = await operations.transition({
        id: mutation.id,
        leaseOwner: "writer-a",
        fencingToken: mutation.fencingToken,
        version: mutation.version,
        expected: mutation.state,
        next,
        phase: next,
      });
    }
    await expect(
      operations.transition({
        id: mutation.id,
        leaseOwner: "writer-a",
        fencingToken: mutation.fencingToken,
        version: mutation.version,
        expected: mutation.state,
        next: "failed_not_applied",
        phase: "illegal_mutation_abort",
      }),
    ).rejects.toThrow("PROTECTED_MUTATION_CANNOT_SETTLE_NOT_APPLIED_AFTER_DISPATCH");
  });

  it("classifies every expired active state through the authoritative claim without redispatch", async () => {
    const states = [
      "planned",
      "preparing",
      "ready_to_dispatch",
      "dispatching",
      "dispatched",
      "acquiring",
      "persisting",
      "persisted",
      "reconciling",
    ] as const;
    const path = [
      "planned",
      "preparing",
      "ready_to_dispatch",
      "dispatching",
      "dispatched",
      "acquiring",
      "persisting",
      "persisted",
      "reconciling",
    ] as const;
    for (const semantics of ["mutation", "read_only"] as const) {
      for (const target of states) {
        const operationId = `expiry-${semantics}-${target}`;
        await create(operationId, semantics);
        let claim = await claimOperation(operationId, "matrix-owner-a", 30_000, semantics);
        for (const next of path.slice(1, path.indexOf(target) + 1)) {
          claim = await operations.transition({
            id: claim.id,
            leaseOwner: "matrix-owner-a",
            fencingToken: claim.fencingToken,
            version: claim.version,
            expected: claim.state,
            next,
            phase: next,
          });
        }
        const oldFence = claim.fencingToken;
        await database.query(
          `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
          [claim.id],
        );
        const reclaimed = await claimOperation(operationId, "matrix-owner-b", 30_000, semantics);
        const postDispatch = path.indexOf(target) >= path.indexOf("dispatching");
        expect(reclaimed.fencingToken).toBe(oldFence + 1);
        expect(reclaimed.state).toBe(
          postDispatch
            ? semantics === "read_only"
              ? "failed_not_applied"
              : "recovery_required"
            : target,
        );
        if (postDispatch) {
          expect(reclaimed.mutationOutcome).toBe(
            semantics === "read_only" ? "not_applied" : "unknown",
          );
        }
        const dispatches = await database.query<{ count: number }>(
          `SELECT count(*)::int count FROM protected_operation_transitions
            WHERE protected_operation_id=$1 AND to_state='dispatching'`,
          [claim.id],
        );
        expect(dispatches.rows[0]!.count).toBe(postDispatch ? 1 : 0);
      }
    }
  });

  it("discards encrypted staged outputs when read-only settles not applied", async () => {
    const operationId = "read-only-staging-disposal";
    await create(operationId, "read_only");
    let claim = await claimOperation(operationId, "reader-stage", 30_000, "read_only");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      claim = await operations.transition({
        id: claim.id,
        leaseOwner: "reader-stage",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const context = {
      protectedOperationId: claim.id,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      ownerKind: "authoring_session" as const,
      ownerId: sessionId,
      operationId,
      leaseOwner: "reader-stage",
      fencingToken: claim.fencingToken,
      version: claim.version,
    };
    await outputs.stageResponseOutputs(context, [
      {
        reference: "clientId",
        classification: "public",
        storageName: "Client ID",
        value: "stale-id",
        scope: "project",
      },
      {
        reference: "clientSecret",
        classification: "protected",
        storageName: "Client secret",
        value: "stale-secret",
        scope: "project",
      },
    ]);
    await operations.transition({
      id: claim.id,
      leaseOwner: "reader-stage",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "dispatching",
      next: "failed_not_applied",
      phase: "failed_not_applied",
      safeDiagnostics: {
        mutation: {
          request: {
            status: "initiated",
            method: "GET",
            transport: "fetch",
            envelopeMatched: true,
          },
        },
        responseEvidence: {
          responseEventObserved: true,
          eligibleResponseSelected: true,
          httpStatusCode: 200,
          statusClass: "2xx",
          contentTypeClass: "json",
          bodyAcquisitionStarted: true,
          bodyAcquisitionSettled: true,
          bodyParseStatus: "success",
          topLevelShape: "object",
          declaredSemanticLeafPresent: false,
          declaredSemanticLeafMatchCount: "zero",
          selectedPathClass: "unavailable",
          extractionResultClass: "not_present",
          lateResultDiscarded: false,
        },
      },
    });
    const proof = await database.query<{
      count: number;
      request: unknown;
      responseEvidence: unknown;
    }>(
      `SELECT
         (SELECT count(*)::int FROM protected_response_output_staging
           WHERE protected_operation_id=operation.id) count,
         operation.safe_diagnostics->'mutation'->'request' request,
         operation.safe_diagnostics->'responseEvidence' AS "responseEvidence"
       FROM protected_operations operation WHERE operation.id=$1`,
      [claim.id],
    );
    expect(proof.rows[0]).toEqual({
      count: 0,
      request: {
        status: "initiated",
        method: "GET",
        transport: "fetch",
        envelopeMatched: true,
      },
      responseEvidence: {
        responseEventObserved: true,
        eligibleResponseSelected: true,
        httpStatusCode: 200,
        statusClass: "2xx",
        contentTypeClass: "json",
        bodyAcquisitionStarted: true,
        bodyAcquisitionSettled: true,
        bodyParseStatus: "success",
        topLevelShape: "object",
        declaredSemanticLeafPresent: false,
        declaredSemanticLeafMatchCount: "zero",
        selectedPathClass: "unavailable",
        extractionResultClass: "not_present",
        lateResultDiscarded: false,
      },
    });
  });

  it("relinquishes execution ownership while preserving durable recovery-required state", async () => {
    const operationId = "recovery-relinquishes-live-ownership";
    await create(operationId);
    let claim = await claimOperation(operationId, "relinquishing-owner");
    for (const next of [
      "preparing",
      "ready_to_dispatch",
      "dispatching",
      "dispatched",
      "acquiring",
    ] as const) {
      claim = await operations.transition({
        id: claim.id,
        leaseOwner: "relinquishing-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }

    const recovered = await operations.transition({
      id: claim.id,
      leaseOwner: "relinquishing-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "acquiring",
      next: "recovery_required",
      phase: "recovery_required",
      reasonCode: "PROTECTED_OUTPUT_ACQUISITION_TIMEOUT",
    });
    const ownership = await database.query<{
      state: string;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
    }>(
      `SELECT state,lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt"
         FROM protected_operations WHERE id=$1`,
      [claim.id],
    );

    expect(recovered.state).toBe("recovery_required");
    expect(ownership.rows[0]).toEqual({
      state: "recovery_required",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    await expect(
      operations.heartbeat({
        id: claim.id,
        leaseOwner: "relinquishing-owner",
        fencingToken: claim.fencingToken,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toThrow("PROTECTED_OPERATION_FENCED");
  });

  it("commits mixed outputs and the persisted state in one transaction", async () => {
    await create("atomic-operation");
    let claim = await claimOperation("atomic-operation", "owner-a");
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
        leaseOwner: "owner-a",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const acquired = [
      {
        reference: "clientId",
        classification: "public" as const,
        storageName: "Client ID",
        value: "public-value",
        scope: "project" as const,
      },
      {
        reference: "clientSecret",
        classification: "protected" as const,
        storageName: "Client secret",
        value: "integration-protected-canary",
        scope: "project" as const,
      },
    ];
    const persisted = await outputs.persistOutputsAtomically(
      {
        protectedOperationId: claim.id,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId: "atomic-operation",
        leaseOwner: "owner-a",
        fencingToken: claim.fencingToken,
        version: claim.version,
      },
      acquired,
    );
    expect(persisted.claim.state).toBe("persisted");
    expect(Object.keys(persisted.references).sort()).toEqual(["clientId", "clientSecret"]);
    expect(acquired.every((output) => output.value === "")).toBe(true);
    const rows = await database.query<{ credentials: string; values: string }>(
      `SELECT (SELECT count(*) FROM project_credentials WHERE origin_protected_operation_id=$1)::text credentials,(SELECT count(*) FROM generated_public_values WHERE source_protected_operation_id=$1)::text values`,
      [claim.id],
    );
    expect(rows.rows[0]).toEqual({ credentials: "1", values: "1" });
    expect(JSON.stringify(persisted)).not.toContain("integration-protected-canary");
  });

  it("rejects a partial output set before creating any durable reference", async () => {
    await create("partial-output-operation");
    let claim = await claimOperation("partial-output-operation", "partial-owner");
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
        leaseOwner: "partial-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    await expect(
      outputs.persistOutputsAtomically(
        {
          protectedOperationId: claim.id,
          projectId,
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
          ownerKind: "authoring_session",
          ownerId: sessionId,
          operationId: "partial-output-operation",
          leaseOwner: "partial-owner",
          fencingToken: claim.fencingToken,
          version: claim.version,
        },
        [
          {
            reference: "clientId",
            classification: "public",
            storageName: "Client ID",
            value: "partial-value",
            scope: "project",
          },
        ],
      ),
    ).rejects.toThrow("PROTECTED_OUTPUT_SET_INCOMPLETE");
    const proof = await database.query<{ state: string; credentials: number; values: number }>(
      `SELECT operation.state,
              (SELECT count(*)::int FROM project_credentials WHERE origin_protected_operation_id=operation.id) credentials,
              (SELECT count(*)::int FROM generated_public_values WHERE source_protected_operation_id=operation.id) values
         FROM protected_operations operation WHERE operation.id=$1`,
      [claim.id],
    );
    expect(proof.rows[0]).toEqual({ state: "persisting", credentials: 0, values: 0 });
  });

  it("recovers an encrypted staged response after lease loss without redispatch", async () => {
    const operationId = "staged-response-recovery";
    await create(operationId);
    let claim = await claimOperation(operationId, "staging-owner");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      claim = await operations.transition({
        id: claim.id,
        leaseOwner: "staging-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const context = {
      protectedOperationId: claim.id,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      ownerKind: "authoring_session" as const,
      ownerId: sessionId,
      operationId,
      leaseOwner: "staging-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
    };
    const staged = [
      {
        reference: "clientId",
        classification: "public" as const,
        storageName: "Client ID",
        value: "staged-public-id",
        scope: "project" as const,
      },
      {
        reference: "clientSecret",
        classification: "protected" as const,
        storageName: "Client secret",
        value: "staged-protected-canary",
        scope: "project" as const,
      },
    ];
    await outputs.stageResponseOutputs(context, staged);
    expect(staged.every((output) => output.value === "")).toBe(true);
    const ciphertext = await database.query<{ encoded: string }>(
      `SELECT encode(ciphertext,'escape') encoded FROM protected_response_output_staging WHERE protected_operation_id=$1`,
      [claim.id],
    );
    expect(ciphertext.rows[0]?.encoded).not.toContain("staged-protected-canary");
    await database.query(
      `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [claim.id],
    );
    claim = await claimOperation(operationId, "recovery-owner");
    expect(claim.state).toBe("recovery_required");
    const recovered = await outputs.recoverStagedResponseOutputs({
      ...context,
      leaseOwner: "recovery-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
    });
    expect(recovered?.map((output) => output.reference).sort()).toEqual([
      "clientId",
      "clientSecret",
    ]);
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "recovery-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "recovery_required",
      next: "acquiring",
      phase: "staged_response_recovery",
    });
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "recovery-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "acquiring",
      next: "persisting",
      phase: "persistence_running",
    });
    const persisted = await outputs.persistOutputsAtomically(
      {
        ...context,
        leaseOwner: "recovery-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
      },
      recovered!,
    );
    expect(persisted.claim.state).toBe("persisted");
    const proof = await database.query<{ staging: number; dispatches: number }>(
      `SELECT (SELECT count(*)::int FROM protected_response_output_staging WHERE protected_operation_id=$1) staging,
        (SELECT count(*)::int FROM protected_operation_transitions WHERE protected_operation_id=$1 AND to_state='dispatching') dispatches`,
      [claim.id],
    );
    expect(proof.rows[0]).toEqual({ staging: 0, dispatches: 1 });
  });

  it("observes a committed complete set after caller acknowledgement is lost without redispatch", async () => {
    const operationId = "commit-acknowledgement-lost";
    await create(operationId);
    let claim = await claimOperation(operationId, "commit-owner", 30_000);
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
        leaseOwner: "commit-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const staleContext = {
      protectedOperationId: claim.id,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      ownerKind: "authoring_session" as const,
      ownerId: sessionId,
      operationId,
      leaseOwner: "commit-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
    };
    // Deliberately discard the returned acknowledgement: durable state is the authority.
    await outputs
      .persistOutputsAtomically(staleContext, [
        {
          reference: "clientId",
          classification: "public",
          storageName: "Client ID",
          value: "lost-ack-id",
          scope: "project",
        },
        {
          reference: "clientSecret",
          classification: "protected",
          storageName: "Client secret",
          value: "lost-ack-secret",
          scope: "project",
        },
      ])
      .then(() => undefined);
    await database.query(
      `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [claim.id],
    );
    const recovered = await claimOperation(operationId, "recovery-after-lost-ack");
    expect(recovered).toMatchObject({ state: "recovery_required" });
    expect(Object.keys(recovered.persistedReferences ?? {}).sort()).toEqual([
      "clientId",
      "clientSecret",
    ]);
    await expect(
      outputs.persistOutputsAtomically(staleContext, [
        {
          reference: "clientId",
          classification: "public",
          storageName: "Client ID",
          value: "late-id",
          scope: "project",
        },
        {
          reference: "clientSecret",
          classification: "protected",
          storageName: "Client secret",
          value: "late-secret",
          scope: "project",
        },
      ]),
    ).rejects.toThrow("PROTECTED_OPERATION_PERSISTENCE_FENCED");
    const proof = await database.query<{ dispatches: number; credentials: number; values: number }>(
      `SELECT
        (SELECT count(*)::int FROM protected_operation_transitions WHERE protected_operation_id=$1 AND to_state='dispatching') dispatches,
        (SELECT count(*)::int FROM project_credentials WHERE origin_protected_operation_id=$1) credentials,
        (SELECT count(*)::int FROM generated_public_values WHERE source_protected_operation_id=$1) values`,
      [claim.id],
    );
    expect(proof.rows[0]).toEqual({ dispatches: 1, credentials: 1, values: 1 });
  });

  it("enforces the configured server statement and lock deadlines", async () => {
    const settings = await database.query<{ statementTimeout: string; lockTimeout: string }>(
      `SELECT current_setting('statement_timeout') AS "statementTimeout",
              current_setting('lock_timeout') AS "lockTimeout"`,
    );
    expect(settings.rows[0]).toEqual({ statementTimeout: "250ms", lockTimeout: "100ms" });
    await expect(database.query(`SELECT pg_sleep(0.5)`)).rejects.toMatchObject({ code: "57014" });

    const operationId = "lock-timeout-policy";
    await create(operationId);
    const blocker = await database.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT id FROM protected_operations WHERE operation_id=$1 FOR UPDATE`, [
        operationId,
      ]);
      await expect(claimOperation(operationId, "lock-waiter")).rejects.toMatchObject({
        code: "55P03",
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("atomically repairs contradictory authoring state from completed durable state", async () => {
    const operationId = "project-completed-operation";
    await beginAdaptiveProtectedOperation(operationId);
    await create(operationId);
    let claim = await claimOperation(operationId, "owner-a");
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
        leaseOwner: "owner-a",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const acquired = [
      {
        reference: "clientId",
        classification: "public" as const,
        storageName: "Client ID",
        value: "public-value",
        scope: "project" as const,
      },
      {
        reference: "clientSecret",
        classification: "protected" as const,
        storageName: "Client secret",
        value: "projection-protected-canary",
        scope: "project" as const,
      },
    ];
    const persisted = await outputs.persistOutputsAtomically(
      {
        protectedOperationId: claim.id,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId,
        leaseOwner: "owner-a",
        fencingToken: claim.fencingToken,
        version: claim.version,
      },
      acquired,
    );
    claim = await operations.transition({
      id: persisted.claim.id,
      leaseOwner: "owner-a",
      fencingToken: persisted.claim.fencingToken,
      version: persisted.claim.version,
      expected: "persisted",
      next: "reconciling",
      phase: "reconciling",
    });
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "owner-a",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: claim.state,
      next: "completed",
      phase: "completed",
    });
    await database.query(
      `UPDATE adaptive_operations SET state='failed',functional_result='failed',mutation_outcome='not_applied',
         safe_outcome=jsonb_build_object('operationId',$2,'functionalResult','failed','mutationOutcome','not_applied',
           'privacyResult','unverified','evidenceResult','[]'::jsonb,'qualityFindings','[]'::jsonb,'durationMs',0,
           'reasonCode','ADAPTIVE_SESSION_EXECUTION_FAILED') WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, operationId],
    );
    const versionBefore = await database.query<{ version: number }>(
      `SELECT version FROM adaptive_sessions WHERE id=$1`,
      [sessionId],
    );
    const repository = new AdaptiveSessionRepository(database);
    const [first, second] = await Promise.all([
      repository.projectProtectedOperationForAuthoring({ sessionId, operationId }),
      repository.projectProtectedOperationForAuthoring({ sessionId, operationId }),
    ]);
    for (const projection of [first, second]) {
      expect(projection).toMatchObject({
        status: "settled",
        state: "completed",
        outcome: {
          functionalResult: "succeeded",
          mutationOutcome: "applied",
          privacyResult: "sealed",
        },
      });
      expect(
        projection.status === "settled" ? projection.outcome.generatedReferences : [],
      ).toHaveLength(2);
      expect(JSON.stringify(projection)).not.toContain("projection-protected-canary");
    }
    expect(first).toEqual(second);
    const replay = await repository.projectProtectedOperationForAuthoring({
      sessionId,
      operationId,
    });
    expect(replay).toEqual(first);
    const proof = await database.query<{
      operationState: string;
      functionalResult: string;
      mutationOutcome: string;
      stepCount: number;
      completionEvents: number;
      projectionActivities: number;
      sessionVersion: number;
      opaqueReferenceCount: number;
    }>(
      `SELECT operation.state AS "operationState",operation.functional_result AS "functionalResult",
              operation.mutation_outcome AS "mutationOutcome",
              (SELECT count(*) FROM jsonb_array_elements(COALESCE(draft.plan->'steps','[]'::jsonb)) step
                WHERE step->>'id'=$2)::int AS "stepCount",
              (SELECT count(*) FROM adaptive_session_events event WHERE event.session_id=$1
                AND event.type='operation_completed' AND event.safe_facts->>'operationId'=$2)::int AS "completionEvents",
              (SELECT count(*) FROM mission_activities activity WHERE activity.mission_id=operation.mission_id
                AND activity.summary='Durable protected operation projected'
                AND activity.safe_metadata->>'operationId'=$2)::int AS "projectionActivities",
              (SELECT version FROM adaptive_sessions WHERE id=$1)::int AS "sessionVersion",
              jsonb_array_length(COALESCE(operation.safe_outcome->'generatedReferences','[]'::jsonb))::int AS "opaqueReferenceCount"
         FROM adaptive_operations operation JOIN flow_drafts draft ON draft.id=operation.flow_draft_id
        WHERE operation.session_id=$1 AND operation.operation_id=$2`,
      [sessionId, operationId],
    );
    expect(proof.rows[0]).toMatchObject({
      operationState: "completed",
      functionalResult: "succeeded",
      mutationOutcome: "applied",
      stepCount: 1,
      completionEvents: 1,
      projectionActivities: 1,
    });
    expect(proof.rows[0]!.sessionVersion - versionBefore.rows[0]!.version).toBeLessThanOrEqual(1);
    expect(proof.rows[0]!.opaqueReferenceCount).toBe(2);
    const generatedCredentialId = persisted.references.clientSecret?.credentialId;
    expect(generatedCredentialId).toMatch(/^[0-9a-f-]{36}$/);
    const admitted = await database.query<{ references: string[] }>(
      `SELECT protected_reference_allowlist AS references FROM adaptive_sessions WHERE id=$1`,
      [sessionId],
    );
    expect(admitted.rows[0]!.references).not.toContain(generatedCredentialId);

    await expect(
      new AdaptiveSessionRepository(database).resolveCredential(sessionId, generatedCredentialId!),
    ).rejects.toThrow();
    const asset = await database.query(
      `SELECT producer_protected_operation_id AS producer,canonical_output_key AS key,classification,project_id AS project FROM typed_value_assets WHERE project_credential_id=$1`,
      [generatedCredentialId],
    );
    expect(asset.rows).toEqual([
      { producer: claim.id, key: "clientSecret", classification: "protected", project: projectId },
    ]);
    const dispatches = await database.query(
      `SELECT count(*)::int AS count FROM protected_operation_transitions WHERE protected_operation_id=$1 AND to_state='dispatching'`,
      [claim.id],
    );
    expect(dispatches.rows[0]).toEqual({ count: 1 });
    // Positive reuse belongs to exact consumer-bound one-use admission, exercised
    // by prepared-protected-operation.repository.integration.test.ts; a backing
    // credential ID from projection is never an ordinary continuation permit.
  });

  it("keeps typed provenance authoritative without Environment membership permission", async () => {
    const operationId = "reject-foreign-projection";
    await beginAdaptiveProtectedOperation(operationId);
    await create(operationId);
    let claim = await claimOperation(operationId, "foreign-owner");
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
        leaseOwner: "foreign-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const persisted = await outputs.persistOutputsAtomically(
      {
        protectedOperationId: claim.id,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId,
        leaseOwner: "foreign-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
      },
      [
        {
          reference: "clientId",
          classification: "public",
          storageName: "Client ID",
          value: "foreign-public",
          scope: "project",
        },
        {
          reference: "clientSecret",
          classification: "protected",
          storageName: "Client secret",
          value: "foreign-protected-canary",
          scope: "project",
        },
      ],
    );
    claim = await operations.transition({
      id: persisted.claim.id,
      leaseOwner: "foreign-owner",
      fencingToken: persisted.claim.fencingToken,
      version: persisted.claim.version,
      expected: "persisted",
      next: "reconciling",
      phase: "reconciling",
    });
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "foreign-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "reconciling",
      next: "completed",
      phase: "completed",
    });
    const credentialId = persisted.references.clientSecret!.credentialId!;
    await database.query(`UPDATE environments SET secret_refs=secret_refs-$2 WHERE id=$1`, [
      environmentId,
      credentialId,
    ]);
    const before = await database.query<{ references: string[] }>(
      `SELECT protected_reference_allowlist AS references FROM adaptive_sessions WHERE id=$1`,
      [sessionId],
    );
    await expect(
      new AdaptiveSessionRepository(database).projectProtectedOperationForAuthoring({
        sessionId,
        operationId,
      }),
    ).resolves.toMatchObject({ status: "settled", state: "completed" });
    await expect(
      database.query(`UPDATE typed_value_assets SET project_id=$2 WHERE project_credential_id=$1`, [
        credentialId,
        randomUUID(),
      ]),
    ).rejects.toThrow();
    await expect(
      new AdaptiveSessionRepository(database).resolveCredential(sessionId, credentialId),
    ).rejects.toThrow();
    const after = await database.query<{ references: string[] }>(
      `SELECT protected_reference_allowlist AS references FROM adaptive_sessions WHERE id=$1`,
      [sessionId],
    );
    expect(after.rows[0]!.references).toEqual(before.rows[0]!.references);
  });

  it("projects failed, recovery, and missing durable states without inventing mutation success", async () => {
    const repository = new AdaptiveSessionRepository(database);
    for (const [operationId, durableState, expected] of [
      [
        "project-failed-operation",
        "failed_not_applied",
        { mutationOutcome: "not_applied", boundary: "environment_unavailable" },
      ],
      [
        "project-recovery-operation",
        "recovery_required",
        { mutationOutcome: "unknown", boundary: "mutation_reconciliation_required" },
      ],
    ] as const) {
      await beginAdaptiveProtectedOperation(operationId);
      await create(operationId);
      let claim = await claimOperation(operationId, "owner-a");
      if (durableState === "recovery_required") {
        for (const next of [
          "preparing",
          "ready_to_dispatch",
          "dispatching",
          "recovery_required",
        ] as const) {
          claim = await operations.transition({
            id: claim.id,
            leaseOwner: "owner-a",
            fencingToken: claim.fencingToken,
            version: claim.version,
            expected: claim.state,
            next,
            phase: next,
            ...(next === "recovery_required" ? { reasonCode: "SAFE_TEST_FAILURE" } : {}),
          });
        }
      } else {
        await operations.transition({
          id: claim.id,
          leaseOwner: "owner-a",
          fencingToken: claim.fencingToken,
          version: claim.version,
          expected: "planned",
          next: durableState,
          phase: durableState,
          reasonCode: "SAFE_TEST_FAILURE",
        });
      }
      const projection = await repository.projectProtectedOperationForAuthoring({
        sessionId,
        operationId,
      });
      expect(projection).toMatchObject({
        status: "settled",
        outcome: { mutationOutcome: expected.mutationOutcome },
        decisionBoundary: { type: expected.boundary },
      });
    }
    const missingId = "project-missing-operation";
    await beginAdaptiveProtectedOperation(missingId);
    await expect(
      repository.projectProtectedOperationForAuthoring({
        sessionId,
        operationId: missingId,
        missingFailureCode: "42601",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_PROTECTED_RESERVATION_MISSING",
        safeActions: ["get_flow_authoring"],
      },
    });
    const missingAdaptive = await database.query<{ state: string; mutationOutcome: string }>(
      `SELECT state,mutation_outcome AS "mutationOutcome" FROM adaptive_operations
        WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, missingId],
    );
    expect(missingAdaptive.rows[0]).toEqual({ state: "running", mutationOutcome: null });
  });

  it("keeps active durable work pending and terminal identity or ordinary outcomes immutable", async () => {
    const repository = new AdaptiveSessionRepository(database);
    const activeId = "project-active-operation";
    await beginAdaptiveProtectedOperation(activeId);
    await create(activeId);
    await claimOperation(activeId, "owner-a");
    const active = await repository.projectProtectedOperationForAuthoring({
      sessionId,
      operationId: activeId,
    });
    expect(active).toMatchObject({ status: "pending", state: "planned" });
    const activeAdaptive = await database.query<{ state: string }>(
      `SELECT state FROM adaptive_operations WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, activeId],
    );
    expect(activeAdaptive.rows[0]!.state).toBe("running");

    const preDispatchFailureId = "project-pre-dispatch-background-failure";
    await beginAdaptiveProtectedOperation(preDispatchFailureId);
    await create(preDispatchFailureId);
    const failed = await repository.projectProtectedOperationForAuthoring({
      sessionId,
      operationId: preDispatchFailureId,
      missingFailureCode: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID",
    });
    expect(failed).toMatchObject({
      status: "settled",
      outcome: {
        functionalResult: "failed",
        mutationOutcome: "not_applied",
        reasonCode: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID",
      },
    });
    const failedDurable = await database.query<{
      state: string;
      mutationOutcome: string;
      failureCode: string;
    }>(
      `SELECT state,mutation_outcome AS "mutationOutcome",failure_code AS "failureCode"
         FROM protected_operations WHERE operation_id=$1`,
      [preDispatchFailureId],
    );
    expect(failedDurable.rows[0]).toEqual({
      state: "failed_not_applied",
      mutationOutcome: "not_applied",
      failureCode: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID",
    });

    const ordinaryId = "ordinary-terminal-operation";
    const ordinaryIntent = {
      intentId: ordinaryId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "inspect",
        target: { concept: "status", role: "region", name: "Status", exact: true },
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    };
    await repository.beginMissionOperation({
      workspaceId,
      sessionId,
      operationId: ordinaryId,
      idempotencyKey: `adaptive-${ordinaryId}`,
      intent: ordinaryIntent as never,
      action: { type: "inspect", target: {} } as never,
      expectedEffect: { type: "none" },
      mode: "observe",
    });
    await database.query(
      `UPDATE adaptive_operations SET state='completed',functional_result='succeeded',mutation_outcome='not_applied',
         privacy_result='unverified',evidence_result='[]'::jsonb,quality_findings='[]'::jsonb,
         safe_outcome=jsonb_build_object('operationId',$2,'functionalResult','succeeded','mutationOutcome','not_applied',
           'privacyResult','unverified','evidenceResult','[]'::jsonb,'qualityFindings','[]'::jsonb,'durationMs',0),
         decision_boundary='{"type":"objective_completed","reasonCode":"DONE","safeActions":[]}'::jsonb,completed_at=now()
       WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, ordinaryId],
    );
    await expect(
      database.query(
        `UPDATE adaptive_operations SET privacy_result='sealed' WHERE session_id=$1 AND operation_id=$2`,
        [sessionId, ordinaryId],
      ),
    ).rejects.toThrow("Terminal adaptive operations are immutable");
    await expect(
      database.query(
        `UPDATE adaptive_operations SET authoring_intent=jsonb_set(authoring_intent,'{intentId}','\"changed\"'::jsonb)
        WHERE session_id=$1 AND operation_id='project-completed-operation'`,
        [sessionId],
      ),
    ).rejects.toThrow("Adaptive operation identity is immutable");
  });
  it("keeps a published draft immutable when completed protected truth is projected", async () => {
    const sessionProtection = await database.query<{ protection: string }>(
      `SELECT protection FROM adaptive_sessions WHERE id=$1`,
      [sessionId],
    );

    expect(sessionProtection.rows[0]?.protection).toBe("ordinary");

    const operationId = "published-protected-immutability";

    await beginAdaptiveProtectedOperation(operationId);
    await create(operationId);

    let claim = await claimOperation(operationId, "published-owner");

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
        leaseOwner: "published-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }

    const persisted = await outputs.persistOutputsAtomically(
      {
        protectedOperationId: claim.id,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId,
        leaseOwner: "published-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
      },
      [
        {
          reference: "clientId",
          classification: "public",
          storageName: "Client ID",
          value: "published-public-value",
          scope: "project",
        },
        {
          reference: "clientSecret",
          classification: "protected",
          storageName: "Client secret",
          value: "published-protected-canary",
          scope: "project",
        },
      ],
    );

    claim = await operations.transition({
      id: persisted.claim.id,
      leaseOwner: "published-owner",
      fencingToken: persisted.claim.fencingToken,
      version: persisted.claim.version,
      expected: "persisted",
      next: "reconciling",
      phase: "reconciling",
    });

    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "published-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "reconciling",
      next: "completed",
      phase: "completed",
    });

    await database.query(
      `UPDATE flow_drafts
          SET state='published'
        WHERE id=$1`,
      [flowDraftId],
    );

    const readDraft = async () => {
      const result = await database.query<{
        state: string;
        version: number;
        plan: unknown;
        updatedAt: string;
      }>(
        `SELECT state,version,plan,updated_at::text AS "updatedAt"
           FROM flow_drafts
          WHERE id=$1`,
        [flowDraftId],
      );

      expect(result.rowCount).toBe(1);
      return result.rows[0]!;
    };

    const before = await readDraft();

    expect(before.state).toBe("published");

    const eventsBefore = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM flow_draft_events
        WHERE draft_id=$1
          AND type='authoring_step_appended'
          AND safe_metadata->>'operationId'=$2`,
      [flowDraftId, operationId],
    );

    const projection = await new AdaptiveSessionRepository(
      database,
    ).projectProtectedOperationForAuthoring({
      sessionId,
      operationId,
    });

    expect(projection).toMatchObject({
      status: "settled",
      state: "completed",
      outcome: {
        functionalResult: "succeeded",
        mutationOutcome: "applied",
      },
    });

    const durable = await database.query<{
      state: string;
      functionalResult: string;
      mutationOutcome: string;
    }>(
      `SELECT state,
              functional_result AS "functionalResult",
              mutation_outcome AS "mutationOutcome"
         FROM adaptive_operations
        WHERE session_id=$1
          AND operation_id=$2`,
      [sessionId, operationId],
    );

    expect(durable.rows[0]).toEqual({
      state: "completed",
      functionalResult: "succeeded",
      mutationOutcome: "applied",
    });

    expect(await readDraft()).toEqual(before);

    const eventsAfter = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM flow_draft_events
        WHERE draft_id=$1
          AND type='authoring_step_appended'
          AND safe_metadata->>'operationId'=$2`,
      [flowDraftId, operationId],
    );

    expect(eventsAfter.rows[0]!.count).toBe(eventsBefore.rows[0]!.count);
    expect(eventsAfter.rows[0]!.count).toBe(0);
  });

  it("settles mutation truth monotonically and permits post-dispatch not-applied only after proof", async () => {
    const appliedId = `monotonic-applied-${randomUUID()}`;
    await create(appliedId);
    let applied = await claimOperation(appliedId, "monotonic-applied-owner");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      applied = await operations.transition({
        id: applied.id,
        leaseOwner: "monotonic-applied-owner",
        fencingToken: applied.fencingToken,
        version: applied.version,
        expected: applied.state,
        next,
        phase: next,
      });
    }
    applied = await operations.settleMutationOutcome({
      id: applied.id,
      leaseOwner: "monotonic-applied-owner",
      fencingToken: applied.fencingToken,
      version: applied.version,
      outcome: "applied",
    });
    await expect(
      operations.settleMutationOutcome({
        id: applied.id,
        leaseOwner: "monotonic-applied-owner",
        fencingToken: applied.fencingToken,
        version: applied.version,
        outcome: "not_applied",
      }),
    ).rejects.toThrow("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_FENCED");
    const recovery = await operations.transition({
      id: applied.id,
      leaseOwner: "monotonic-applied-owner",
      fencingToken: applied.fencingToken,
      version: applied.version,
      expected: "dispatching",
      next: "recovery_required",
      phase: "privacy_failed",
      reasonCode: "VEIL_CLIPBOARD_CLEANUP_FAILED",
    });
    expect(recovery.mutationOutcome).toBe("applied");

    const rejectedId = `monotonic-not-applied-${randomUUID()}`;
    await create(rejectedId);
    let rejected = await claimOperation(rejectedId, "monotonic-rejected-owner");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      rejected = await operations.transition({
        id: rejected.id,
        leaseOwner: "monotonic-rejected-owner",
        fencingToken: rejected.fencingToken,
        version: rejected.version,
        expected: rejected.state,
        next,
        phase: next,
      });
    }
    await expect(
      operations.transition({
        id: rejected.id,
        leaseOwner: "monotonic-rejected-owner",
        fencingToken: rejected.fencingToken,
        version: rejected.version,
        expected: "dispatching",
        next: "failed_not_applied",
        phase: "generic_failure",
      }),
    ).rejects.toThrow("PROTECTED_MUTATION_CANNOT_SETTLE_NOT_APPLIED_AFTER_DISPATCH");
    rejected = await operations.settleMutationOutcome({
      id: rejected.id,
      leaseOwner: "monotonic-rejected-owner",
      fencingToken: rejected.fencingToken,
      version: rejected.version,
      outcome: "not_applied",
    });
    rejected = await operations.transition({
      id: rejected.id,
      leaseOwner: "monotonic-rejected-owner",
      fencingToken: rejected.fencingToken,
      version: rejected.version,
      expected: "dispatching",
      next: "failed_not_applied",
      phase: "authoritative_rejection",
    });
    expect(rejected.mutationOutcome).toBe("not_applied");
  });

  it("projects applied recovery with committed references and an observation boundary", async () => {
    const operationId = `applied-recovery-${randomUUID()}`;
    await beginAdaptiveProtectedOperation(operationId);
    await create(operationId);
    let claim = await claimOperation(operationId, "applied-recovery-owner");
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
        leaseOwner: "applied-recovery-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    const persisted = await outputs.persistOutputsAtomically(
      {
        protectedOperationId: claim.id,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        ownerKind: "authoring_session",
        ownerId: sessionId,
        operationId,
        leaseOwner: "applied-recovery-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
      },
      [
        {
          reference: "clientId",
          classification: "public",
          storageName: "Client ID",
          value: `public-${randomUUID()}`,
          scope: "project",
        },
        {
          reference: "clientSecret",
          classification: "protected",
          storageName: "Client secret",
          value: `secret-${randomUUID()}`,
          scope: "project",
        },
      ],
    );
    claim = await operations.settleMutationOutcome({
      id: persisted.claim.id,
      leaseOwner: "applied-recovery-owner",
      fencingToken: persisted.claim.fencingToken,
      version: persisted.claim.version,
      outcome: "applied",
    });
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "applied-recovery-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "persisted",
      next: "recovery_required",
      phase: "continuation_failed",
      reasonCode: "PROTECTED_CONTINUATION_FAILED",
    });
    expect(claim.mutationOutcome).toBe("applied");
    const projection = await new AdaptiveSessionRepository(
      database,
    ).projectProtectedOperationForAuthoring({
      sessionId,
      operationId,
    });
    expect(projection).toMatchObject({
      status: "settled",
      state: "recovery_required",
      outcome: { functionalResult: "inconclusive", mutationOutcome: "applied" },
      decisionBoundary: {
        type: "effect_observation_required",
        reasonCode: "PROTECTED_CONTINUATION_FAILED",
      },
    });
    expect(projection.status === "settled" && projection.outcome.generatedReferences).toHaveLength(
      2,
    );
  });

  it("scopes expired prepared-authority settlement to the owning workspace", async () => {
    const operationId = `selector-scope-${randomUUID()}`;
    expiredFixtureIds.add(operationId);
    const repository = new AdaptiveSessionRepository(database);
    await beginAdaptiveProtectedOperation(operationId);
    await create(operationId);

    await repository.settleInvalidPredispatchProtectedAuthorizations({
      workspaceId: randomUUID(),
      sessionId,
    });
    const before = await database.query<{ state: string }>(
      `SELECT state FROM protected_operations WHERE operation_id=$1`,
      [operationId],
    );
    expect(before.rows[0]?.state).toBe("planned");

    await repository.settleInvalidPredispatchProtectedAuthorizations({ workspaceId, sessionId });
    const after = await database.query<{
      state: string;
      mutationOutcome: string;
      failureCode: string;
    }>(
      `SELECT state,mutation_outcome AS "mutationOutcome",failure_code AS "failureCode"
         FROM protected_operations WHERE operation_id=$1`,
      [operationId],
    );
    expect(after.rows[0]).toEqual({
      state: "failed_not_applied",
      mutationOutcome: "not_applied",
      failureCode: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID",
    });
  });

  it("projects append-only request and owned-response chronology without protected diagnostics", async () => {
    const operationId = `receipt-${randomUUID()}`;
    await create(operationId);
    let claim = await claimOperation(operationId, "receipt-owner");
    for (const next of ["preparing", "ready_to_dispatch"] as const) {
      claim = await operations.transition({
        id: claim.id,
        leaseOwner: "receipt-owner",
        fencingToken: claim.fencingToken,
        version: claim.version,
        expected: claim.state,
        next,
        phase: next,
      });
    }
    await operations.record({
      id: claim.id,
      leaseOwner: "receipt-owner",
      fencingToken: claim.fencingToken,
      phase: "dispatch_authorized",
      safeDiagnostics: {
        requestContract: {
          method: "POST",
          pathTemplate: "/clients/{clientId}",
          transports: ["fetch"],
        },
        reconciliationStrategy: "public_api_state",
      },
    });
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "receipt-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "ready_to_dispatch",
      next: "dispatching",
      phase: "mutation_dispatching",
    });
    await operations.record({
      id: claim.id,
      leaseOwner: "receipt-owner",
      fencingToken: claim.fencingToken,
      phase: "request_initiated",
      safeDiagnostics: {
        mutation: {
          request: { status: "initiated", method: "POST", transport: "fetch" },
        },
      },
    });
    await operations.record({
      id: claim.id,
      leaseOwner: "receipt-owner",
      fencingToken: claim.fencingToken,
      phase: "response_settled",
      safeDiagnostics: {
        responseEvidence: {
          responseEventObserved: true,
          eligibleResponseSelected: true,
          ownershipStatus: "unique",
          ignoredProtectedValue: "integration-protected-canary",
        },
      },
    });
    claim = await operations.transition({
      id: claim.id,
      leaseOwner: "receipt-owner",
      fencingToken: claim.fencingToken,
      version: claim.version,
      expected: "dispatching",
      next: "recovery_required",
      phase: "recovery_required",
      reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
    });

    const receipt = await operations.getMutationReceiptByAuthoringOperation(sessionId, operationId);
    expect(receipt).toMatchObject({
      receiptId: claim.id,
      operationId,
      dispatch: { state: "started" },
      request: {
        methodClass: "POST",
        endpointClass: "/clients/{clientId}",
        responseEventObserved: true,
        ownershipProof: "unique",
      },
      mutationOutcome: "unknown",
      redispatchAllowed: false,
      reconciliation: { strategy: "public_api_state", state: "unknown" },
    });
    expect(
      receipt?.transitions.filter(({ fromState, toState }) => fromState === toState),
    ).toHaveLength(3);
    expect(JSON.stringify(receipt)).not.toContain("integration-protected-canary");
  });
});
