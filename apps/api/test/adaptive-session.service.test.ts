import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";

const principal = {
  kind: "user" as const,
  subject: "user:test",
  userId: randomUUID(),
  email: "test@example.test",
  workspaceId: randomUUID(),
  role: "owner" as const,
};
const objectiveId = randomUUID();
const flowDraftId = randomUUID();

const outcome = (operationId = "operation") => ({
  operationId,
  functionalResult: "succeeded" as const,
  mutationOutcome: "not_applied" as const,
  privacyResult: "unverified" as const,
  evidenceResult: [],
  qualityFindings: [],
  durationMs: 5,
});

function request(count = 1) {
  return {
    kind: "intents" as const,
    idempotencyKey: `semantic-turn-${count}`,
    budgets: { maxOperations: count, maxDurationMs: 30_000 },
    intents: Array.from({ length: count }, (_, index) => ({
      intentId: `inspect-${index}`,
      objectiveId,
      flowDraftId,
      action: {
        kind: "inspect" as const,
        target: {
          concept: `region ${index}`,
          role: "region" as const,
          name: `Region ${index}`,
          exact: true,
        },
      },
      authorization: { kind: "ordinary" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      expectedEffect: { kind: "none" as const },
      protectedInputReferences: [],
    })),
  };
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    beginTurn: vi.fn().mockResolvedValue({ turnId: randomUUID(), replayed: false, response: null }),
    validateIntentAdmission: vi.fn(),
    handoff: vi.fn().mockResolvedValue({ handedOff: false }),
    beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
    settleMissionOperation: vi.fn(async ({ operationId, outcome: result }) => ({
      state: "completed",
      outcome: result ?? outcome(operationId),
      decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] },
    })),
    settleTurn: vi.fn(async ({ result }) => result),
    persistPending: vi.fn(async ({ result }) => result),
    markOperationFailed: vi.fn(),
    replayDisposition: vi.fn(),
    markRunningOperationRecoveryRequired: vi.fn(),
    ...overrides,
  };
}

function runner(overrides: Record<string, unknown> = {}) {
  return {
    execute: vi.fn(async (_sessionId, operation) => ({
      outcome: outcome(operation.operationId),
      capabilityManifestDigest: "a".repeat(64),
      decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] },
      timings: { resolveMs: 1, executeMs: 1, verifyMs: 1 },
      safeState: { url: "https://example.test", documentEpoch: 1 },
    })),
    cancelActiveOperation: vi.fn(),
    ...overrides,
  };
}

describe("MissionFlowAuthoringService current semantic contract", () => {
  it("settles a durable semantic operation with the kernel result", async () => {
    const repo = repository();
    const runtime = runner();
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), request())).resolves.toMatchObject({
      state: "completed",
      completed: [{ intentId: "inspect-0" }],
    });
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(repo.settleMissionOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({ functionalResult: "succeeded" }),
        capabilityManifestDigest: "a".repeat(64),
      }),
    );
  });

  it("moves a failed runtime operation through durable failure settlement", async () => {
    const error = Object.assign(new Error("ADAPTIVE_SESSION_RUNTIME_NOT_BOUND"), {
      code: "ADAPTIVE_SESSION_RUNTIME_NOT_BOUND",
    });
    const repo = repository();
    const runtime = runner({ execute: vi.fn().mockRejectedValue(error) });
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), request())).resolves.toMatchObject({
      state: "decision_required",
      decisionBoundary: {
        reasonCode: "ADAPTIVE_SESSION_RUNTIME_NOT_BOUND",
      },
    });
    expect(repo.markOperationFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "ADAPTIVE_SESSION_RUNTIME_NOT_BOUND",
      expect.any(String),
    );
  });

  it("preserves a kernel policy-admission code", async () => {
    const error = Object.assign(new Error("EXECUTION_MODE_POLICY_DENIED"), {
      code: "EXECUTION_MODE_POLICY_DENIED",
    });
    const repo = repository();
    const runtime = runner({ execute: vi.fn().mockRejectedValue(error) });
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), request())).resolves.toMatchObject({
      state: "decision_required",
      decisionBoundary: { type: "policy_refused", reasonCode: "EXECUTION_MODE_POLICY_DENIED" },
    });
    expect(repo.markOperationFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EXECUTION_MODE_POLICY_DENIED",
      expect.any(String),
    );
  });

  it("returns authoritative UNKNOWN reconciliation after a post-dispatch failure", async () => {
    const error = Object.assign(new Error("AUTHORING_TURN_BUDGET_EXHAUSTED"), {
      code: "AUTHORING_TURN_BUDGET_EXHAUSTED",
    });
    const reconciliation = {
      type: "mutation_reconciliation_required" as const,
      reasonCode: "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN",
      safeActions: ["get_flow_authoring"],
    };
    const repo = repository({
      markOperationFailed: vi.fn().mockResolvedValue({
        outcome: { ...outcome(), functionalResult: "failed", mutationOutcome: "unknown" },
        decisionBoundary: reconciliation,
      }),
    });
    const runtime = runner({ execute: vi.fn().mockRejectedValue(error) });
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), request())).resolves.toMatchObject({
      state: "decision_required",
      decisionBoundary: reconciliation,
    });
  });

  it("does not redispatch a replayed running operation requiring reconciliation", async () => {
    const repo = repository({
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running" }),
      replayDisposition: vi.fn().mockResolvedValue({
        requiresReconciliation: true,
        canResume: false,
        dispatchBoundary: "dispatched",
      }),
    });
    const runtime = runner();
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), request())).resolves.toMatchObject({
      state: "decision_required",
      decisionBoundary: {
        reasonCode: "ADAPTIVE_OPERATION_RECONCILIATION_REQUIRED",
      },
    });
    expect(repo.markRunningOperationRecoveryRequired).toHaveBeenCalledOnce();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("returns one stable pending turn for an active replayed operation", async () => {
    const repo = repository({
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running" }),
      replayDisposition: vi.fn().mockResolvedValue({
        requiresReconciliation: false,
        canResume: false,
        dispatchBoundary: "dispatching",
      }),
    });
    const runtime = runner();
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const result = await service.advance(principal, randomUUID(), request());
    expect(result).toMatchObject({
      state: "pending",
      continuation: { phase: "operation_running" },
    });
    expect(result.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repo.persistPending.mock.calls[0]![0].result.turnId).toBe(result.turnId);
    expect(repo.persistPending).toHaveBeenCalledOnce();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("resumes only a replayed operation proven undispatched", async () => {
    const repo = repository({
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running" }),
      replayDisposition: vi.fn().mockResolvedValue({
        requiresReconciliation: false,
        canResume: true,
        dispatchBoundary: "not_dispatched",
      }),
    });
    const runtime = runner();
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), request())).resolves.toMatchObject({
      state: "completed",
    });
    expect(runtime.execute).toHaveBeenCalledOnce();
  });

  it("executes a bounded deterministic semantic group without client polling", async () => {
    const repo = repository();
    const runtime = runner();
    const admission = { assertAcceptingWork: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repo as never,
      runtime as never,
      admission as never,
    );
    await expect(service.advance(principal, randomUUID(), request(3))).resolves.toMatchObject({
      state: "completed",
      completed: [{ intentId: "inspect-0" }, { intentId: "inspect-1" }, { intentId: "inspect-2" }],
    });
    expect(runtime.execute).toHaveBeenCalledTimes(3);
    expect(repo.settleMissionOperation).toHaveBeenCalledTimes(3);
    expect(admission.assertAcceptingWork).toHaveBeenCalledOnce();
  });
});
