import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionService } from "../src/adaptive-sessions/adaptive-session.service.js";

const principal = {
  kind: "user" as const,
  subject: "user:test",
  userId: randomUUID(),
  email: "test@example.test",
  workspaceId: randomUUID(),
  role: "owner" as const,
};

describe("AdaptiveSessionService", () => {
  it("settles a durable operation with the kernel runner result", async () => {
    const outcome = {
      operationId: "inspect",
      functionalResult: "succeeded" as const,
      mutationOutcome: "not_applied" as const,
      privacyResult: "verified" as const,
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 5,
    };
    const repository = {
      beginOperation: vi.fn().mockResolvedValue({ replayed: false }),
      settleOperation: vi.fn().mockResolvedValue({ state: "completed" }),
      markOperationFailed: vi.fn(),
    };
    const runner = {
      execute: vi.fn().mockResolvedValue({
        outcome,
        capabilityManifestDigest: "b".repeat(64),
        decisionBoundary: {
          type: "objective_completed",
          reasonCode: "OBJECTIVE_COMPLETED",
          safeActions: [],
        },
      }),
    };
    const service = new AdaptiveSessionService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), operation())).resolves.toMatchObject({
      state: "completed",
    });
    expect(runner.execute).toHaveBeenCalledOnce();
    expect(repository.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome, capabilityManifestDigest: "b".repeat(64) }),
    );
  });

  it("moves a failed runtime operation to recovery through the repository", async () => {
    const repository = {
      beginOperation: vi.fn().mockResolvedValue({ replayed: false }),
      settleOperation: vi.fn(),
      markOperationFailed: vi.fn(),
    };
    const runner = {
      execute: vi
        .fn()
        .mockRejectedValue(new ConflictException({ code: "ADAPTIVE_SESSION_RUNTIME_NOT_BOUND" })),
      close: vi.fn(),
    };
    const service = new AdaptiveSessionService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), operation())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.markOperationFailed).toHaveBeenCalledWith(
      expect.any(String),
      "inspect",
      "ADAPTIVE_SESSION_RUNTIME_NOT_BOUND",
    );
  });

  it("does not redispatch an operation left running by a crashed owner", async () => {
    const repository = {
      beginOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running" }),
      replayDisposition: vi.fn().mockResolvedValue({ requiresReconciliation: true }),
      markRunningOperationRecoveryRequired: vi.fn(),
    };
    const runner = { execute: vi.fn() };
    const service = new AdaptiveSessionService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), operation())).rejects.toMatchObject({
      response: { code: "ADAPTIVE_OPERATION_RECONCILIATION_REQUIRED" },
    });
    expect(repository.markRunningOperationRecoveryRequired).toHaveBeenCalledOnce();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("returns one stable pending identity for a concurrent same-key request", async () => {
    const repository = {
      beginOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running" }),
      replayDisposition: vi.fn().mockResolvedValue({
        requiresReconciliation: false,
        canResume: false,
        dispatchBoundary: "dispatching",
      }),
      markRunningOperationRecoveryRequired: vi.fn(),
    };
    const runner = { execute: vi.fn() };
    const service = new AdaptiveSessionService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    await expect(service.advance(principal, randomUUID(), operation())).resolves.toEqual({
      operationId: "inspect",
      state: "running",
      dispatchBoundary: "dispatching",
      replayed: true,
    });
    expect(repository.markRunningOperationRecoveryRequired).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("safely resumes an undispatched operation after its owner lease expires", async () => {
    const outcome = {
      operationId: "inspect",
      functionalResult: "succeeded" as const,
      mutationOutcome: "not_applied" as const,
      privacyResult: "verified" as const,
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 5,
    };
    const repository = {
      beginOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running" }),
      replayDisposition: vi.fn().mockResolvedValue({
        requiresReconciliation: false,
        canResume: true,
        dispatchBoundary: "not_dispatched",
      }),
      settleOperation: vi.fn().mockResolvedValue({ state: "completed", outcome }),
      markOperationFailed: vi.fn(),
    };
    const runner = {
      execute: vi.fn().mockResolvedValue({
        outcome,
        capabilityManifestDigest: "a".repeat(64),
        decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] },
      }),
      close: vi.fn(),
    };
    const service = new AdaptiveSessionService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );

    await expect(service.advance(principal, randomUUID(), operation())).resolves.toMatchObject({
      operationId: "inspect",
      replayed: true,
      state: "completed",
    });
    expect(runner.execute).toHaveBeenCalledOnce();
  });

  it("executes a bounded deterministic operation group without client polling", async () => {
    const outcome = {
      operationId: "placeholder",
      functionalResult: "succeeded" as const,
      mutationOutcome: "not_applied" as const,
      privacyResult: "verified" as const,
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 5,
    };
    const repository = {
      beginOperation: vi.fn().mockResolvedValue({ replayed: false }),
      settleOperation: vi.fn(async ({ operationId }) => ({
        state: "completed",
        outcome: { ...outcome, operationId },
        decisionBoundary: {
          type: "objective_completed",
          reasonCode: "OPERATION_COMPLETED",
          safeActions: [],
        },
      })),
      markOperationFailed: vi.fn(),
    };
    const runner = {
      execute: vi.fn(async (_sessionId, item) => ({
        outcome: { ...outcome, operationId: item.operationId },
        capabilityManifestDigest: "b".repeat(64),
        decisionBoundary: {
          type: "objective_completed",
          reasonCode: "OPERATION_COMPLETED",
          safeActions: [],
        },
      })),
    };
    const admission = { assertAcceptingWork: vi.fn() };
    const service = new AdaptiveSessionService(
      repository as never,
      runner as never,
      admission as never,
    );
    const operations = ["one", "two", "three"].map((id) => ({
      ...operation(),
      operationId: id,
      idempotencyKey: `adaptive-operation-${id}`,
    }));
    await expect(
      service.advance(principal, randomUUID(), {
        idempotencyKey: "adaptive-group-1",
        operations,
        budgets: { maxOperations: 3, maxDurationMs: 30_000 },
      }),
    ).resolves.toMatchObject({
      operationsCompleted: [{ state: "completed" }, { state: "completed" }, { state: "completed" }],
      decisionBoundary: { type: "objective_completed", reasonCode: "ADAPTIVE_TURN_COMPLETED" },
    });
    expect(runner.execute).toHaveBeenCalledTimes(3);
    expect(admission.assertAcceptingWork).toHaveBeenCalledOnce();
  });
});

function operation() {
  return {
    operationId: "inspect",
    idempotencyKey: "adaptive-inspect-1",
    action: { type: "navigate" as const, url: "https://example.test", timeoutMs: 10_000 },
    expectedEffect: {
      type: "navigation" as const,
      url: "https://example.test",
      match: "exact" as const,
    },
    mode: "rehearse" as const,
    protectedInputReferences: [],
  };
}
