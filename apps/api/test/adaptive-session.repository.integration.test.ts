import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdaptiveSessionOperationInput } from "@scry/contracts";

import {
  AdaptiveSessionRepository,
  requireEnvironmentCapabilities,
} from "../src/adaptive-sessions/adaptive-session.repository.js";
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
    expect(requireEnvironmentCapabilities(
      { policy, secretRefs: [] },
      {
        allowedOrigins: ["https://app.example.test", "https://api.example.test/docs"],
        initialProtectedReferenceIds: [],
      },
    )).toEqual(["https://app.example.test", "https://api.example.test"]);
  });

  it("rejects a missing document origin before runtime creation", () => {
    const error = capture(() => requireEnvironmentCapabilities(
      { policy: { ...policy, allowedOrigins: ["https://app.example.test"] }, secretRefs: [] },
      {
        allowedOrigins: ["https://app.example.test", "https://api.example.test"],
        initialProtectedReferenceIds: [],
      },
    ));
    expect(error).toMatchObject({
      response: expect.objectContaining({ code: "ENVIRONMENT_CAPABILITY_INCOMPLETE", mutationOutcome: "not_applied", retry: "safe_after_prerequisite" }),
    });
  });

  it("does not treat a trusted script origin as a navigable document origin", () => {
    const error = capture(() => requireEnvironmentCapabilities(
      { policy, secretRefs: [] },
      {
        allowedOrigins: ["https://scripts.example.test"],
        initialProtectedReferenceIds: [],
      },
    ));
    expect(error).toMatchObject({
      response: expect.objectContaining({ code: "ENVIRONMENT_CAPABILITY_INCOMPLETE", mutationOutcome: "not_applied", retry: "safe_after_prerequisite" }),
    });
  });

  it("rejects a protected reference outside the selected environment", () => {
    const error = capture(() => requireEnvironmentCapabilities(
      { policy, secretRefs: ["11111111-1111-4111-8111-111111111111"] },
      {
        allowedOrigins: ["https://app.example.test"],
        initialProtectedReferenceIds: ["22222222-2222-4222-8222-222222222222"],
      },
    ));
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
      [missionId,projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(
         id,mission_id,title,completion_criteria,objective_order
       ) VALUES($1,$2,'Inspect account details','{}'::jsonb,0)`,
      [objectiveId,missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,provider,instruction_snapshot,idempotency_key
       ) VALUES($1,$2,'scry_agent','Integration test','adaptive-owner-session')`,
      [agentSessionId,missionId],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'Inspect account details','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId,projectId,missionId,objectiveId,environmentId,agentSessionId],
    );
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it("creates no additional Mission, Objective, Flow draft, or probe records", async () => {
    const before = await controlPlaneCounts();
    const created = await repository.create(workspaceId, startInput("missionless-start"));
    sessionIds.push(created.id);
    const after = await controlPlaneCounts();
    expect(after).toEqual(before);
    const session = await repository.get(workspaceId, created.id);
    expect(session).toMatchObject({ state: "active", version: 3 });
    expect((session.events as Array<{ type: string }>).map((event) => event.type)).toEqual([
      "session_created",
      "provisioning_started",
      "session_activated",
    ]);
  });

  it("rejects a Flow draft outside the supplied Mission and Objective chain", async () => {
    await expect(
      repository.create(workspaceId, {
        ...startInput("invalid-owner-chain"),
        objectiveId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      response: { code: "MISSION_FLOW_AUTHORING_OWNERSHIP_INVALID" },
    });
  });

  it("loads an authorized protected execution context from PostgreSQL", async () => {
    const created = await repository.create(workspaceId, startInput("protected-context-start"));
    sessionIds.push(created.id);
    const authorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'protected_mutation','Integration qualification','approved',$5)`,
      [authorizationId, missionId, objectiveId, environmentId, agentSessionId],
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
        outputs: [{
          reference: "clientSecret",
          classification: "protected" as const,
          target: { concept: "client secret", role: "textbox" as const, name: "Client secret", exact: true },
          storageName: "Client secret",
        }],
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
      preparation: [{
        intentId: "visit-credentials",
        objectiveId,
        flowDraftId,
        action: { kind: "navigate", url: "https://example.test" },
        expectedEffect: { kind: "navigation", url: "https://example.test", match: "exact" },
        constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      }],
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
  });

  it("stores a functionally successful unknown mutation as reconciliation-required", async () => {
    const created = await repository.create(workspaceId, startInput("unknown-mutation-start"));
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
    const boundary = {
      type: "mutation_reconciliation_required" as const,
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_flow_authoring"],
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
            roles: ["button"], names: ["Submit"], labels: [], descriptions: [],
            placeholders: [], inputTypes: [], testIds: [],
          },
          scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
          risk: "ordinary", confidence: { requiredFamilies: [] }, matching: "exact",
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
        [credentialId, projectId, `Credential ${index}`, Buffer.from("ciphertext"),
          Buffer.alloc(12), Buffer.alloc(16), missionId, objectiveId, agentSessionId],
      );
    }
    await database.query(
      `UPDATE environments SET secret_refs=secret_refs || $2::jsonb WHERE id=$1`,
      [environmentId, JSON.stringify(credentialIds)],
    );
    const created = await repository.create(workspaceId, {
      ...startInput("credential-revocation-start"),
      initialProtectedReferenceIds: credentialIds,
    });
    sessionIds.push(created.id);
    const operationId = "credential-revocation";
    const intent = credentialRevocationIntent(operationId, credentialIds, authorizationId);
    const action = credentialRevocationAction();
    await expect(repository.validateIntentAdmission({ sessionId: created.id, intent })).resolves.toBeUndefined();
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
    await expect(repository.validateIntentAdmission({ sessionId: created.id, intent }))
      .rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });
    await expect(repository.resolveCredential(created.id, credentialIds[0]!))
      .rejects.toMatchObject({ response: { code: "ADAPTIVE_CREDENTIAL_UNAVAILABLE" } });
    await expect(repository.create(workspaceId, {
      ...startInput("revoked-credential-new-session"),
      initialProtectedReferenceIds: [credentialIds[0]!],
    })).rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });

    await expect(repository.projectCredentialLifecycleForAuthoring({ sessionId: created.id, operationId }))
      .resolves.toEqual({ projected: false, lifecycle: "revoke" });
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
        [credentialId, projectId, `Lifecycle ${securityStatus} ${credentialId}`,
          Buffer.from("ciphertext"), Buffer.alloc(12), Buffer.alloc(16),
          missionId, objectiveId, agentSessionId],
      );
      await database.query(
        `UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1`,
        [environmentId, credentialId],
      );
      const existing = await repository.create(workspaceId, {
        ...startInput(`lifecycle-${securityStatus}-existing`),
        initialProtectedReferenceIds: [credentialId],
      });
      sessionIds.push(existing.id);
      const intent = protectedFillIntent(`use-${securityStatus}`, credentialId);

      await expect(repository.validateIntentAdmission({ sessionId: existing.id, intent }))
        .resolves.toBeUndefined();
      await database.query(
        `UPDATE project_credentials SET security_status=$2,updated_at=now() WHERE id=$1`,
        [credentialId, securityStatus],
      );

      await expect(repository.validateIntentAdmission({ sessionId: existing.id, intent }))
        .rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });
      await expect(repository.create(workspaceId, {
        ...startInput(`lifecycle-${securityStatus}-new`),
        initialProtectedReferenceIds: [credentialId],
      })).rejects.toMatchObject({ response: { code: "PROTECTED_REFERENCE_INACTIVE" } });
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
      [credentialId, projectId, Buffer.from("ciphertext"), Buffer.alloc(12), Buffer.alloc(16),
        missionId, objectiveId, agentSessionId],
    );
    await database.query(`UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1`,
      [environmentId, credentialId]);
    const created = await repository.create(workspaceId, {
      ...startInput("credential-pair-atomicity-start"), initialProtectedReferenceIds: [credentialId],
    });
    sessionIds.push(created.id);
    const operationId = "credential-pair-atomicity";
    const intent = credentialRevocationIntent(
      operationId, [credentialId, missingCredentialId], authorizationId,
    );
    const action = credentialRevocationAction();
    await repository.beginMissionOperation({
      workspaceId, sessionId: created.id, operationId, idempotencyKey: `${operationId}-key`,
      intent, action, expectedEffect: { type: "none" }, mode: "transact",
    });
    await expect(repository.settleMissionOperation({
      sessionId: created.id, operationId, intent, action,
      outcome: successfulMutationOutcome(operationId),
      capabilityManifestDigest: "a".repeat(64),
      decisionBoundary: { type: "objective_completed", reasonCode: "OPERATION_COMPLETED", safeActions: [] },
    })).rejects.toMatchObject({
      response: { code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED" },
    });
    expect(await credentialStatuses([credentialId])).toEqual([{ id: credentialId, status: "active" }]);
    const operation = await database.query<{ state: string }>(
      `SELECT state FROM adaptive_operations WHERE session_id=$1 AND operation_id=$2`,
      [created.id, operationId],
    );
    expect(operation.rows[0]!.state).toBe("running");
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
        [credentialId, projectId, `Credential ${mutationOutcome}`, Buffer.from("ciphertext"),
          Buffer.alloc(12), Buffer.alloc(16), missionId, objectiveId, agentSessionId],
      );
      await database.query(`UPDATE environments SET secret_refs=secret_refs || to_jsonb($2::text) WHERE id=$1`,
        [environmentId, credentialId]);
      const operationId = `credential-revocation-${mutationOutcome}`;
      const created = await repository.create(workspaceId, {
        ...startInput(`${operationId}-start`), initialProtectedReferenceIds: [credentialId],
      });
      sessionIds.push(created.id);
      const intent = credentialRevocationIntent(operationId, [credentialId], authorizationId);
      const action = credentialRevocationAction();
      await repository.beginMissionOperation({
        workspaceId, sessionId: created.id, operationId, idempotencyKey: `${operationId}-key`,
        intent, action, expectedEffect: { type: "none" }, mode: "transact",
      });
      await repository.settleMissionOperation({
        sessionId: created.id, operationId, intent, action,
        outcome: {
          ...successfulMutationOutcome(operationId),
          functionalResult: "failed",
          mutationOutcome,
          reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED",
        },
        capabilityManifestDigest: "f".repeat(64),
        decisionBoundary: mutationOutcome === "unknown"
          ? { type: "mutation_reconciliation_required", reasonCode: "MUTATION_OUTCOME_UNKNOWN", safeActions: ["get_flow_authoring"] }
          : { type: "environment_unavailable", reasonCode: "EXPECTED_EFFECT_NOT_OBSERVED", safeActions: ["advance_session"] },
      });
      expect(await credentialStatuses([credentialId])).toEqual([{
        id: credentialId,
        status: mutationOutcome === "unknown" ? "compromised" : "active",
      }]);
    }
  });

  it("enforces ordered append-only journal and transition versions", async () => {
    const created = await repository.create(workspaceId, startInput("journal-start"));
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
    const created = await repository.create(workspaceId, startInput("transition-start"));
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
    const created = await repository.create(workspaceId, startInput("dispatch-truth-start"));
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
    const created = await repository.create(workspaceId, startInput("lease-restart-start"));
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
    expect(readOnlyFailure).toMatchObject({ state: "active" });
    expect(readOnlyFailure.operations[0]).toMatchObject({
      state: "failed",
      dispatchBoundary: "dispatching",
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "BROWSER_DISCONNECTED",
      },
      outcome: {
        functionalResult: "failed",
        mutationOutcome: "not_applied",
        reasonCode: "BROWSER_DISCONNECTED",
      },
    });

    await repository.beginOperation(workspaceId, created.id, mutatingOperation("mutation-0"));
    await repository.markOperationDispatching({
      sessionId: created.id,
      operationId: "mutation-0",
      ownerId: secondOwner,
      fencingToken: replacement.fencingToken,
    });
    await repository.markOperationFailed(created.id, "mutation-0", "BROWSER_DISCONNECTED");
    const recovered = await repository.get(workspaceId, created.id);
    expect(recovered).toMatchObject({ state: "recovery_required" });
    expect(recovered.operations[8]).toMatchObject({
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

  function credentialRevocationIntent(operationId: string, credentialReferenceIds: string[], authorizationId: string) {
    return {
      intentId: operationId,
      objectiveId,
      flowDraftId,
      action: {
        kind: "activate" as const,
        target: { concept: "revoke credential", role: "button" as const, name: "Revoke", exact: true },
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
        target: { concept: "protected credential", role: "textbox" as const, name: "Client ID", exact: true },
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
        concept: "revoke credential", requiredCapabilities: ["focusable", "pointer_activatable"],
        preferredEvidence: { roles: ["button"], names: ["Revoke"], labels: [], descriptions: [], placeholders: [], inputTypes: [], testIds: [] },
        scope: { kind: "page" as const }, relations: [], prohibited: ["hidden", "disabled"],
        risk: "ordinary" as const, confidence: { requiredFamilies: [] }, matching: "exact" as const,
      },
      expectedEffect: { type: "none" as const }, timeoutMs: 1_000,
    };
  }

  function successfulMutationOutcome(operationId: string) {
    return {
      operationId,
      functionalResult: "succeeded" as const,
      mutationOutcome: "applied" as const,
      privacyResult: "verified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1,
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
    }>(
      `SELECT (SELECT count(*) FROM missions WHERE project_id=$1)::text AS missions,
              (SELECT count(*) FROM mission_objectives WHERE mission_id=$2)::text AS objectives,
              (SELECT count(*) FROM flows WHERE project_id=$1)::text AS flows,
              (SELECT count(*) FROM probe_sessions p JOIN flow_drafts d ON d.id=p.draft_id
                WHERE d.project_id=$1)::text AS probes`,
      [projectId, missionId],
    );
    return result.rows[0];
  }
});
