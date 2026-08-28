import { describe, expect, it, vi } from "vitest";

import { AgentDirectedRunService } from "../src/runs/services/agent-directed-run.service.js";

const runId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const claimToken = "44444444-4444-4444-8444-444444444444";
const protectedOperationId = "88888888-8888-4888-8888-888888888888";

const checkpoint = {
  schemaVersion: 1 as const,
  policyDigest: "a".repeat(64),
  storageState: { cookies: [], origins: [] },
  sessionStorage: {
    origin: "https://example.test",
    entries: [] as Array<[string, string]>,
  },
  restorationUrl: "https://example.test/final",
  safeSemanticContext: {
    title: "Final state",
    controls: [{ role: "heading", name: "Done" }],
  },
};

function harness(
  evidenceComplete: boolean,
  options: {
    praxisState?: string;
    praxisDecisionBoundary?: { type: string; reasonCode: string; safeActions: string[] } | null;
    terminalProtectedBoundary?: boolean;
    operationEvidence?: {
      state: "available" | "suppressed" | "quarantined" | "failed";
      reasonCodes: string[];
    };
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM runs r") && sql.includes("run_praxis_sessions")) {
      return {
        rowCount: 1,
        rows: [
          {
            objectiveId: "55555555-5555-4555-8555-555555555555",
            flowDraftId: "66666666-6666-4666-8666-666666666666",
            attemptId,
            claimToken,
            veilPolicySnapshot: {},
            praxisState: options.praxisState ?? "active",
            praxisDecisionBoundary: options.praxisDecisionBoundary ?? null,
          },
        ],
      };
    }

    if (sql.includes("JOIN protected_operations protected")) {
      const boundary = options.praxisDecisionBoundary;
      const boundaryPredicate =
        sql.includes("session.decision_boundary->>'type'='objective_completed'") &&
        sql.includes("session.decision_boundary->>'reasonCode'='PROTECTED_OPERATION_COMPLETED'");
      if (!sql.includes("last_link ON true"))
        return options.terminalProtectedBoundary
          ? { rowCount: 1, rows: [{}] }
          : { rowCount: 0, rows: [] };
      return options.terminalProtectedBoundary &&
        boundaryPredicate &&
        boundary?.type === "objective_completed" &&
        boundary.reasonCode === "PROTECTED_OPERATION_COMPLETED"
        ? { rowCount: 1, rows: [{ protectedOperationId }] }
        : { rowCount: 0, rows: [] };
    }

    if (sql.includes('AS "operationCount"')) {
      return {
        rowCount: 1,
        rows: [
          {
            operationCount: 2,
            evidencedOperationCount: evidenceComplete ? 2 : 1,
            unacceptableOperationEvidenceCount:
              options.operationEvidence?.state === "failed" ||
              options.operationEvidence?.state === "quarantined"
                ? 1
                : 0,
            unsafeArtifactCount: 0,
            unsafeTimelineCount: 0,
            openPrivacyIntervalCount: 0,
          },
        ],
      };
    }

    return { rowCount: 1, rows: [{}] };
  });

  const database = {
    query,
    transaction: vi.fn(),
  };

  const sessions = {
    captureRunSuccessorCheckpoint: vi.fn(async () => checkpoint),
  };

  const executions = {
    stageSuccessorCheckpoint: vi.fn(async () => ({
      checkpointId: "77777777-7777-4777-8777-777777777777",
    })),
    completeAttempt: vi.fn(async () => undefined),
  };

  const service = new AgentDirectedRunService(
    database as never,
    {
      requireWriteAccess: vi.fn(),
      getRun: vi.fn(async () => ({ id: runId })),
    } as never,
    sessions as never,
    executions as never,
    { getMutationReceiptByAuthoringOperation: vi.fn(async () => undefined) } as never,
    {
      assertAcceptingWork: vi.fn(),
    } as never,
  );

  return {
    service,
    database,
    sessions,
    executions,
  };
}

describe("agent-directed Run evidence finalization", () => {
  it("refuses a passed Run before checkpoint capture when canonical evidence is incomplete", async () => {
    const { service, database, sessions, executions } = harness(false);

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "finished",
        idempotencyKey: "finalize-evidence-missing",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "RUN_EVIDENCE_INCOMPLETE",
        mutationOutcome: "not_applied",
      },
    });

    expect(sessions.captureRunSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.completeAttempt).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("captures and stages the final live Praxis state before common passed completion", async () => {
    const { service, database, sessions, executions } = harness(true, {
      operationEvidence: { state: "available", reasonCodes: [] },
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "finished",
        idempotencyKey: "finalize-evidence-complete",
      }),
    ).resolves.toMatchObject({
      runId,
      state: "passed",
      outcomeClassification: "passed",
    });

    expect(sessions.captureRunSuccessorCheckpoint).toHaveBeenCalledWith(
      { kind: "service", subject: "scry-service" },
      sessionId,
    );

    expect(executions.stageSuccessorCheckpoint).toHaveBeenCalledWith(runId, checkpoint);

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      runId,
      attemptId,
      claimToken,
      "passed",
      "passed",
      { kind: "required" },
      undefined,
    );

    const stageOrder = executions.stageSuccessorCheckpoint.mock.invocationCallOrder[0];

    const completeOrder = executions.completeAttempt.mock.invocationCallOrder[0];

    expect(stageOrder).toBeDefined();
    expect(completeOrder).toBeDefined();

    expect(stageOrder!).toBeLessThan(completeOrder!);

    // Finalization no longer owns a second direct Attempt/Run SQL writer.
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("allows passed finalization when optional operation evidence is explicitly suppressed", async () => {
    const { service, executions } = harness(true, {
      operationEvidence: { state: "suppressed", reasonCodes: ["EVIDENCE_NOT_APPLICABLE"] },
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "required evidence complete and optional evidence suppressed",
        idempotencyKey: "finalize-optional-evidence-suppressed",
      }),
    ).resolves.toMatchObject({ runId, state: "passed", outcomeClassification: "passed" });

    expect(executions.completeAttempt).toHaveBeenCalledOnce();
  });

  it("refuses passed finalization when observation-persistence evidence failed after execution", async () => {
    const { service, database, sessions, executions } = harness(true, {
      operationEvidence: {
        state: "failed",
        reasonCodes: ["ADAPTIVE_VERIFIED_OBSERVATION_PERSISTENCE_FAILED"],
      },
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "browser action succeeded but required observation evidence failed",
        idempotencyKey: "finalize-observation-persistence-failed",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "RUN_EVIDENCE_INCOMPLETE",
        mutationOutcome: "not_applied",
        operationCount: 2,
        evidencedOperationCount: 2,
        unacceptableOperationEvidenceCount: 1,
      },
    });

    const evidenceQuery = database.query.mock.calls.find(([sql]) =>
      sql.includes('AS "unacceptableOperationEvidenceCount"'),
    )?.[0];
    expect(evidenceQuery).toContain("link.safe_result->'evidence'->>'state'");
    expect(evidenceQuery).toContain("'available'");
    expect(evidenceQuery).toContain("'suppressed'");
    expect(sessions.captureRunSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.completeAttempt).not.toHaveBeenCalled();
  });

  it("refuses passed finalization when linked operation evidence is quarantined", async () => {
    const { service, sessions, executions } = harness(true, {
      operationEvidence: { state: "quarantined", reasonCodes: ["EVIDENCE_QUARANTINED"] },
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "required evidence quarantined",
        idempotencyKey: "finalize-operation-evidence-quarantined",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "RUN_EVIDENCE_INCOMPLETE",
        mutationOutcome: "not_applied",
        evidencedOperationCount: 2,
        unacceptableOperationEvidenceCount: 1,
      },
    });

    expect(sessions.captureRunSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.completeAttempt).not.toHaveBeenCalled();
  });

  it("finalizes after a completed protected transaction retires browser authority", async () => {
    const { service, database, sessions, executions } = harness(true, {
      praxisState: "cancelled",
      praxisDecisionBoundary: {
        type: "objective_completed",
        reasonCode: "PROTECTED_OPERATION_COMPLETED",
        safeActions: [],
      },
      terminalProtectedBoundary: true,
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "protected output persisted",
        idempotencyKey: "finalize-terminal-protected-boundary",
      }),
    ).resolves.toMatchObject({
      runId,
      state: "passed",
      outcomeClassification: "passed",
    });

    expect(sessions.captureRunSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.completeAttempt).toHaveBeenCalledWith(
      runId,
      attemptId,
      claimToken,
      "passed",
      "passed",
      {
        kind: "forbidden",
        reason: "terminal_protected_operation",
        praxisSessionId: sessionId,
        protectedOperationId,
      },
      undefined,
    );
    const terminalQuery = database.query.mock.calls.find(([sql]) =>
      sql.includes("JOIN protected_operations protected"),
    )?.[0];
    expect(terminalQuery).toContain("session.decision_boundary->>'type'='objective_completed'");
    expect(terminalQuery).toContain(
      "session.decision_boundary->>'reasonCode'='PROTECTED_OPERATION_COMPLETED'",
    );
    expect(terminalQuery).not.toContain(
      "session.decision_boundary='PROTECTED_OPERATION_COMPLETED'",
    );
  });

  it.each([
    {
      type: "objective_completed",
      reasonCode: "SOME_OTHER_COMPLETION",
      safeActions: [],
    },
    {
      type: "authorization_required",
      reasonCode: "PROTECTED_OPERATION_COMPLETED",
      safeActions: [],
    },
  ])("refuses a terminal protected completion boundary that is not exact: %o", async (boundary) => {
    const { service, executions } = harness(true, {
      praxisState: "cancelled",
      praxisDecisionBoundary: boundary,
      terminalProtectedBoundary: true,
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "unproven terminal boundary",
        idempotencyKey: `finalize-unproven-${boundary.type}-${boundary.reasonCode}`,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "RUN_TERMINAL_PRAXIS_BOUNDARY_UNPROVEN",
        mutationOutcome: "not_applied",
      },
    });
    expect(executions.completeAttempt).not.toHaveBeenCalled();
  });

  it("refuses a dead Praxis session without an exact completed protected boundary", async () => {
    const { service, sessions, executions } = harness(true, {
      praxisState: "cancelled",
      praxisDecisionBoundary: {
        type: "objective_completed",
        reasonCode: "PROTECTED_OPERATION_COMPLETED",
        safeActions: [],
      },
      terminalProtectedBoundary: false,
    });

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "unproven terminal boundary",
        idempotencyKey: "finalize-unproven-terminal-boundary",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "RUN_TERMINAL_PRAXIS_BOUNDARY_UNPROVEN",
        mutationOutcome: "not_applied",
      },
    });

    expect(sessions.captureRunSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.completeAttempt).not.toHaveBeenCalled();
  });

  it("fails closed when final Praxis checkpoint capture cannot be established", async () => {
    const { service, sessions, executions } = harness(true);

    sessions.captureRunSuccessorCheckpoint.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "finished",
        idempotencyKey: "finalize-checkpoint-failed",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "SUCCESSOR_CHECKPOINT_ESTABLISHMENT_FAILED",
        reasonCode: "SUCCESSOR_CHECKPOINT_CAPTURE_FAILED",
        mutationOutcome: "not_applied",
      },
    });

    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.completeAttempt).not.toHaveBeenCalled();
  });

  it("preserves a safe exact successor-checkpoint failure code", async () => {
    const { service, sessions } = harness(true);

    sessions.captureRunSuccessorCheckpoint.mockRejectedValueOnce(
      new Error("SUCCESSOR_CHECKPOINT_SESSION_STORAGE_TOO_LARGE"),
    );

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "passed",
        reason: "finished",
        idempotencyKey: "finalize-checkpoint-safe-code",
      }),
    ).rejects.toMatchObject({
      response: {
        code: "SUCCESSOR_CHECKPOINT_ESTABLISHMENT_FAILED",
        reasonCode: "SUCCESSOR_CHECKPOINT_SESSION_STORAGE_TOO_LARGE",
        mutationOutcome: "not_applied",
      },
    });
  });

  it("does not manufacture a checkpoint for an explicitly failed Run", async () => {
    const { service, sessions, executions } = harness(true);

    await expect(
      service.finalize({ kind: "service", subject: "scry-service" }, runId, {
        praxisSessionId: sessionId,
        outcome: "failed",
        reason: "application assertion failed",
        idempotencyKey: "finalize-explicit-failure",
      }),
    ).resolves.toMatchObject({
      runId,
      state: "failed",
      outcomeClassification: "inconclusive_plan",
    });

    expect(sessions.captureRunSuccessorCheckpoint).not.toHaveBeenCalled();
    expect(executions.stageSuccessorCheckpoint).not.toHaveBeenCalled();

    expect(executions.completeAttempt).toHaveBeenCalledWith(
      runId,
      attemptId,
      claimToken,
      "failed",
      "inconclusive_plan",
      {
        kind: "forbidden",
        reason: "run_not_successful",
      },
      "application assertion failed",
    );
  });
});
