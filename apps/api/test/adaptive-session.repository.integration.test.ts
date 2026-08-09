import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";

const configuredDatabaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = configuredDatabaseUrl ? describe : describe.skip;

integration("adaptive session repository integration", () => {
  let database: Database;
  let repository: AdaptiveSessionRepository;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
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
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it("creates no mission, objective, flow, or probe records", async () => {
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

  async function controlPlaneCounts() {
    const result = await database.query<{
      missions: string;
      objectives: string;
      flows: string;
      probes: string;
    }>(
      `SELECT (SELECT count(*) FROM missions)::text AS missions,
              (SELECT count(*) FROM mission_objectives)::text AS objectives,
              (SELECT count(*) FROM flows)::text AS flows,
              (SELECT count(*) FROM probe_sessions)::text AS probes`,
    );
    return result.rows[0];
  }
});
