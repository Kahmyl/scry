import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { ProtectedOutputPersistenceRepository } from "../src/runtime/repositories/protected-output-persistence.repository.js";

const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("protected operation repository integration", () => {
  let database: Database;
  let operations: ProtectedOperationRepository;
  let outputs: ProtectedOutputPersistenceRepository;
  let sessionId: string;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const authorizationId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    operations = new ProtectedOperationRepository(database);
    outputs = new ProtectedOutputPersistenceRepository(database);
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Protected integration',$2)`, [workspaceId,`protected-${workspaceId}`]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Protected integration')`, [projectId,workspaceId]);
    await database.query(`INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,'Protected','https://example.test',$3::jsonb)`, [environmentId,projectId,JSON.stringify({ allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 20, maxDurationMs: 30_000, maxNavigations: 10 })]);
    await database.query(`INSERT INTO missions(id,project_id,title,original_instruction) VALUES($1,$2,'Protected','Acquire outputs')`, [missionId,projectId]);
    await database.query(`INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'Acquire','{}'::jsonb,0)`, [objectiveId,missionId]);
    await database.query(`INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','Protected integration',$3)`, [agentSessionId,missionId,`agent-${agentSessionId}`]);
    await database.query(`INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,content,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,'Protected','{}'::jsonb,'{}'::jsonb,$6)`, [flowDraftId,projectId,missionId,objectiveId,environmentId,agentSessionId]);
    await database.query(`INSERT INTO mission_authorizations(id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id) VALUES($1,$2,$3,$4,'protected_mutation','Integration qualification','approved',$5)`, [authorizationId,missionId,objectiveId,environmentId,agentSessionId]);
    const session = await new AdaptiveSessionRepository(database).create(workspaceId, { projectId,missionId,objectiveId,flowDraftId,environmentId,agentSessionId,objective: "Acquire outputs",allowedOrigins: ["https://example.test"],idempotencyKey: `session-${randomUUID()}` });
    sessionId = session.id;
  });

  afterAll(async () => { await database?.onModuleDestroy(); });

  function create(operationId: string, dispatchSemantics: "mutation" | "read_only" = "mutation") {
    return operations.create({
      ownerKind: "authoring_session", ownerId: sessionId, flowDraftId, authorizationId,
      operationId, mutationIdentity: `${operationId}-mutation`, projectId, environmentId,
      missionId, objectiveId, agentSessionId, programDigest: "a".repeat(64), dispatchSemantics,
      safeOutputManifest: [
        { reference: "clientId", classification: "public", storageName: "Client ID" },
        { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
      ],
    });
  }

  function claimOperation(operationId: string, leaseOwner: string, leaseDurationMs = 30_000, dispatchSemantics: "mutation" | "read_only" = "mutation") {
    return operations.claim({
      ownerKind: "authoring_session", ownerId: sessionId, operationId, leaseOwner, leaseDurationMs,
      binding: {
        mutationIdentity: `${operationId}-mutation`, projectId, environmentId, missionId,
        objectiveId, agentSessionId, programDigest: "a".repeat(64), flowDraftId, dispatchSemantics,
        authorizationId, safeOutputManifest: [
          { reference: "clientId", classification: "public", storageName: "Client ID" },
          { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
        ],
      },
    });
  }

  async function beginAdaptiveProtectedOperation(
    operationId: string,
    reserve = false,
    reservationMutationIdentity = operationId,
  ) {
    const intent = {
      intentId: operationId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["prepared"],
        mutation: { kind: "one_time", target: { concept: "generate", role: "button", name: "Generate", exact: true } },
        outputs: [
          { reference: "clientId", classification: "public", target: { concept: "client id", role: "textbox", name: "Client ID", exact: true }, storageName: "Client ID" },
          { reference: "clientSecret", classification: "protected", target: { concept: "client secret", role: "textbox", name: "Client secret", exact: true }, storageName: "Client secret" },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation", authorizationId },
      protectedInputReferences: [],
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
      ...(reserve ? { protectedReservation: {
        mutationIdentity: reservationMutationIdentity,
        programDigest: "a".repeat(64),
        safeOutputManifest: [
          { reference: "clientId", classification: "public" as const, storageName: "Client ID" },
          { reference: "clientSecret", classification: "protected" as const, storageName: "Client secret" },
        ],
      } } : {}),
    });
  }

  it("reserves the authoritative row atomically before continuation can project", async () => {
    const operationId = "reserved-before-pending";
    await beginAdaptiveProtectedOperation(operationId, true);
    const projection = await new AdaptiveSessionRepository(database)
      .projectProtectedOperationForAuthoring({ sessionId, operationId });
    expect(projection).toMatchObject({ status: "pending", state: "planned", leaseActive: false });
    const proof = await database.query<{ operationState: string; protectedState: string; transitions: number }>(
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
    expect(proof.rows[0]).toEqual({ operationState: "running", protectedState: "planned", transitions: 1 });
    const claimed = await operations.claim({
      ownerKind: "authoring_session",
      ownerId: sessionId,
      operationId,
      leaseOwner: "reservation-owner",
      leaseDurationMs: 30_000,
      binding: {
        mutationIdentity: operationId,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        programDigest: "a".repeat(64),
        flowDraftId,
        authorizationId,
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
    const proof = await database.query<{ adaptive: number; protected: number; transitions: number }>(
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

  it("rolls back the adaptive operation when reservation identity is invalid", async () => {
    const operationId = "invalid-reservation";
    await expect(beginAdaptiveProtectedOperation(
      operationId,
      true,
      `${operationId}-different`,
    )).rejects.toMatchObject({ response: {
      code: "MISSION_AUTHORING_PROTECTED_RESERVATION_INVALID",
    } });
    const proof = await database.query<{ adaptive: number; protected: number }>(
      `SELECT
         (SELECT count(*) FROM adaptive_operations
           WHERE session_id=$1 AND operation_id=$2)::int AS adaptive,
         (SELECT count(*) FROM protected_operations
           WHERE authoring_session_id=$1 AND operation_id=$2)::int AS protected`,
      [sessionId, operationId],
    );
    expect(proof.rows[0]).toEqual({ adaptive: 0, protected: 0 });
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
    await expect(claimOperation("fenced-operation", "owner-b")).rejects.toThrow("PROTECTED_OPERATION_LEASE_HELD");
    await expect(operations.claim({ ...({ ownerKind: "authoring_session", ownerId: sessionId, operationId: "fenced-operation", leaseOwner: "owner-a", leaseDurationMs: 30_000 } as const), binding: {
      mutationIdentity: "different-mutation", projectId, environmentId, missionId, objectiveId,
      agentSessionId, programDigest: "a".repeat(64), flowDraftId, authorizationId,
      safeOutputManifest: [{ reference: "clientSecret", classification: "protected", storageName: "Client secret" }],
    } })).rejects.toThrow("PROTECTED_OPERATION_BINDING_MISMATCH");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      claim = await operations.transition({ id: claim.id,leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version,expected: claim.state,next,phase: next });
    }
    await database.query(`UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [claim.id]);
    const recovered = await claimOperation("fenced-operation", "owner-b");
    expect(recovered).toMatchObject({ state: "recovery_required", mutationOutcome: "unknown" });
    await expect(operations.transition({ id: recovered.id,leaseOwner: "owner-b",fencingToken: recovered.fencingToken,version: recovered.version,expected: "recovery_required",next: "ready_to_dispatch",phase: "illegal" })).rejects.toThrow("PROTECTED_OPERATION_TRANSITION_INVALID");
    await expect(new AdaptiveSessionRepository(database).validateIntentAdmission({ sessionId, intent: {
      intentId: "fresh-mutation", objectiveId, flowDraftId,
      action: { kind: "activate", target: { concept: "another mutation", role: "button", name: "Mutate", exact: true } },
      expectedEffect: { kind: "none" }, constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" }, protectedInputReferences: [],
    } })).rejects.toMatchObject({ response: { code: "MISSION_AUTHORING_PROTECTED_OPERATION_UNRESOLVED" } });
  });

  it("makes expired read-only dispatch retry-safe without weakening mutation recovery", async () => {
    await create("read-only-expiry", "read_only");
    let claim = await claimOperation("read-only-expiry", "reader-a", 30_000, "read_only");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching", "dispatched", "acquiring"] as const) {
      claim = await operations.transition({ id: claim.id,leaseOwner: "reader-a",fencingToken: claim.fencingToken,version: claim.version,expected: claim.state,next,phase: next });
    }
    await database.query(`UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [claim.id]);
    const recovered = await claimOperation("read-only-expiry", "reader-b", 30_000, "read_only");
    expect(recovered).toMatchObject({ state: "failed_not_applied", mutationOutcome: "not_applied" });

    await create("mutation-cannot-abort-after-dispatch");
    let mutation = await claimOperation("mutation-cannot-abort-after-dispatch", "writer-a");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      mutation = await operations.transition({ id: mutation.id,leaseOwner: "writer-a",fencingToken: mutation.fencingToken,version: mutation.version,expected: mutation.state,next,phase: next });
    }
    await expect(operations.transition({ id: mutation.id,leaseOwner: "writer-a",fencingToken: mutation.fencingToken,version: mutation.version,expected: mutation.state,next: "failed_not_applied",phase: "illegal_mutation_abort" }))
      .rejects.toThrow("PROTECTED_MUTATION_CANNOT_SETTLE_NOT_APPLIED_AFTER_DISPATCH");
  });

  it("commits mixed outputs and the persisted state in one transaction", async () => {
    await create("atomic-operation");
    let claim = await claimOperation("atomic-operation", "owner-a");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching", "dispatched", "acquiring", "persisting"] as const) {
      claim = await operations.transition({ id: claim.id,leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version,expected: claim.state,next,phase: next });
    }
    const acquired = [
      { reference: "clientId", classification: "public" as const, storageName: "Client ID", value: "public-value", scope: "project" as const },
      { reference: "clientSecret", classification: "protected" as const, storageName: "Client secret", value: "integration-protected-canary", scope: "project" as const },
    ];
    const persisted = await outputs.persistOutputsAtomically({ protectedOperationId: claim.id,projectId,environmentId,missionId,objectiveId,agentSessionId,ownerKind: "authoring_session",ownerId: sessionId,operationId: "atomic-operation",leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version }, acquired);
    expect(persisted.claim.state).toBe("persisted");
    expect(Object.keys(persisted.references).sort()).toEqual(["clientId", "clientSecret"]);
    expect(acquired.every((output) => output.value === "")).toBe(true);
    const rows = await database.query<{ credentials: string; values: string }>(`SELECT (SELECT count(*) FROM project_credentials WHERE origin_protected_operation_id=$1)::text credentials,(SELECT count(*) FROM generated_public_values WHERE source_protected_operation_id=$1)::text values`, [claim.id]);
    expect(rows.rows[0]).toEqual({ credentials: "1", values: "1" });
    expect(JSON.stringify(persisted)).not.toContain("integration-protected-canary");
  });

  it("recovers an encrypted staged response after lease loss without redispatch", async () => {
    const operationId = "staged-response-recovery";
    await create(operationId);
    let claim = await claimOperation(operationId, "staging-owner");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching"] as const) {
      claim = await operations.transition({ id: claim.id,leaseOwner: "staging-owner",fencingToken: claim.fencingToken,version: claim.version,expected: claim.state,next,phase: next });
    }
    const context = { protectedOperationId: claim.id,projectId,environmentId,missionId,objectiveId,
      agentSessionId,ownerKind: "authoring_session" as const,ownerId: sessionId,operationId,
      leaseOwner: "staging-owner",fencingToken: claim.fencingToken,version: claim.version };
    const staged = [
      { reference: "clientId",classification: "public" as const,storageName: "Client ID",value: "staged-public-id",scope: "project" as const },
      { reference: "clientSecret",classification: "protected" as const,storageName: "Client secret",value: "staged-protected-canary",scope: "project" as const },
    ];
    await outputs.stageResponseOutputs(context, staged);
    expect(staged.every((output) => output.value === "")).toBe(true);
    const ciphertext = await database.query<{ encoded: string }>(
      `SELECT encode(ciphertext,'escape') encoded FROM protected_response_output_staging WHERE protected_operation_id=$1`,
      [claim.id],
    );
    expect(ciphertext.rows[0]?.encoded).not.toContain("staged-protected-canary");
    await database.query(`UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [claim.id]);
    claim = await claimOperation(operationId, "recovery-owner");
    expect(claim.state).toBe("recovery_required");
    const recovered = await outputs.recoverStagedResponseOutputs({ ...context,leaseOwner: "recovery-owner",fencingToken: claim.fencingToken,version: claim.version });
    expect(recovered?.map((output) => output.reference).sort()).toEqual(["clientId", "clientSecret"]);
    claim = await operations.transition({ id: claim.id,leaseOwner: "recovery-owner",fencingToken: claim.fencingToken,version: claim.version,expected: "recovery_required",next: "acquiring",phase: "staged_response_recovery" });
    claim = await operations.transition({ id: claim.id,leaseOwner: "recovery-owner",fencingToken: claim.fencingToken,version: claim.version,expected: "acquiring",next: "persisting",phase: "persistence_running" });
    const persisted = await outputs.persistOutputsAtomically({ ...context,leaseOwner: "recovery-owner",fencingToken: claim.fencingToken,version: claim.version }, recovered!);
    expect(persisted.claim.state).toBe("persisted");
    const proof = await database.query<{ staging: number; dispatches: number }>(
      `SELECT (SELECT count(*)::int FROM protected_response_output_staging WHERE protected_operation_id=$1) staging,
        (SELECT count(*)::int FROM protected_operation_transitions WHERE protected_operation_id=$1 AND to_state='dispatching') dispatches`,
      [claim.id],
    );
    expect(proof.rows[0]).toEqual({ staging: 0, dispatches: 1 });
  });

  it("atomically repairs contradictory authoring state from completed durable state", async () => {
    const operationId = "project-completed-operation";
    await beginAdaptiveProtectedOperation(operationId);
    await create(operationId);
    let claim = await claimOperation(operationId, "owner-a");
    for (const next of ["preparing", "ready_to_dispatch", "dispatching", "dispatched", "acquiring", "persisting"] as const) {
      claim = await operations.transition({ id: claim.id,leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version,expected: claim.state,next,phase: next });
    }
    const acquired = [
      { reference: "clientId", classification: "public" as const, storageName: "Client ID", value: "public-value", scope: "project" as const },
      { reference: "clientSecret", classification: "protected" as const, storageName: "Client secret", value: "projection-protected-canary", scope: "project" as const },
    ];
    const persisted = await outputs.persistOutputsAtomically({ protectedOperationId: claim.id,projectId,environmentId,missionId,objectiveId,agentSessionId,ownerKind: "authoring_session",ownerId: sessionId,operationId,leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version }, acquired);
    claim = await operations.transition({ id: persisted.claim.id,leaseOwner: "owner-a",
      fencingToken: persisted.claim.fencingToken,version: persisted.claim.version,
      expected: "persisted",next: "reconciling",phase: "reconciling" });
    claim = await operations.transition({ id: claim.id,leaseOwner: "owner-a",fencingToken: claim.fencingToken,
      version: claim.version,expected: claim.state,next: "completed",phase: "completed" });
    await database.query(
      `UPDATE adaptive_operations SET state='failed',functional_result='failed',mutation_outcome='not_applied',
         safe_outcome=jsonb_build_object('operationId',$2,'functionalResult','failed','mutationOutcome','not_applied',
           'privacyResult','unverified','evidenceResult','[]'::jsonb,'qualityFindings','[]'::jsonb,'durationMs',0,
           'reasonCode','ADAPTIVE_SESSION_EXECUTION_FAILED') WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, operationId],
    );
    const versionBefore = await database.query<{ version: number }>(
      `SELECT version FROM adaptive_sessions WHERE id=$1`, [sessionId],
    );
    const repository = new AdaptiveSessionRepository(database);
    const [first, second] = await Promise.all([
      repository.projectProtectedOperationForAuthoring({ sessionId, operationId }),
      repository.projectProtectedOperationForAuthoring({ sessionId, operationId }),
    ]);
    for (const projection of [first, second]) {
      expect(projection).toMatchObject({ status: "settled", state: "completed", outcome: {
        functionalResult: "succeeded", mutationOutcome: "applied", privacyResult: "sealed",
      } });
      expect(projection.status === "settled" ? projection.outcome.generatedReferences : []).toHaveLength(2);
      expect(JSON.stringify(projection)).not.toContain("projection-protected-canary");
    }
    expect(first).toEqual(second);
    const replay = await repository.projectProtectedOperationForAuthoring({ sessionId, operationId });
    expect(replay).toEqual(first);
    const proof = await database.query<{ operationState: string; functionalResult: string; mutationOutcome: string; stepCount: number; completionEvents: number; projectionActivities: number; sessionVersion: number; opaqueReferenceCount: number }>(
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
    expect(proof.rows[0]).toMatchObject({ operationState: "completed", functionalResult: "succeeded", mutationOutcome: "applied",
      stepCount: 1, completionEvents: 1, projectionActivities: 1 });
    expect(proof.rows[0]!.sessionVersion - versionBefore.rows[0]!.version).toBeLessThanOrEqual(1);
    expect(proof.rows[0]!.opaqueReferenceCount).toBe(2);
  });

  it("projects failed, recovery, and missing durable states without inventing mutation success", async () => {
    const repository = new AdaptiveSessionRepository(database);
    for (const [operationId, durableState, expected] of [
      ["project-failed-operation", "failed_not_applied", { mutationOutcome: "not_applied", boundary: "environment_unavailable" }],
      ["project-recovery-operation", "recovery_required", { mutationOutcome: "unknown", boundary: "mutation_reconciliation_required" }],
    ] as const) {
      await beginAdaptiveProtectedOperation(operationId);
      await create(operationId);
      let claim = await claimOperation(operationId, "owner-a");
      if (durableState === "recovery_required") {
        for (const next of ["preparing", "ready_to_dispatch", "dispatching", "recovery_required"] as const) {
          claim = await operations.transition({ id: claim.id,leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version,
            expected: claim.state,next,phase: next,...(next === "recovery_required" ? { reasonCode: "SAFE_TEST_FAILURE" } : {}) });
        }
      } else {
        await operations.transition({ id: claim.id,leaseOwner: "owner-a",fencingToken: claim.fencingToken,version: claim.version,
          expected: "planned",next: durableState,phase: durableState,reasonCode: "SAFE_TEST_FAILURE" });
      }
      const projection = await repository.projectProtectedOperationForAuthoring({ sessionId, operationId });
      expect(projection).toMatchObject({ status: "settled", outcome: { mutationOutcome: expected.mutationOutcome },
        decisionBoundary: { type: expected.boundary } });
    }
    const missingId = "project-missing-operation";
    await beginAdaptiveProtectedOperation(missingId);
    await expect(repository.projectProtectedOperationForAuthoring({
      sessionId,
      operationId: missingId,
      missingFailureCode: "42601",
    })).rejects.toMatchObject({ response: {
      code: "MISSION_AUTHORING_PROTECTED_RESERVATION_MISSING",
      safeActions: ["get_flow_authoring"],
    } });
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
    const active = await repository.projectProtectedOperationForAuthoring({ sessionId, operationId: activeId });
    expect(active).toMatchObject({ status: "pending", state: "planned" });
    const activeAdaptive = await database.query<{ state: string }>(
      `SELECT state FROM adaptive_operations WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, activeId],
    );
    expect(activeAdaptive.rows[0]!.state).toBe("running");

    const ordinaryId = "ordinary-terminal-operation";
    const ordinaryIntent = {
      intentId: ordinaryId, objectiveId, flowDraftId,
      action: { kind: "inspect", target: { concept: "status", role: "region", name: "Status", exact: true } },
      expectedEffect: { kind: "none" }, constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" }, protectedInputReferences: [],
    };
    await repository.beginMissionOperation({ workspaceId,sessionId,operationId: ordinaryId,idempotencyKey: `adaptive-${ordinaryId}`,
      intent: ordinaryIntent as never,action: { type: "inspect", target: {} } as never,expectedEffect: { type: "none" },mode: "observe" });
    await database.query(
      `UPDATE adaptive_operations SET state='completed',functional_result='succeeded',mutation_outcome='not_applied',
         privacy_result='unverified',evidence_result='[]'::jsonb,quality_findings='[]'::jsonb,
         safe_outcome=jsonb_build_object('operationId',$2,'functionalResult','succeeded','mutationOutcome','not_applied',
           'privacyResult','unverified','evidenceResult','[]'::jsonb,'qualityFindings','[]'::jsonb,'durationMs',0),
         decision_boundary='{"type":"objective_completed","reasonCode":"DONE","safeActions":[]}'::jsonb,completed_at=now()
       WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, ordinaryId],
    );
    await expect(database.query(
      `UPDATE adaptive_operations SET privacy_result='sealed' WHERE session_id=$1 AND operation_id=$2`,
      [sessionId, ordinaryId],
    )).rejects.toThrow("Terminal adaptive operations are immutable");
    await expect(database.query(
      `UPDATE adaptive_operations SET authoring_intent=jsonb_set(authoring_intent,'{intentId}','\"changed\"'::jsonb)
        WHERE session_id=$1 AND operation_id='project-completed-operation'`,
      [sessionId],
    )).rejects.toThrow("Adaptive operation identity is immutable");
  });
});
