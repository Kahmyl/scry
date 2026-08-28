import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdaptiveSessionOperationInput } from "@scry/contracts";

import {
  AdaptiveSessionRepository,
  requireEnvironmentCapabilities,
} from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { compileMissionAuthoringProtectedTransaction } from "../src/adaptive-sessions/mission-authoring-protected-transaction.js";
import { Database } from "../src/infrastructure/index.js";

const configuredDatabaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = configuredDatabaseUrl ? describe : describe.skip;

describe("adaptive session environment capability admission", () => {
  const policy = {
    allowedOrigins: ["https://app.example.test", "https://api.example.test"],
    trustedScriptOrigins: ["https://scripts.example.test"],
  };

  it("admits all required document origins under one environment identity", () => {
    expect(
      requireEnvironmentCapabilities(
        { policy, secretRefs: [] },
        {
          allowedOrigins: ["https://app.example.test", "https://api.example.test/docs"],
          initialProtectedReferenceIds: [],
        },
      ),
    ).toEqual(["https://app.example.test", "https://api.example.test"]);
  });

  it("rejects a missing document origin before runtime creation", () => {
    const error = capture(() =>
      requireEnvironmentCapabilities(
        { policy: { ...policy, allowedOrigins: ["https://app.example.test"] }, secretRefs: [] },
        {
          allowedOrigins: ["https://app.example.test", "https://api.example.test"],
          initialProtectedReferenceIds: [],
        },
      ),
    );
    expect(error).toMatchObject({
      response: expect.objectContaining({
        code: "ENVIRONMENT_CAPABILITY_INCOMPLETE",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      }),
    });
  });

  it("does not treat a trusted script origin as a navigable document origin", () => {
    const error = capture(() =>
      requireEnvironmentCapabilities(
        { policy, secretRefs: [] },
        {
          allowedOrigins: ["https://scripts.example.test"],
          initialProtectedReferenceIds: [],
        },
      ),
    );
    expect(error).toMatchObject({
      response: expect.objectContaining({
        code: "ENVIRONMENT_CAPABILITY_INCOMPLETE",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      }),
    });
  });

  it("rejects a protected reference outside the selected environment", () => {
    const error = capture(() =>
      requireEnvironmentCapabilities(
        { policy, secretRefs: ["11111111-1111-4111-8111-111111111111"] },
        {
          allowedOrigins: ["https://app.example.test"],
          initialProtectedReferenceIds: ["22222222-2222-4222-8222-222222222222"],
        },
      ),
    );
    expect(error).toMatchObject({
      response: expect.objectContaining({
        code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      }),
    });
  });
});

function capture(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("EXPECTED_ACTION_TO_THROW");
}

integration("adaptive session repository integration", () => {
  let database: Database;
  let repository: AdaptiveSessionRepository;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const sessionIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = configuredDatabaseUrl;
    database = new Database();
    repository = new AdaptiveSessionRepository(database);
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)`, [
      workspaceId,
      `Adaptive ${workspaceId}`,
      `adaptive-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)`, [
      projectId,
      workspaceId,
      `Adaptive ${projectId}`,
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Adaptive','https://example.test',$3::jsonb)`,
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
       VALUES($1,$2,'Adaptive Mission','Exercise Mission-owned authoring')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(
         id,mission_id,title,completion_criteria,objective_order
       ) VALUES($1,$2,'Inspect account details','{}'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,provider,instruction_snapshot,idempotency_key
       ) VALUES($1,$2,'scry_agent','Integration test','adaptive-owner-session')`,
      [agentSessionId, missionId],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'Inspect account details','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
  });

  async function createActive(input: Parameters<AdaptiveSessionRepository["create"]>[1]) {
    const created = await repository.create(workspaceId, input);
    const session = await repository.get(workspaceId, created.id);
    if (session.state === "provisioning") await repository.activateProvisionedSession(created.id);
    return created;
  }

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it("creates no additional Mission, Objective, Flow draft, or probe records", async () => {
    const before = await controlPlaneCounts();
    const created = await repository.create(workspaceId, startInput("missionless-start"));
    sessionIds.push(created.id);
    const after = await controlPlaneCounts();
    expect(after).toEqual({ ...before, sessions: before.sessions + 1 });
    const session = await repository.get(workspaceId, created.id);
    expect(session).toMatchObject({ state: "provisioning", version: 2 });
    expect((session.events as Array<{ type: string }>).map((event) => event.type)).toEqual([
      "session_created",
      "provisioning_started",
    ]);
  });

  it("never replays a Project-scoped idempotency collision across Mission ownership", async () => {
    const idempotencyKey = `cross-mission-${randomUUID()}`;
    const original = await repository.create(workspaceId, startInput(idempotencyKey));
    sessionIds.push(original.id);

    const otherMissionId = randomUUID();
    const otherObjectiveId = randomUUID();
    const otherAgentSessionId = randomUUID();
    const otherFlowDraftId = randomUUID();
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
       VALUES($1,$2,'Other Mission','Prove exact idempotency ownership')`,
      [otherMissionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
       VALUES($1,$2,'Other objective','{}'::jsonb,0)`,
      [otherObjectiveId, otherMissionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','Other integration session',$3)`,
      [otherAgentSessionId, otherMissionId, `other-owner-${randomUUID()}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'Other exact owner','{}'::jsonb,'{}'::jsonb,$6)`,
      [
        otherFlowDraftId,
        projectId,
        otherMissionId,
        otherObjectiveId,
        environmentId,
        otherAgentSessionId,
      ],
    );

    try {
      await expect(
        repository.create(workspaceId, {
          ...startInput(idempotencyKey),
          missionId: otherMissionId,
          objectiveId: otherObjectiveId,
          agentSessionId: otherAgentSessionId,
          flowDraftId: otherFlowDraftId,
        }),
      ).rejects.toMatchObject({
        response: {
          code: "PRAXIS_SESSION_IDEMPOTENCY_CONFLICT",
          mutationOutcome: "not_applied",
          retry: "safe_after_prerequisite",
          requiresFreshIdempotencyKey: true,
          safeActions: ["get_operating_context", "start_praxis_session"],
        },
      });
      await expect(
        database.query(`SELECT 1 FROM adaptive_sessions WHERE mission_id=$1`, [otherMissionId]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(repository.create(workspaceId, startInput(idempotencyKey))).resolves.toEqual({
        id: original.id,
        replayed: true,
      });
    } finally {
      await database.query(`UPDATE agent_sessions SET status='failed',ended_at=now() WHERE id=$1`, [
        otherAgentSessionId,
      ]);
      await database.query(
        `UPDATE mission_objectives SET status='failed',conclusion='Integration fixture settled' WHERE id=$1`,
        [otherObjectiveId],
      );
      await database.query(
        `UPDATE missions SET status='completed',completed_at=now() WHERE id=$1`,
        [otherMissionId],
      );
    }
  });

  it("prepares one coherent lifecycle atomically and replays the durable ID tuple", async () => {
    const input = preparationInput(`prepare-${randomUUID()}`);
    const prepared = await repository.prepare(workspaceId, input);
    sessionIds.push(prepared.authoringSessionId);
    expect(prepared).toMatchObject({ replayed: false, reused: false, authoringReady: true });
    const durable = await database.query(
      `SELECT m.status,m.revision,o.status AS "objectiveStatus",a.status AS "agentStatus",
              s.state,s.version,(SELECT count(*)::int FROM adaptive_session_events WHERE session_id=s.id) AS events
       FROM missions m JOIN mission_objectives o ON o.mission_id=m.id
       JOIN agent_sessions a ON a.mission_id=m.id JOIN adaptive_sessions s ON s.mission_id=m.id
       WHERE m.id=$1`,
      [prepared.missionId],
    );
    expect(durable.rows[0]).toMatchObject({
      status: "planning",
      revision: 1,
      objectiveStatus: "pending",
      agentStatus: "active",
      state: "provisioning",
      version: 2,
      events: 2,
    });
    expect(await repository.prepare(workspaceId, input)).toEqual({ ...prepared, replayed: true });
    await repository.activateProvisionedSession(prepared.authoringSessionId);
    await database.query(`UPDATE adaptive_sessions SET decision_boundary=$2::jsonb WHERE id=$1`, [
      prepared.authoringSessionId,
      JSON.stringify({
        type: "objective_completed",
        reasonCode: "MISSION_AUTHORING_TURN_COMPLETED",
        safeActions: [],
      }),
    ]);
    expect(
      await repository.prepare(workspaceId, {
        kind: "reuse",
        projectId,
        authoringSessionId: prepared.authoringSessionId,
        idempotencyKey: `reuse-after-turn-${randomUUID()}`,
      }),
    ).toMatchObject({ reused: true, authoringSessionId: prepared.authoringSessionId });
    await expect(
      repository.prepare(workspaceId, { ...input, environmentId: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "AUTHORING_PREPARATION_IDEMPOTENCY_CONFLICT" } });
  });

  it("binds a pre-dispatch failure to fresh-intents recovery and factually refreshes stale continue", async () => {
    const created = await createActive(startInput(`runtime-recovery-${randomUUID()}`));
    sessionIds.push(created.id);
    const operationId = `runtime-failure-${randomUUID()}`;
    const failedIntent = missionIntent(operationId);
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId,
      idempotencyKey: `idempotency-${operationId}`,
      intent: failedIntent,
      action: operation(operationId).action,
      expectedEffect: operation(operationId).expectedEffect,
      mode: "rehearse",
    });
    const turnId = randomUUID();
    const failure = await repository.markOperationFailed(
      created.id,
      operationId,
      "BROWSER_RUNTIME_UNAVAILABLE",
      turnId,
    );
    expect(failure).toMatchObject({
      outcome: { mutationOutcome: "not_applied" },
      decisionBoundary: {
        authoringRecovery: {
          sessionId: created.id,
          environmentId,
          sourceTurnId: turnId,
          recoveryKind: "intents",
          requiresPendingTurn: false,
          preservesCurrentFlow: true,
        },
      },
    });
    const response = {
      turnId,
      state: "decision_required",
      completed: [],
      stateDelta: {},
      channels: {
        functional: { state: "failed", reasonCode: "BROWSER_RUNTIME_UNAVAILABLE" },
        mutation: { state: "passed" },
        privacy: { state: "not_applicable" },
        evidence: { state: "passed" },
        quality: { state: "passed" },
      },
      timings: { resolveMs: 0, executeMs: 0, verifyMs: 0, journalMs: 0, totalMs: 0 },
      decisionBoundary: failure!.decisionBoundary,
    };
    await database.query(
      `INSERT INTO mission_authoring_turns(
         id,session_id,idempotency_key,input_digest,safe_input,state,budgets,current_phase,safe_response,completed_at
       ) VALUES($1,$2,$3,$4,'{}'::jsonb,'decision_required',$5::jsonb,'resolve',$6::jsonb,now())`,
      [
        turnId,
        created.id,
        `failed-${randomUUID()}`,
        "a".repeat(64),
        JSON.stringify({ maxOperations: 1, maxDurationMs: 1_000 }),
        JSON.stringify(response),
      ],
    );
    await expect(
      repository.continueTurn({
        workspaceId,
        sessionId: created.id,
        turnId,
        idempotencyKey: `stale-${randomUUID()}`,
        budgets: { maxOperations: 1, maxDurationMs: 1_000 },
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_RECOVERY_STALE",
        currentTurnState: "decision_required",
        refreshedDecisionBoundary: { authoringRecovery: { recoveryKind: "intents" } },
      },
    });
    const recoveryBinding = failure!.decisionBoundary.authoringRecovery!;
    await expect(
      repository.beginTurn({
        workspaceId,
        sessionId: created.id,
        idempotencyKey: `wrong-recovery-${randomUUID()}`,
        inputDigest: "d".repeat(64),
        budgets: { maxOperations: 1, maxDurationMs: 1_000 },
        intents: [missionIntent(`${operationId}-different`)],
        recoveryBinding,
      }),
    ).rejects.toMatchObject({ response: { code: "MISSION_AUTHORING_RECOVERY_STALE" } });
    await expect(
      repository.beginTurn({
        workspaceId,
        sessionId: created.id,
        idempotencyKey: `recover-${randomUUID()}`,
        inputDigest: "b".repeat(64),
        budgets: { maxOperations: 1, maxDurationMs: 1_000 },
        intents: [failedIntent],
        recoveryBinding,
      }),
    ).resolves.toMatchObject({ state: "running", replayed: false });
    await expect(
      repository.beginTurn({
        workspaceId,
        sessionId: created.id,
        idempotencyKey: `repeat-${randomUUID()}`,
        inputDigest: "c".repeat(64),
        budgets: { maxOperations: 1, maxDurationMs: 1_000 },
        intents: [missionIntent(`${operationId}-repeat`)],
        recoveryBinding,
      }),
    ).rejects.toMatchObject({ response: { code: "MISSION_AUTHORING_RECOVERY_STALE" } });
  });

  it("rolls back preparation before creating any resource when prerequisites fail", async () => {
    const before = await controlPlaneCounts();
    await expect(
      repository.prepare(workspaceId, {
        kind: "reuse",
        projectId,
        authoringSessionId: randomUUID(),
        idempotencyKey: `missing-reuse-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "AUTHORING_PREPARATION_REUSE_UNAVAILABLE" } });
    expect(await controlPlaneCounts()).toEqual(before);
  });

  it("rolls back Mission, Objective, draft, and idempotency after a late insert failure", async () => {
    const conflictingSessionId = sessionIds[0]!;
    const key = `late-failure-${randomUUID()}`;
    const prior = await database.query<{ idempotencyKey: string }>(
      `UPDATE adaptive_sessions SET idempotency_key=$2 WHERE id=$1
       RETURNING idempotency_key AS "idempotencyKey"`,
      [conflictingSessionId, `prepare:${key}`],
    );
    const before = await controlPlaneCounts();
    await expect(repository.prepare(workspaceId, preparationInput(key))).rejects.toMatchObject({
      code: "23505",
    });
    expect(await controlPlaneCounts()).toEqual(before);
    const record = await database.query(
      `SELECT 1 FROM idempotency_records WHERE scope=$1 AND key=$2`,
      [`authoring:prepare:${projectId}`, key],
    );
    expect(record.rowCount).toBe(0);
    await database.query(`UPDATE adaptive_sessions SET idempotency_key=$2 WHERE id=$1`, [
      conflictingSessionId,
      `restored-${randomUUID()}`,
    ]);
    expect(prior.rowCount).toBe(1);
  });

  it("classifies an invalid Mission agent session as not applied without inferring continuation authority", async () => {
    const before = await controlPlaneCounts();

    await expect(
      repository.create(workspaceId, {
        ...startInput("invalid-agent-session"),
        agentSessionId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AGENT_SESSION_OWNERSHIP_INVALID",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
        safeActions: ["list_missions"],
      },
    });

    expect(await controlPlaneCounts()).toEqual(before);
  });

  it("rejects a Flow draft outside the supplied Mission and Objective chain as not applied", async () => {
    const before = await controlPlaneCounts();

    await expect(
      repository.create(workspaceId, {
        ...startInput("invalid-owner-chain"),
        objectiveId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_FLOW_AUTHORING_OWNERSHIP_INVALID",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
        safeActions: ["get_operating_context"],
      },
    });

    expect(await controlPlaneCounts()).toEqual(before);
  });

  it("atomically replaces environment, draft, and session only for the disclosed approved origins", async () => {
    const created = await createActive(startInput("trusted-recovery-source"));
    sessionIds.push(created.id);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Adaptive recovery','https://example.test',$3::jsonb)`,
      [randomUUID(), projectId, JSON.stringify({ allowedOrigins: ["https://example.test"] })],
    );
    await database.query(`UPDATE adaptive_sessions SET decision_boundary=$2::jsonb WHERE id=$1`, [
      created.id,
      JSON.stringify({
        type: "environment_unavailable",
        reasonCode: "ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED",
        safeActions: ["recover_trusted_script_origins"],
        environmentRecovery: {
          environmentId,
          missingTrustedScriptOrigins: ["https://scripts.example.com", "https://maps.example.com"],
          missingOriginClassification: "public",
          currentTrustedScriptOrigins: [],
          recoveryTool: "recover_trusted_script_origins",
          requiresNewFlowDraftAndAuthoringSession: true,
        },
      }),
    ]);
    const before = await controlPlaneCounts();
    const input = {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      sourceEnvironmentId: environmentId,
      sourceFlowDraftId: flowDraftId,
      sourceAuthoringSessionId: created.id,
      approvedOrigins: ["https://maps.example.com", "https://scripts.example.com"],
      approval: { kind: "explicit" as const, reason: "Approved for this disclosed boundary" },
      idempotencyKey: "trusted-recovery-atomic",
    };
    const recovered = await repository.recoverTrustedOrigins(workspaceId, input);
    sessionIds.push(recovered.sessionId!);
    expect(recovered).toMatchObject({
      recoveryApplied: true,
      replayed: false,
      continuation: { navigationRequired: true, navigationAutomaticallyPerformed: false },
    });
    expect(await repository.recoverTrustedOrigins(workspaceId, input)).toMatchObject({
      recoveryApplied: true,
      replayed: true,
      sessionId: recovered.sessionId,
      approvedOrigins: ["https://maps.example.com", "https://scripts.example.com"],
    });
    await expect(
      repository.recoverTrustedOrigins(workspaceId, {
        ...input,
        approvedOrigins: ["https://changed.example.com"],
      }),
    ).rejects.toMatchObject({
      response: {
        code: "TRUST_RECOVERY_IDEMPOTENCY_CONFLICT",
        mutationOutcome: "not_applied",
      },
    });
    const after = await controlPlaneCounts();
    expect(after.environments).toBe(before.environments + 1);
    expect(after.drafts).toBe(before.drafts + 1);
    expect(after.sessions).toBe(before.sessions + 1);
    const environment = await database.query<{
      name: string;
      policy: { trustedScriptOrigins: string[] };
    }>(`SELECT name,policy FROM environments WHERE id=$1`, [recovered.environmentId!]);
    expect(environment.rows[0]!.name).toMatch(/^Adaptive recovery [0-9a-f]{8}$/);
    expect(environment.rows[0]!.policy.trustedScriptOrigins).toEqual([
      "https://maps.example.com",
      "https://scripts.example.com",
    ]);
    await expect(
      repository.recoverTrustedOrigins(workspaceId, {
        ...input,
        sourceAuthoringSessionId: recovered.sessionId!,
        sourceEnvironmentId: recovered.environmentId!,
        sourceFlowDraftId: recovered.flowDraftId!,
        approvedOrigins: ["https://unapproved.example.com"],
        idempotencyKey: "trusted-recovery-unapproved",
      }),
    ).rejects.toMatchObject({ response: { code: "TRUST_RECOVERY_CONDITION_UNAVAILABLE" } });
  });

  it("loads an authorized protected execution context from PostgreSQL", async () => {
    const created = await createActive({
      ...startInput("protected-context-start"),
      protection: "protected" as const,
    });
    sessionIds.push(created.id);
    const authorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,operation_id,praxis_session_id,reason,status,granted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'protected_mutation','different-protected-operation',$5,'Integration qualification','approved',$6)`,
      [authorizationId, missionId, objectiveId, environmentId, created.id, agentSessionId],
    );
    const intent = {
      intentId: "generate-protected-context",
      objectiveId,
      flowDraftId,
      action: {
        kind: "acquire_protected_outputs" as const,
        preparationIntentIds: ["visit-credentials"],
        mutation: {
          kind: "one_time" as const,
          target: { concept: "generate", role: "button" as const, name: "Generate", exact: true },
        },
        outputs: [
          {
            reference: "clientSecret",
            classification: "protected" as const,
            target: {
              concept: "client secret",
              role: "textbox" as const,
              name: "Client secret",
              exact: true,
            },
            storageName: "Client secret",
          },
        ],
      },
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation" as const, authorizationId },
      protectedInputReferences: [],
    };
    const action = compileMissionAuthoringProtectedTransaction({
      operationId: "protected-context-operation",
      entryUrl: "https://example.test",
      action: intent.action,
      preparation: [
        {
          intentId: "visit-credentials",
          objectiveId,
          flowDraftId,
          action: { kind: "navigate", url: "https://example.test" },
          expectedEffect: { kind: "navigation", url: "https://example.test", match: "exact" },
          constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
          authorization: { kind: "ordinary" },
          protectedInputReferences: [],
        },
      ],
      timeoutMs: 1_000,
    });
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId: "protected-context-operation",
      idempotencyKey: "protected-context-operation-key",
      intent,
      action,
      expectedEffect: { type: "none" },
      mode: "transact",
    });

    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" },
    });

    await database.query(
      `UPDATE mission_authorizations SET operation_id='generate-protected-context' WHERE id=$1`,
      [authorizationId],
    );

    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).resolves.toEqual({
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      authorizationId,
      dispatchDisposition: "execute",
    });

    await database.query(`UPDATE mission_authorizations SET praxis_session_id=NULL WHERE id=$1`, [
      authorizationId,
    ]);
    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" },
    });

    await database.query(
      `UPDATE mission_authorizations SET status='approved',revoked_at=NULL,praxis_session_id=$2 WHERE id=$1`,
      [authorizationId, created.id],
    );
    await database.query(`UPDATE adaptive_sessions SET protection='ordinary' WHERE id=$1`, [
      created.id,
    ]);
    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" },
    });
    await database.query(`UPDATE adaptive_sessions SET protection='protected' WHERE id=$1`, [
      created.id,
    ]);

    const other = await createActive({
      ...startInput("other-protected-context-start"),
      protection: "protected" as const,
    });
    sessionIds.push(other.id);
    await database.query(`UPDATE mission_authorizations SET praxis_session_id=$2 WHERE id=$1`, [
      authorizationId,
      other.id,
    ]);
    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" },
    });

    await database.query(
      `UPDATE mission_authorizations SET praxis_session_id=$2,expires_at=now()-interval '1 second' WHERE id=$1`,
      [authorizationId, created.id],
    );
    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" },
    });

    await database.query(
      `UPDATE mission_authorizations SET expires_at=NULL,status='revoked',revoked_at=now() WHERE id=$1`,
      [authorizationId],
    );
    await expect(
      repository.protectedExecutionContext(created.id, "protected-context-operation"),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_AUTHORITY_INVALID" },
    });
  });

  it("requires a protected Praxis session before admitting protected references", async () => {
    const protectedReferenceId = randomUUID();

    await expect(
      repository.create(workspaceId, {
        ...startInput(`ordinary-protected-start-${randomUUID()}`),
        initialProtectedReferenceIds: [protectedReferenceId],
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_PROTECTED_SESSION_REQUIRED",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      },
    });

    const created = await createActive(startInput(`ordinary-protected-dispatch-${randomUUID()}`));
    sessionIds.push(created.id);
    await expect(
      repository.validateIntentAdmission({
        sessionId: created.id,
        intent: {
          intentId: "ordinary-session-protected-fill",
          objectiveId,
          flowDraftId,
          action: {
            kind: "fill",
            target: { concept: "email", role: "textbox", name: "Email", exact: true },
            protectedReferenceId,
          },
          expectedEffect: { kind: "none" },
          constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
          authorization: { kind: "authentication" },
          protectedInputReferences: [protectedReferenceId],
        },
      }),
    ).rejects.toMatchObject({
      response: {
        code: "MISSION_AUTHORING_PROTECTED_SESSION_REQUIRED",
        mutationOutcome: "not_applied",
        retry: "safe_after_prerequisite",
      },
    });
  });

  it("stores a functionally successful unknown mutation as reconciliation-required", async () => {
    const created = await createActive(startInput("unknown-mutation-start"));
    sessionIds.push(created.id);
    const intent = {
      intentId: "unknown-activate",
      objectiveId,
      flowDraftId,
      action: {
        kind: "activate" as const,
        target: {
          concept: "submit",
          role: "button" as const,
          name: "Submit",
          exact: true,
        },
      },
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" as const },
      protectedInputReferences: [],
    };
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId: "unknown-activate",
      idempotencyKey: "unknown-activate-operation",
      intent,
      action: {
        type: "click",
        target: {
          concept: "submit",
          requiredCapabilities: ["focusable", "pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Submit"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "ordinary",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        },
        expectedEffect: { type: "none" },
        timeoutMs: 1_000,
      },
      expectedEffect: { type: "none" },
      mode: "rehearse",
    });
    await database.query(
      `UPDATE adaptive_operations SET dispatch_boundary='dispatching'
      WHERE session_id=$1 AND operation_id='unknown-activate'`,
      [created.id],
    );
    const boundary = {
      type: "mutation_reconciliation_required" as const,
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_flow_authoring", "reconcile_unknown_operation"],
    };
    const settled = await repository.settleMissionOperation({
      sessionId: created.id,
      operationId: "unknown-activate",
      intent,
      action: {
        type: "click",
        target: {
          concept: "submit",
          requiredCapabilities: ["focusable", "pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Submit"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "ordinary",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        },
        expectedEffect: { type: "none" },
        timeoutMs: 1_000,
      },
      outcome: {
        operationId: "unknown-activate",
        functionalResult: "succeeded",
        mutationOutcome: "unknown",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
      capabilityManifestDigest: "c".repeat(64),
      decisionBoundary: boundary,
    });
    expect(settled.state).toBe("failed");
    const session = await repository.get(workspaceId, created.id);
    expect(session).toMatchObject({ state: "recovery_required" });
    expect(session.operations[0]).toMatchObject({
      state: "failed",
      outcome: { functionalResult: "succeeded", mutationOutcome: "unknown" },
      decisionBoundary: boundary,
    });
    await repository.recordDispatchBaseline({
      sessionId: created.id,
      operationId: "unknown-activate",
      expectedEffect: { type: "none" },
      documentEpoch: 7,
      url: "https://example.test/before",
      effectState: { state: "unsupported" },
    });
    await expect(
      database.query(
        `DELETE FROM adaptive_operation_dispatch_baselines
      WHERE session_id=$1 AND operation_id='unknown-activate'`,
        [created.id],
      ),
    ).rejects.toThrow();

    const first = await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId,
      operationId: "unknown-activate",
      idempotencyKey: "unknown-reconciliation-still",
    });
    expect(first).toMatchObject({
      state: "observing",
      replayed: false,
      expectedEffect: { type: "none" },
    });
    const unresolved = await repository.completeUnknownReconciliation({
      sessionId: created.id,
      missionId,
      operationId: "unknown-activate",
      idempotencyKey: "unknown-reconciliation-still",
      result: "still_unknown",
      reasonCode: "RECONCILIATION_EXPECTED_EFFECT_UNAVAILABLE",
      evidence: { expectedEffectType: "none" },
      runtimeOwned: false,
    });
    expect(unresolved).toMatchObject({
      missionFenceCleared: false,
      authoringSessionState: "recovery_required",
    });
    const original = await database.query<{
      mutationOutcome: string;
      reconciliationResult: string;
    }>(
      `SELECT operation.mutation_outcome AS "mutationOutcome",reconciliation.result AS "reconciliationResult"
         FROM adaptive_operations operation JOIN adaptive_operation_reconciliations reconciliation
           ON reconciliation.session_id=operation.session_id AND reconciliation.operation_id=operation.operation_id
        WHERE operation.session_id=$1 AND operation.operation_id=$2 ORDER BY reconciliation.attempt DESC LIMIT 1`,
      [created.id, "unknown-activate"],
    );
    expect(original.rows[0]).toEqual({
      mutationOutcome: "unknown",
      reconciliationResult: "still_unknown",
    });

    const second = await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId,
      operationId: "unknown-activate",
      idempotencyKey: "unknown-reconciliation-not-applied",
    });
    expect(second).toMatchObject({ state: "observing", attempt: 2 });
    const resolved = await repository.completeUnknownReconciliation({
      sessionId: created.id,
      missionId,
      operationId: "unknown-activate",
      idempotencyKey: "unknown-reconciliation-not-applied",
      result: "proven_not_applied",
      reasonCode: "RECONCILIATION_INVERSE_VISIBILITY_PROVEN",
      evidence: { targetState: "visible" },
      runtimeOwned: false,
    });
    expect(resolved).toMatchObject({ missionFenceCleared: true, authoringSessionState: "failed" });
    const afterResolution = await repository.get(workspaceId, created.id);
    expect(afterResolution).toMatchObject({
      state: "failed",
      decisionBoundary: {
        reasonCode: "AUTHORING_SESSION_RESTART_REQUIRED",
        safeActions: ["get_flow_authoring", "start_flow_authoring"],
      },
    });
    const deadLifecycle = await database.query<{ completedAt: string | null }>(
      `SELECT completed_at AS "completedAt" FROM adaptive_sessions WHERE id=$1`,
      [created.id],
    );
    expect(deadLifecycle.rows[0]!.completedAt).not.toBeNull();
    await expect(
      repository.beginUnknownReconciliation({
        workspaceId,
        sessionId: created.id,
        missionId: randomUUID(),
        operationId: "unknown-activate",
        idempotencyKey: "unknown-reconciliation-wrong-mission",
      }),
    ).rejects.toThrow();
    const replay = await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId,
      operationId: "unknown-activate",
      idempotencyKey: "unknown-reconciliation-not-applied",
    });
    expect(replay).toMatchObject({
      state: "completed",
      result: "proven_not_applied",
      replayed: true,
    });
    const restarted = await repository.create(
      workspaceId,
      startInput("restart-after-reconciliation"),
    );
    sessionIds.push(restarted.id);
    expect(await repository.get(workspaceId, restarted.id)).toMatchObject({
      state: "provisioning",
      missionId,
      objectiveId,
      flowDraftId,
    });

    await database.query(
      `UPDATE adaptive_sessions SET state='recovery_required',completed_at=NULL WHERE id=$1`,
      [created.id],
    );
    await database.query(
      `INSERT INTO adaptive_session_runtime_leases(session_id,owner_id,lease_expires_at)
      VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT(session_id) DO UPDATE
      SET lease_expires_at=EXCLUDED.lease_expires_at`,
      [created.id, randomUUID()],
    );
    await database.query(
      `INSERT INTO adaptive_operations
      SELECT (jsonb_populate_record(NULL::adaptive_operations,to_jsonb(operation) || jsonb_build_object(
        'operation_id','unknown-live-owner','idempotency_key','unknown-live-owner-key','sequence',2,'started_at',now(),
        'completed_at',now()))).* FROM adaptive_operations operation
      WHERE session_id=$1 AND operation_id='unknown-activate'`,
      [created.id],
    );
    await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId,
      operationId: "unknown-live-owner",
      idempotencyKey: "unknown-live-owner-reconcile",
    });
    const liveOwned = await repository.completeUnknownReconciliation({
      sessionId: created.id,
      missionId,
      operationId: "unknown-live-owner",
      idempotencyKey: "unknown-live-owner-reconcile",
      result: "proven_not_applied",
      reasonCode: "TEST_AUTHORITATIVE_NOT_APPLIED",
      evidence: { fixture: true },
      runtimeOwned: true,
    });
    expect(liveOwned).toMatchObject({ missionFenceCleared: true, authoringSessionState: "active" });
    const liveLifecycle = await database.query<{ state: string; completedAt: string | null }>(
      `SELECT state,completed_at AS "completedAt" FROM adaptive_sessions WHERE id=$1`,
      [created.id],
    );
    expect(liveLifecycle.rows[0]).toEqual({ state: "active", completedAt: null });
  });

  it("recovers the exact stale running turn only before a safe dispatch", async () => {
    const created = await createActive(startInput("stale-turn-recovery-start"));
    sessionIds.push(created.id);
    const intent = {
      intentId: "stale-navigation",
      objectiveId,
      flowDraftId,
      action: { kind: "navigate" as const, url: "https://example.test/details" },
      expectedEffect: {
        kind: "navigation" as const,
        url: "https://example.test/details",
        match: "exact" as const,
      },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" as const },
      protectedInputReferences: [],
    };
    const turnInput = {
      workspaceId,
      sessionId: created.id,
      idempotencyKey: "stale-navigation-turn",
      inputDigest: "a".repeat(64),
      budgets: { maxOperations: 1, maxDurationMs: 10_000 },
      intents: [intent],
    };
    const turn = await repository.beginTurn(turnInput);
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId: "stale-navigation-operation",
      idempotencyKey: "stale-navigation-operation-key",
      intent,
      action: {
        type: "navigate",
        url: "https://example.test/details",
        timeoutMs: 1_000,
      },
      expectedEffect: { type: "navigation", url: "https://example.test/details", match: "exact" },
      mode: "rehearse",
    });

    await expect(repository.beginTurn(turnInput)).resolves.toMatchObject({
      turnId: turn.turnId,
      replayed: true,
      state: "running",
    });
    await database.query(
      `UPDATE mission_authoring_turns SET updated_at=now()-interval '20 seconds' WHERE id=$1`,
      [turn.turnId],
    );
    await expect(repository.beginTurn(turnInput)).resolves.toMatchObject({
      turnId: turn.turnId,
      replayed: false,
      recovered: true,
      phase: "resume",
    });
  });

  it("serializes concurrent reconciliation and clears a Mission fence only after every UNKNOWN resolves", async () => {
    const created = await createActive(startInput(`multiple-unknown-${randomUUID()}`));
    sessionIds.push(created.id);
    for (const [sequence, operationId] of ["unknown-one", "unknown-two"].entries()) {
      const safeOutcome = {
        operationId,
        functionalResult: "inconclusive",
        mutationOutcome: "unknown",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 0,
      };
      await database.query(
        `INSERT INTO adaptive_operations(session_id,operation_id,sequence,mode,state,
          semantic_intent,expected_effect,policy_digest,dispatch_boundary,mutation_outcome,functional_result,
          privacy_result,evidence_result,quality_findings,safe_outcome,decision_boundary,idempotency_key,
          mission_id,objective_id,flow_draft_id,authoring_intent,derived_action,completed_at)
        VALUES($1,$2,$3,'observe','failed',$4::jsonb,'{"type":"none"}'::jsonb,$5,'dispatching','unknown',
          'inconclusive','unverified','[]'::jsonb,'[]'::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$4::jsonb,$12::jsonb,now())`,
        [
          created.id,
          operationId,
          sequence + 1,
          JSON.stringify({
            intentId: operationId,
            objectiveId,
            flowDraftId,
            action: { kind: "inspect", target: { concept: "fixture", role: "text" } },
            expectedEffect: { kind: "none" },
            constraints: { timeoutMs: 1000, allowNewPage: false, allowNonExact: false },
            authorization: { kind: "ordinary" },
            protectedInputReferences: [],
          }),
          "d".repeat(64),
          JSON.stringify(safeOutcome),
          JSON.stringify({
            type: "mutation_reconciliation_required",
            reasonCode: "TEST_UNKNOWN",
            safeActions: ["get_flow_authoring"],
          }),
          `idempotency-${operationId}`,
          missionId,
          objectiveId,
          flowDraftId,
          JSON.stringify({
            action: { type: "waitFor", timeoutMs: 1000 },
            expectedEffect: { type: "none" },
            mode: "observe",
          }),
        ],
      );
    }
    await database.query(`UPDATE adaptive_sessions SET state='recovery_required' WHERE id=$1`, [
      created.id,
    ]);
    const attempts = await Promise.allSettled([
      repository.beginUnknownReconciliation({
        workspaceId,
        sessionId: created.id,
        missionId,
        operationId: "unknown-one",
        idempotencyKey: "concurrent-one-a",
      }),
      repository.beginUnknownReconciliation({
        workspaceId,
        sessionId: created.id,
        missionId,
        operationId: "unknown-one",
        idempotencyKey: "concurrent-one-b",
      }),
    ]);
    expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((value) => value.status === "rejected")).toHaveLength(1);
    const winnerKey = (
      await database.query<{ key: string }>(
        `SELECT idempotency_key AS key FROM adaptive_operation_reconciliations
        WHERE session_id=$1 AND operation_id='unknown-one' AND state='observing'`,
        [created.id],
      )
    ).rows[0]!.key;
    const first = await repository.completeUnknownReconciliation({
      sessionId: created.id,
      missionId,
      operationId: "unknown-one",
      idempotencyKey: winnerKey,
      result: "proven_not_applied",
      reasonCode: "TEST_NOT_APPLIED",
      evidence: { fixture: true },
      runtimeOwned: false,
    });
    expect(first.missionFenceCleared).toBe(false);
    await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId,
      operationId: "unknown-two",
      idempotencyKey: "unknown-two-reconcile",
    });
    const second = await repository.completeUnknownReconciliation({
      sessionId: created.id,
      missionId,
      operationId: "unknown-two",
      idempotencyKey: "unknown-two-reconcile",
      result: "proven_not_applied",
      reasonCode: "TEST_NOT_APPLIED",
      evidence: { fixture: true },
      runtimeOwned: false,
    });
    expect(second.missionFenceCleared).toBe(true);
    await expect(
      database.query(`DELETE FROM adaptive_operation_reconciliations WHERE session_id=$1`, [
        created.id,
      ]),
    ).rejects.toThrow();
    await expect(
      database.query(
        `UPDATE adaptive_operation_reconciliations SET reason_code='TAMPERED' WHERE session_id=$1`,
        [created.id],
      ),
    ).rejects.toThrow();
  });

  it("reclaims a stale post-dispatch turn without authorizing redispatch", async () => {
    const created = await createActive(startInput("unsafe-turn-recovery-start"));
    sessionIds.push(created.id);
    const intent = {
      intentId: "stale-submit",
      objectiveId,
      flowDraftId,
      action: {
        kind: "activate" as const,
        target: { concept: "submit", role: "button" as const, name: "Submit", exact: true },
      },
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" as const },
      protectedInputReferences: [],
    };
    const turnInput = {
      workspaceId,
      sessionId: created.id,
      idempotencyKey: "stale-submit-turn",
      inputDigest: "b".repeat(64),
      budgets: { maxOperations: 1, maxDurationMs: 10_000 },
      intents: [intent],
    };
    const turn = await repository.beginTurn(turnInput);
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId: "stale-submit-operation",
      idempotencyKey: "stale-submit-operation-key",
      intent,
      action: credentialRevocationAction(),
      expectedEffect: { type: "none" },
      mode: "rehearse",
    });
    await database.query(
      `UPDATE adaptive_operations SET dispatch_boundary='dispatching'
       WHERE session_id=$1 AND operation_id='stale-submit-operation'`,
      [created.id],
    );

    await expect(repository.beginTurn(turnInput)).resolves.toMatchObject({
      turnId: turn.turnId,
      replayed: true,
      state: "running",
    });
    await database.query(
      `UPDATE mission_authoring_turns SET updated_at=now()-interval '20 seconds' WHERE id=$1`,
      [turn.turnId],
    );
    await expect(repository.beginTurn(turnInput)).resolves.toMatchObject({
      turnId: turn.turnId,
      replayed: false,
      recovered: true,
      phase: "resume",
    });
  });

  it("atomically projects revoked credential pairs and denies cached-session reuse", async () => {
    const credentialIds = [randomUUID(), randomUUID()];
    const authorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'live_mutation','Credential lifecycle regression','approved',$5)`,
      [authorizationId, missionId, objectiveId, environmentId, agentSessionId],
    );
    for (const [index, credentialId] of credentialIds.entries()) {
      await database.query(
        `INSERT INTO project_credentials(
           id,project_id,name,ciphertext,initialization_vector,authentication_tag,
           origin_mission_id,origin_objective_id,created_by_agent_session_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          credentialId,
          projectId,
          `Credential ${index}`,
          Buffer.from("ciphertext"),
          Buffer.alloc(12),
          Buffer.alloc(16),
          missionId,
          objectiveId,
          agentSessionId,
        ],
      );
    }
    await database.query(
      `UPDATE environments SET secret_refs=secret_refs || $2::jsonb WHERE id=$1`,
      [environmentId, JSON.stringify(credentialIds)],
    );
    const created = await createActive({
      ...startInput("credential-revocation-start"),
      initialProtectedReferenceIds: credentialIds,
      protection: "protected" as const,
    });
    sessionIds.push(created.id);
    const operationId = "credential-revocation";
    const intent = credentialRevocationIntent(operationId, credentialIds, authorizationId);
    const action = credentialRevocationAction();
    await expect(
      repository.validateIntentAdmission({ sessionId: created.id, intent }),
    ).resolves.toBeUndefined();
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId,
      idempotencyKey: `${operationId}-key`,
      intent,
      action,
      expectedEffect: { type: "none" },
      mode: "transact",
    });
    await repository.settleMissionOperation({
      sessionId: created.id,
      operationId,
      intent,
      action,
      outcome: successfulMutationOutcome(operationId),
      capabilityManifestDigest: "e".repeat(64),
      decisionBoundary: {
        type: "objective_completed",
        reasonCode: "OPERATION_COMPLETED",
        safeActions: [],
      },
    });

    const statuses = await credentialStatuses(credentialIds);
    expect(statuses).toEqual(credentialIds.map((id) => ({ id, status: "revoked" })));
    await expect(
      repository.validateIntentAdmission({ sessionId: created.id, intent }),
    ).rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });
    await expect(repository.resolveCredential(created.id, credentialIds[0]!)).rejects.toMatchObject(
      { response: { code: "ADAPTIVE_CREDENTIAL_UNAVAILABLE" } },
    );
    await expect(
      repository.create(workspaceId, {
        ...startInput("revoked-credential-new-session"),
        initialProtectedReferenceIds: [credentialIds[0]!],
        protection: "protected" as const,
      }),
    ).rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });

    await expect(
      repository.projectCredentialLifecycleForAuthoring({ sessionId: created.id, operationId }),
    ).resolves.toEqual({ projected: false, lifecycle: "revoke" });
    const activity = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mission_activities
        WHERE mission_id=$1 AND safe_metadata->>'operationId'=$2
          AND summary='Protected credential lifecycle projected'`,
      [missionId, operationId],
    );
    expect(activity.rows[0]!.count).toBe("1");
  });

  it.each(["compromised", "revoked"] as const)(
    "rejects %s references for new and already-allowlisted sessions before preparation",
    async (securityStatus) => {
      const credentialId = randomUUID();
      await database.query(
        `INSERT INTO project_credentials(
           id,project_id,name,ciphertext,initialization_vector,authentication_tag,
           origin_mission_id,origin_objective_id,created_by_agent_session_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          credentialId,
          projectId,
          `Lifecycle ${securityStatus} ${credentialId}`,
          Buffer.from("ciphertext"),
          Buffer.alloc(12),
          Buffer.alloc(16),
          missionId,
          objectiveId,
          agentSessionId,
        ],
      );
      await database.query(
        `UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1`,
        [environmentId, credentialId],
      );
      const existing = await createActive({
        ...startInput(`lifecycle-${securityStatus}-existing`),
        initialProtectedReferenceIds: [credentialId],
        protection: "protected" as const,
      });
      sessionIds.push(existing.id);
      const intent = protectedFillIntent(`use-${securityStatus}`, credentialId);

      await expect(
        repository.validateIntentAdmission({ sessionId: existing.id, intent }),
      ).resolves.toBeUndefined();
      await database.query(
        `UPDATE project_credentials SET security_status=$2,updated_at=now() WHERE id=$1`,
        [credentialId, securityStatus],
      );

      await expect(
        repository.validateIntentAdmission({ sessionId: existing.id, intent }),
      ).rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });
      await expect(
        repository.create(workspaceId, {
          ...startInput(`lifecycle-${securityStatus}-new`),
          initialProtectedReferenceIds: [credentialId],
          protection: "protected" as const,
        }),
      ).rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });
    },
  );

  it("rolls back the complete lifecycle projection when a credential pair is invalid", async () => {
    const credentialId = randomUUID();
    const missingCredentialId = randomUUID();
    const authorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'live_mutation','Credential pair atomicity regression','approved',$5)`,
      [authorizationId, missionId, objectiveId, environmentId, agentSessionId],
    );
    await database.query(
      `INSERT INTO project_credentials(
         id,project_id,name,ciphertext,initialization_vector,authentication_tag,
         origin_mission_id,origin_objective_id,created_by_agent_session_id
       ) VALUES($1,$2,'Atomic credential',$3,$4,$5,$6,$7,$8)`,
      [
        credentialId,
        projectId,
        Buffer.from("ciphertext"),
        Buffer.alloc(12),
        Buffer.alloc(16),
        missionId,
        objectiveId,
        agentSessionId,
      ],
    );
    await database.query(
      `UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1`,
      [environmentId, credentialId],
    );
    const created = await createActive({
      ...startInput("credential-pair-atomicity-start"),
      initialProtectedReferenceIds: [credentialId],
      protection: "protected" as const,
    });
    sessionIds.push(created.id);
    const operationId = "credential-pair-atomicity";
    const intent = credentialRevocationIntent(
      operationId,
      [credentialId, missingCredentialId],
      authorizationId,
    );
    const action = credentialRevocationAction();
    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId,
      idempotencyKey: `${operationId}-key`,
      intent,
      action,
      expectedEffect: { type: "none" },
      mode: "transact",
    });
    await expect(
      repository.settleMissionOperation({
        sessionId: created.id,
        operationId,
        intent,
        action,
        outcome: successfulMutationOutcome(operationId),
        capabilityManifestDigest: "a".repeat(64),
        decisionBoundary: {
          type: "objective_completed",
          reasonCode: "OPERATION_COMPLETED",
          safeActions: [],
        },
      }),
    ).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED" },
    });
    expect(await credentialStatuses([credentialId])).toEqual([
      { id: credentialId, status: "active" },
    ]);
    const operation = await database.query<{ state: string }>(
      `SELECT state FROM adaptive_operations WHERE session_id=$1 AND operation_id=$2`,
      [created.id, operationId],
    );
    expect(operation.rows[0]!.state).toBe("running");
  });

  it("projects canonical authenticate fields into UNKNOWN reconciliation authority without plaintext", async () => {
    const created = await createActive(startInput(`authenticate-recovery-${randomUUID()}`));
    sessionIds.push(created.id);

    const preparationOperationId = `authenticate-${randomUUID()}`;
    const unknownOperationId = `unknown-${randomUUID()}`;
    const emailReference = randomUUID();
    const passwordReference = randomUUID();

    const authenticateIntent = {
      intentId: preparationOperationId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "authenticate",
        fields: [
          {
            target: { concept: "login email", exact: true },
            protectedReferenceId: emailReference,
          },
          {
            target: { concept: "login password", exact: true },
            protectedReferenceId: passwordReference,
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: {
        timeoutMs: 1_000,
        allowNewPage: false,
        allowNonExact: false,
      },
      authorization: { kind: "authentication" },
      protectedInputReferences: [emailReference, passwordReference],
    };

    const unknownIntent = {
      intentId: unknownOperationId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: [preparationOperationId],
      },
      expectedEffect: { kind: "none" },
      constraints: {
        timeoutMs: 1_000,
        allowNewPage: false,
        allowNonExact: false,
      },
      authorization: { kind: "protected_mutation" },
      protectedInputReferences: [],
    };

    const preparationOutcome = {
      operationId: preparationOperationId,
      functionalResult: "succeeded",
      mutationOutcome: "not_applied",
      privacyResult: "verified",
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 1,
    };

    const unknownOutcome = {
      operationId: unknownOperationId,
      functionalResult: "inconclusive",
      mutationOutcome: "unknown",
      privacyResult: "unverified",
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 1,
    };

    await database.query(
      `INSERT INTO adaptive_operations(
         session_id,operation_id,sequence,mode,state,
         semantic_intent,expected_effect,policy_digest,
         dispatch_boundary,mutation_outcome,functional_result,
         privacy_result,evidence_result,quality_findings,
         safe_outcome,decision_boundary,idempotency_key,
         mission_id,objective_id,flow_draft_id,
         authoring_intent,derived_action,completed_at
       ) VALUES
       (
         $1,$2,1,'observe','completed',
         $3::jsonb,'{"type":"none"}'::jsonb,$4,
         'acknowledged','not_applied','succeeded',
         'verified','[]'::jsonb,'[]'::jsonb,
         $5::jsonb,$6::jsonb,$7,
         $8,$9,$10,$3::jsonb,$11::jsonb,now()
       ),
       (
         $1,$12,2,'transact','failed',
         $13::jsonb,'{"type":"none"}'::jsonb,$4,
         'dispatching','unknown','inconclusive',
         'unverified','[]'::jsonb,'[]'::jsonb,
         $14::jsonb,$15::jsonb,$16,
         $8,$9,$10,$13::jsonb,$11::jsonb,now()
       )`,
      [
        created.id,
        preparationOperationId,
        JSON.stringify(authenticateIntent),
        "a".repeat(64),
        JSON.stringify(preparationOutcome),
        JSON.stringify({
          type: "operation_completed",
          reasonCode: "TEST_AUTHENTICATE_PREPARATION",
          safeActions: [],
        }),
        `${preparationOperationId}-key`,
        missionId,
        objectiveId,
        flowDraftId,
        JSON.stringify({
          action: { type: "waitFor", timeoutMs: 1 },
          expectedEffect: { type: "none" },
          mode: "observe",
        }),
        unknownOperationId,
        JSON.stringify(unknownIntent),
        JSON.stringify(unknownOutcome),
        JSON.stringify({
          type: "mutation_reconciliation_required",
          reasonCode: "TEST_UNKNOWN",
          safeActions: ["get_flow_authoring"],
        }),
        `${unknownOperationId}-key`,
      ],
    );

    const expectedFacts = [
      {
        intentId: preparationOperationId,
        actionKind: "authenticate",
        protectedReferenceId: emailReference,
        targetConcept: "login email",
      },
      {
        intentId: preparationOperationId,
        actionKind: "authenticate",
        protectedReferenceId: passwordReference,
        targetConcept: "login password",
      },
    ];

    const readAuthority = await repository.getUnknownReconciliationAuthority(
      workspaceId,
      created.id,
      unknownOperationId,
    );

    expect(readAuthority?.preparationFacts).toEqual(expectedFacts);
    expect(JSON.stringify(readAuthority?.preparationFacts)).not.toContain(
      "opaque-protected-fixture",
    );

    const begun = await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId,
      operationId: unknownOperationId,
      idempotencyKey: `${unknownOperationId}-reconcile`,
    });

    expect(begun.authority.preparationFacts).toEqual(expectedFacts);
    expect(JSON.stringify(begun.authority.preparationFacts)).not.toContain(
      "opaque-protected-fixture",
    );

    const cleanup = await repository.completeUnknownReconciliation({
      sessionId: created.id,
      missionId,
      operationId: unknownOperationId,
      idempotencyKey: `${unknownOperationId}-reconcile`,
      result: "proven_not_applied",
      reasonCode: "TEST_FIXTURE_RECONCILIATION_CLEANUP",
      evidence: { fixtureCleanup: true },
      runtimeOwned: false,
    });

    expect(cleanup).toMatchObject({ missionFenceCleared: true });
  });

  it("fails closed on uncertain revocation and preserves active status when not applied", async () => {
    const authorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'live_mutation','Credential lifecycle failure regression','approved',$5)`,
      [authorizationId, missionId, objectiveId, environmentId, agentSessionId],
    );
    for (const mutationOutcome of ["unknown", "not_applied"] as const) {
      const credentialId = randomUUID();
      await database.query(
        `INSERT INTO project_credentials(
           id,project_id,name,ciphertext,initialization_vector,authentication_tag,
           origin_mission_id,origin_objective_id,created_by_agent_session_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          credentialId,
          projectId,
          `Credential ${mutationOutcome}`,
          Buffer.from("ciphertext"),
          Buffer.alloc(12),
          Buffer.alloc(16),
          missionId,
          objectiveId,
          agentSessionId,
        ],
      );
      await database.query(
        `UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1`,
        [environmentId, credentialId],
      );
      const operationId = `credential-revocation-${mutationOutcome}`;
      const created = await createActive({
        ...startInput(`${operationId}-start`),
        initialProtectedReferenceIds: [credentialId],
        protection: "protected" as const,
      });
      sessionIds.push(created.id);
      const intent = credentialRevocationIntent(operationId, [credentialId], authorizationId);
      const action = credentialRevocationAction();
      await repository.beginMissionOperation({
        workspaceId,
        sessionId: created.id,
        operationId,
        idempotencyKey: `${operationId}-key`,
        intent,
        action,
        expectedEffect: { type: "none" },
        mode: "transact",
      });
      if (mutationOutcome === "unknown")
        await database.query(
          `UPDATE adaptive_operations SET dispatch_boundary='dispatching' WHERE session_id=$1 AND operation_id=$2`,
          [created.id, operationId],
        );
      await repository.settleMissionOperation({
        sessionId: created.id,
        operationId,
        intent,
        action,
        outcome: {
          ...successfulMutationOutcome(operationId),
          functionalResult: "failed",
          mutationOutcome,
          reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
        },
        capabilityManifestDigest: "f".repeat(64),
        decisionBoundary:
          mutationOutcome === "unknown"
            ? {
                type: "mutation_reconciliation_required",
                reasonCode: "MUTATION_OUTCOME_UNKNOWN",
                safeActions: ["get_flow_authoring"],
              }
            : {
                type: "environment_unavailable",
                reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
                safeActions: ["advance_session"],
              },
      });
      expect(await credentialStatuses([credentialId])).toEqual([
        {
          id: credentialId,
          status: mutationOutcome === "unknown" ? "compromised" : "active",
        },
      ]);
      if (mutationOutcome === "unknown") {
        await repository.beginUnknownReconciliation({
          workspaceId,
          sessionId: created.id,
          missionId,
          operationId,
          idempotencyKey: `${operationId}-reconcile`,
        });
        await repository.completeUnknownReconciliation({
          sessionId: created.id,
          missionId,
          operationId,
          idempotencyKey: `${operationId}-reconcile`,
          result: "proven_not_applied",
          reasonCode: "TEST_AUTHORITATIVE_NOT_APPLIED",
          evidence: { fixture: true },
          runtimeOwned: false,
        });
      }
    }
  });

  it("enforces ordered append-only journal and transition versions", async () => {
    const created = await createActive(startInput("journal-start"));
    sessionIds.push(created.id);
    const claim = await repository.beginOperation(
      workspaceId,
      created.id,
      operation("operation-1"),
    );
    expect(claim.replayed).toBe(false);
    await repository.settleOperation({
      sessionId: created.id,
      operationId: "operation-1",
      capabilityManifestDigest: "b".repeat(64),
      outcome: {
        operationId: "operation-1",
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
      decisionBoundary: {
        type: "turn_budget_exhausted",
        reasonCode: "TURN_BUDGET_EXHAUSTED",
        safeActions: ["advance_session"],
      },
    });
    const session = await repository.get(workspaceId, created.id);
    expect(session.operations).toHaveLength(1);
    expect(session.operations[0]?.action).toEqual({
      type: "navigate",
      url: "https://example.test/details",
      timeoutMs: 10_000,
    });
    expect((session.events as Array<{ sequence: number }>).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    await expect(
      database.query(`UPDATE adaptive_session_events SET safe_facts='{}' WHERE session_id=$1`, [
        created.id,
      ]),
    ).rejects.toThrow("Adaptive session journal is append-only");
    await expect(
      repository.transition({
        workspaceId,
        sessionId: created.id,
        expectedVersion: 3,
        target: "suspended",
        eventType: "session_suspended",
        reason: "pause",
        idempotencyKey: "pause-operation-1",
      }),
    ).rejects.toMatchObject({ response: { code: "ADAPTIVE_SESSION_VERSION_CONFLICT" } });
  });

  it("supports suspend, resume, and cancel without losing journal history", async () => {
    const created = await createActive(startInput("transition-start"));
    sessionIds.push(created.id);
    const suspended = await repository.transition({
      workspaceId,
      sessionId: created.id,
      expectedVersion: 3,
      target: "suspended",
      eventType: "session_suspended",
      reason: "operator pause",
      idempotencyKey: "transition-suspend",
    });
    const resumed = await repository.transition({
      workspaceId,
      sessionId: created.id,
      expectedVersion: suspended.version,
      target: "active",
      eventType: "session_resumed",
      reason: "safe to resume",
      idempotencyKey: "transition-resume",
    });
    const cancelled = await repository.transition({
      workspaceId,
      sessionId: created.id,
      expectedVersion: resumed.version,
      target: "cancelled",
      eventType: "session_cancelled",
      reason: "done",
      idempotencyKey: "transition-cancel",
    });
    expect(cancelled).toMatchObject({ state: "cancelled", version: 6 });
    await expect(
      repository.transition({
        workspaceId,
        sessionId: created.id,
        expectedVersion: 6,
        target: "active",
        eventType: "session_resumed",
        reason: "invalid",
        idempotencyKey: "transition-invalid",
      }),
    ).rejects.toMatchObject({ response: { code: "ADAPTIVE_SESSION_TRANSITION_INVALID" } });
  });

  it("derives acknowledgement only from the durable mutation fence", async () => {
    const created = await createActive(startInput("dispatch-truth-start"));
    sessionIds.push(created.id);
    const ownerId = randomUUID();
    const lease = await repository.claimRuntimeLease({
      sessionId: created.id,
      ownerId,
      leaseDurationMs: 30_000,
    });

    await repository.beginOperation(workspaceId, created.id, mutatingOperation("pre-dispatch"));
    await repository.settleOperation({
      sessionId: created.id,
      operationId: "pre-dispatch",
      capabilityManifestDigest: "c".repeat(64),
      outcome: {
        operationId: "pre-dispatch",
        functionalResult: "failed",
        mutationOutcome: "not_applied",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
        reasonCode: "PRAXIS_REQUIRED_CHANNEL_FORBIDDEN",
      },
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "PRAXIS_REQUIRED_CHANNEL_FORBIDDEN",
        safeActions: ["advance_session"],
      },
    });

    await repository.beginOperation(workspaceId, created.id, mutatingOperation("dispatched"));
    await repository.markOperationDispatching({
      sessionId: created.id,
      operationId: "dispatched",
      ownerId,
      fencingToken: lease.fencingToken,
    });
    await repository.settleOperation({
      sessionId: created.id,
      operationId: "dispatched",
      capabilityManifestDigest: "d".repeat(64),
      outcome: {
        operationId: "dispatched",
        functionalResult: "succeeded",
        mutationOutcome: "applied",
        privacyResult: "unverified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
      decisionBoundary: {
        type: "objective_completed",
        reasonCode: "OPERATION_COMPLETED",
        safeActions: [],
      },
    });

    const session = await repository.get(workspaceId, created.id);
    expect(session).toMatchObject({ state: "active" });
    expect(session.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "pre-dispatch",
          dispatchBoundary: "not_dispatched",
          outcome: expect.objectContaining({ mutationOutcome: "not_applied" }),
        }),
        expect.objectContaining({
          operationId: "dispatched",
          dispatchBoundary: "acknowledged",
          outcome: expect.objectContaining({ mutationOutcome: "applied" }),
        }),
      ]),
    );
  });

  it("fences a stale runtime owner and resumes with a new owner", async () => {
    const created = await createActive(startInput("lease-restart-start"));
    sessionIds.push(created.id);
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    const first = await repository.claimRuntimeLease({
      sessionId: created.id,
      ownerId: firstOwner,
      leaseDurationMs: 30_000,
    });
    await expect(
      repository.claimRuntimeLease({
        sessionId: created.id,
        ownerId: secondOwner,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toMatchObject({ response: { code: "ADAPTIVE_SESSION_RUNTIME_LEASE_HELD" } });
    await database.query(
      `UPDATE adaptive_session_runtime_leases SET lease_expires_at=now()-interval '1 second'
       WHERE session_id=$1`,
      [created.id],
    );
    await expect(
      repository.heartbeatRuntimeLease({
        sessionId: created.id,
        ownerId: firstOwner,
        fencingToken: first.fencingToken,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    await database.query(
      `UPDATE adaptive_session_runtime_leases SET lease_expires_at=now()-interval '1 second'
       WHERE session_id=$1`,
      [created.id],
    );
    let replacement = await repository.claimRuntimeLease({
      sessionId: created.id,
      ownerId: secondOwner,
      leaseDurationMs: 30_000,
    });
    expect(replacement.fencingToken).toBe(first.fencingToken + 1);
    await expect(
      repository.heartbeatRuntimeLease({
        sessionId: created.id,
        ownerId: firstOwner,
        fencingToken: first.fencingToken,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toMatchObject({ response: { code: "ADAPTIVE_SESSION_RUNTIME_LEASE_LOST" } });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.beginOperation(workspaceId, created.id, operation(`concurrent-${index}`)),
      ),
    );
    const session = await repository.get(workspaceId, created.id);
    expect(
      (session.operations as Array<{ sequence: number }>).map((item) => item.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const replay = await repository.beginOperation(
      workspaceId,
      created.id,
      operation("concurrent-0"),
    );
    expect(replay).toMatchObject({ replayed: true, operationId: "concurrent-0" });
    expect(await repository.replayDisposition(created.id, "concurrent-0")).toMatchObject({
      leaseHealthy: true,
      dispatchBoundary: "not_dispatched",
      requiresReconciliation: false,
    });
    await repository.markOperationDispatching({
      sessionId: created.id,
      operationId: "concurrent-0",
      ownerId: secondOwner,
      fencingToken: replacement.fencingToken,
    });
    expect(await repository.replayDisposition(created.id, "concurrent-0")).toMatchObject({
      leaseHealthy: true,
      mutating: false,
      dispatchBoundary: "dispatching",
      requiresReconciliation: false,
      canResume: false,
    });
    await database.query(
      `UPDATE adaptive_session_runtime_leases SET lease_expires_at=now()-interval '1 second'
       WHERE session_id=$1`,
      [created.id],
    );
    expect(await repository.replayDisposition(created.id, "concurrent-0")).toMatchObject({
      leaseHealthy: false,
      mutating: false,
      requiresReconciliation: false,
      canResume: true,
    });
    replacement = await repository.claimRuntimeLease({
      sessionId: created.id,
      ownerId: secondOwner,
      leaseDurationMs: 30_000,
    });
    await repository.markOperationFailed(created.id, "concurrent-0", "BROWSER_DISCONNECTED");
    const readOnlyFailure = await repository.get(workspaceId, created.id);
    expect(readOnlyFailure).toMatchObject({ state: "recovery_required" });
    expect(readOnlyFailure.operations[0]).toMatchObject({
      state: "failed",
      dispatchBoundary: "dispatching",
      decisionBoundary: {
        type: "mutation_reconciliation_required",
        reasonCode: "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN",
      },
      outcome: {
        functionalResult: "failed",
        mutationOutcome: "unknown",
        reasonCode: "BROWSER_DISCONNECTED",
      },
    });
  });

  function startInput(idempotencyKey: string) {
    return {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      environmentId,
      objective: "Inspect account details",
      allowedOrigins: ["https://example.test"],
      idempotencyKey,
      protection: "ordinary" as const,
    };
  }

  function preparationInput(idempotencyKey: string) {
    return {
      kind: "create" as const,
      projectId,
      environmentId,
      mission: {
        title: `Prepared ${randomUUID()}`,
        originalInstruction: `Prepare only ${idempotencyKey}`,
        provider: "codex" as const,
        instructionSnapshot: `Prepare only ${idempotencyKey}`,
        distinctReason: "Integration fixture",
      },
      objective: {
        title: "Prepared objective",
        description: "No browser work",
        dependencies: [],
        completionCriteria: [{ description: "Lifecycle is coherent", required: true }],
        order: 0,
      },
      draft: {
        name: "Prepared draft",
        description: "No execution",
        purpose: "diagnostic" as const,
        content: {
          objective: "Prepare",
          preconditions: [],
          expectedOutcomes: ["Ready"],
          prohibitedSideEffects: ["No navigation"],
        },
        plan: {
          name: "Unexecuted",
          objective: "Prepare",
          preconditions: [],
          allowedOrigins: ["https://example.test"],
          budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
          checkpoints: [],
          steps: [
            {
              id: "not-executed",
              title: "Reserved",
              action: { type: "navigate" as const, url: "https://example.test" },
              assertions: [],
              onFailure: "stop" as const,
              evidence: [],
              captureIntent: "final" as const,
            },
          ],
        },
      },
      authoring: {
        objective: "Prepare",
        allowedOrigins: ["https://example.test"],
        turnBudgets: { maxOperations: 1, maxDurationMs: 10_000 },
        initialProtectedReferenceIds: [],
      },
      idempotencyKey,
    };
  }

  function operation(operationId: string) {
    return {
      operationId,
      idempotencyKey: `idempotency-${operationId}`,
      action: {
        type: "navigate" as const,
        url: "https://example.test/details",
        timeoutMs: 10_000,
      },
      expectedEffect: {
        type: "navigation" as const,
        url: "https://example.test/details",
        match: "exact" as const,
      },
      mode: "rehearse" as const,
      protectedInputReferences: [],
    };
  }

  function missionIntent(intentId: string) {
    return {
      intentId,
      objectiveId,
      flowDraftId,
      action: { kind: "navigate" as const, url: "https://example.test/details" },
      expectedEffect: {
        kind: "navigation" as const,
        url: "https://example.test/details",
        match: "exact" as const,
      },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "live_read" as const },
      protectedInputReferences: [],
    };
  }

  function mutatingOperation(operationId: string) {
    return {
      operationId,
      idempotencyKey: `idempotency-${operationId}`,
      action: { type: "press" as const, key: "Enter" as const, timeoutMs: 10_000 },
      expectedEffect: { type: "none" as const },
      mode: "rehearse" as const,
      protectedInputReferences: [],
    };
  }

  function credentialRevocationIntent(
    operationId: string,
    credentialReferenceIds: string[],
    authorizationId: string,
  ) {
    return {
      intentId: operationId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "activate" as const,
        target: {
          concept: "revoke credential",
          role: "button" as const,
          name: "Revoke",
          exact: true,
        },
      },
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "live_mutation" as const, authorizationId },
      protectedInputReferences: [],
      credentialLifecycle: { effect: "revoke" as const, credentialReferenceIds },
    };
  }

  function protectedFillIntent(intentId: string, credentialReferenceId: string) {
    return {
      intentId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "fill" as const,
        target: {
          concept: "protected credential",
          role: "textbox" as const,
          name: "Client ID",
          exact: true,
        },
        protectedReferenceId: credentialReferenceId,
      },
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "authentication" as const },
      protectedInputReferences: [credentialReferenceId],
    };
  }

  function credentialRevocationAction(): AdaptiveSessionOperationInput["action"] {
    return {
      type: "click" as const,
      target: {
        concept: "revoke credential",
        requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: {
          roles: ["button"],
          names: ["Revoke"],
          labels: [],
          descriptions: [],
          placeholders: [],
          inputTypes: [],
          testIds: [],
        },
        scope: { kind: "page" as const },
        relations: [],
        prohibited: ["hidden", "disabled"],
        risk: "ordinary" as const,
        confidence: { requiredFamilies: [] },
        matching: "exact" as const,
      },
      expectedEffect: { type: "none" as const },
      timeoutMs: 1_000,
    };
  }

  function successfulMutationOutcome(operationId: string) {
    return {
      operationId,
      functionalResult: "succeeded" as const,
      mutationOutcome: "applied" as const,
      privacyResult: "verified" as const,
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 1,
    };
  }

  async function credentialStatuses(ids: string[]) {
    const result = await database.query<{ id: string; status: string }>(
      `SELECT id::text,status FROM (
         SELECT id,security_status AS status FROM project_credentials WHERE id=ANY($1::uuid[])
       ) credentials ORDER BY array_position($1::uuid[],id)`,
      [ids],
    );
    return result.rows;
  }

  async function controlPlaneCounts() {
    const result = await database.query<{
      missions: string;
      objectives: string;
      flows: string;
      probes: string;
      environments: number;
      drafts: number;
      sessions: number;
    }>(
      `SELECT (SELECT count(*) FROM missions WHERE project_id=$1)::text AS missions,
              (SELECT count(*) FROM mission_objectives WHERE mission_id=$2)::text AS objectives,
              (SELECT count(*) FROM flows WHERE project_id=$1)::text AS flows,
              (SELECT count(*) FROM probe_sessions p JOIN flow_drafts d ON d.id=p.draft_id
                WHERE d.project_id=$1)::text AS probes,
              (SELECT count(*)::int FROM environments WHERE project_id=$1) AS environments,
              (SELECT count(*)::int FROM flow_drafts WHERE project_id=$1) AS drafts,
              (SELECT count(*)::int FROM adaptive_sessions WHERE project_id=$1) AS sessions`,
      [projectId, missionId],
    );
    return result.rows[0]!;
  }
  it("keeps a published draft immutable across ordinary settlement and proven-applied reconciliation", async () => {
    const immutableMissionId = randomUUID();
    const immutableObjectiveId = randomUUID();
    const immutableAgentSessionId = randomUUID();
    const immutableDraftId = randomUUID();

    await database.query(
      `INSERT INTO missions(
         id,project_id,title,original_instruction
       ) VALUES($1,$2,'Published immutability','Behavioral isolation')`,
      [immutableMissionId, projectId],
    );

    await database.query(
      `INSERT INTO mission_objectives(
         id,mission_id,title,completion_criteria,objective_order
       ) VALUES($1,$2,'Published immutability','{}'::jsonb,0)`,
      [immutableObjectiveId, immutableMissionId],
    );

    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,provider,instruction_snapshot,idempotency_key
       ) VALUES($1,$2,'scry_agent','Published immutability',$3)`,
      [
        immutableAgentSessionId,
        immutableMissionId,
        `published-immutability-agent-${immutableAgentSessionId}`,
      ],
    );

    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7::jsonb,$8)`,
      [
        immutableDraftId,
        projectId,
        immutableMissionId,
        immutableObjectiveId,
        environmentId,
        `Published immutable ${immutableDraftId}`,
        JSON.stringify({ steps: [] }),
        immutableAgentSessionId,
      ],
    );

    const created = await createActive({
      ...startInput(`published-immutability-${randomUUID()}`),
      missionId: immutableMissionId,
      objectiveId: immutableObjectiveId,
      agentSessionId: immutableAgentSessionId,
      flowDraftId: immutableDraftId,
    });
    sessionIds.push(created.id);

    await database.query(
      `UPDATE flow_drafts
          SET state='published'
        WHERE id=$1`,
      [immutableDraftId],
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
        [immutableDraftId],
      );

      expect(result.rowCount).toBe(1);
      return result.rows[0]!;
    };

    const appendedEventCount = async (operationId: string) => {
      const result = await database.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM flow_draft_events
          WHERE draft_id=$1
            AND type='authoring_step_appended'
            AND safe_metadata->>'operationId'=$2`,
        [immutableDraftId, operationId],
      );

      return result.rows[0]!.count;
    };

    const publishedBaseline = await readDraft();

    expect(publishedBaseline.state).toBe("published");

    const ordinaryId = `published-ordinary-${randomUUID()}`;
    const ordinaryIntent = {
      ...missionIntent(ordinaryId),
      objectiveId: immutableObjectiveId,
      flowDraftId: immutableDraftId,
    };
    const ordinaryOperation = operation(ordinaryId);

    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId: ordinaryId,
      idempotencyKey: `idempotency-${ordinaryId}`,
      intent: ordinaryIntent,
      action: ordinaryOperation.action,
      expectedEffect: ordinaryOperation.expectedEffect,
      mode: ordinaryOperation.mode,
    });

    const ordinarySettled = await repository.settleMissionOperation({
      sessionId: created.id,
      operationId: ordinaryId,
      intent: ordinaryIntent,
      action: ordinaryOperation.action,
      outcome: {
        operationId: ordinaryId,
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
      capabilityManifestDigest: "a".repeat(64),
      decisionBoundary: {
        type: "objective_completed",
        reasonCode: "OPERATION_COMPLETED",
        safeActions: [],
      },
    });

    expect(ordinarySettled.state).toBe("completed");

    const ordinaryDurable = await database.query<{
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
      [created.id, ordinaryId],
    );

    expect(ordinaryDurable.rows[0]).toEqual({
      state: "completed",
      functionalResult: "succeeded",
      mutationOutcome: "not_applied",
    });

    expect(await readDraft()).toEqual(publishedBaseline);
    expect(await appendedEventCount(ordinaryId)).toBe(0);

    const unknownId = `published-unknown-${randomUUID()}`;
    const unknownIntent = {
      ...missionIntent(unknownId),
      objectiveId: immutableObjectiveId,
      flowDraftId: immutableDraftId,
    };
    const unknownOperation = operation(unknownId);

    await repository.beginMissionOperation({
      workspaceId,
      sessionId: created.id,
      operationId: unknownId,
      idempotencyKey: `idempotency-${unknownId}`,
      intent: unknownIntent,
      action: unknownOperation.action,
      expectedEffect: unknownOperation.expectedEffect,
      mode: unknownOperation.mode,
    });

    await database.query(
      `UPDATE adaptive_operations
          SET dispatch_boundary='dispatching'
        WHERE session_id=$1
          AND operation_id=$2`,
      [created.id, unknownId],
    );

    const unknownBoundary = {
      type: "mutation_reconciliation_required" as const,
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_flow_authoring", "reconcile_unknown_operation"],
    };

    const unknownSettled = await repository.settleMissionOperation({
      sessionId: created.id,
      operationId: unknownId,
      intent: unknownIntent,
      action: unknownOperation.action,
      outcome: {
        operationId: unknownId,
        functionalResult: "succeeded",
        mutationOutcome: "unknown",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
      },
      capabilityManifestDigest: "b".repeat(64),
      decisionBoundary: unknownBoundary,
    });

    expect(unknownSettled.state).toBe("failed");

    await repository.recordDispatchBaseline({
      sessionId: created.id,
      operationId: unknownId,
      expectedEffect: unknownOperation.expectedEffect,
      documentEpoch: 1,
      url: "https://example.test/before",
      effectState: { state: "unsupported" },
    });

    const reconciliation = await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: created.id,
      missionId: immutableMissionId,
      operationId: unknownId,
      idempotencyKey: `reconcile-${unknownId}`,
    });

    expect(reconciliation).toMatchObject({
      state: "observing",
      replayed: false,
    });

    await expect(
      repository.completeUnknownReconciliation({
        sessionId: created.id,
        missionId: immutableMissionId,
        operationId: unknownId,
        idempotencyKey: `reconcile-${unknownId}`,
        result: "proven_applied",
        reasonCode: "TEST_AUTHORITATIVE_APPLIED",
        evidence: { fixture: true },
        runtimeOwned: false,
      }),
    ).resolves.toBeDefined();

    const reconciliationTruth = await database.query<{
      state: string;
      result: string;
    }>(
      `SELECT state,result
         FROM adaptive_operation_reconciliations
        WHERE session_id=$1
          AND operation_id=$2
        ORDER BY attempt DESC
        LIMIT 1`,
      [created.id, unknownId],
    );

    expect(reconciliationTruth.rows[0]).toEqual({
      state: "completed",
      result: "proven_applied",
    });

    expect(await readDraft()).toEqual(publishedBaseline);
    expect(await appendedEventCount(unknownId)).toBe(0);
  });
});
