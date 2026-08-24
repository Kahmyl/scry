import { describe, expect, it, vi } from "vitest";

import { AgentDirectedRunService } from "../src/runs/services/agent-directed-run.service.js";

const runId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const claimToken = "44444444-4444-4444-8444-444444444444";

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

function harness(evidenceComplete: boolean) {
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
          },
        ],
      };
    }

    if (sql.includes('AS "operationCount"')) {
      return {
        rowCount: 1,
        rows: [
          {
            operationCount: 2,
            evidencedOperationCount: evidenceComplete ? 2 : 1,
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
    const { service, database, sessions, executions } = harness(true);

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
