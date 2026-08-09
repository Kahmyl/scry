import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { MissionFlowAuthoringService } from "../src/adaptive-sessions/mission-flow-authoring.service.js";

const principal = { kind: "user" as const, subject: "user:test", userId: randomUUID(), email: "owner@example.test", workspaceId: randomUUID(), role: "owner" as const };
const ids = { objectiveId: randomUUID(), flowDraftId: randomUUID(), turnId: randomUUID() };

function input() {
  return { kind: "intents" as const, idempotencyKey: "mission-turn-1", budgets: { maxOperations: 1, maxDurationMs: 30_000 }, intents: [{
    intentId: "inspect", objectiveId: ids.objectiveId, flowDraftId: ids.flowDraftId,
    action: { kind: "inspect" as const, target: { concept: "account", role: "region" as const, name: "Account", exact: true } },
    expectedEffect: { kind: "none" as const }, constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" as const }, protectedInputReferences: [],
  }] };
}

describe("MissionFlowAuthoringService grouped turns", () => {
  it("returns compact independent channels and runner phase timings", async () => {
    const outcome = { operationId: "ignored", functionalResult: "succeeded" as const, mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const, evidenceResult: [{ channel: "trace" as const, state: "available" as const }], qualityFindings: [{ code: "LOW_CONTRAST" }], durationMs: 5 };
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn().mockResolvedValue({ state: "completed", outcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } }),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn().mockResolvedValue({ outcome, capabilityManifestDigest: "a".repeat(64), decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] }, timings: { resolveMs: 7, executeMs: 11, verifyMs: 13 } }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), input());
    expect(result).toMatchObject({ state: "completed", channels: { functional: { state: "passed" }, privacy: { state: "not_applicable" }, quality: { state: "passed", reasonCode: "QUALITY_FINDINGS_PRESENT" } } });
    expect(result.completed[0]).toMatchObject({ functionalResult: "succeeded", mutationOutcome: "not_applied", privacyApplicable: false, privacyResult: "unverified", evidence: { count: 1 }, quality: { findingCount: 1, reasonCodes: ["LOW_CONTRAST"] } });
    expect(result.timings).toMatchObject({ resolveMs: expect.any(Number), executeMs: expect.any(Number), verifyMs: 13, journalMs: expect.any(Number) });
    expect(result.timings.executeMs).toBeGreaterThanOrEqual(11);
  });

  it("replays the exact stored safe turn response without a browser call", async () => {
    const response = { turnId: ids.turnId, state: "completed" as const, completed: [], stateDelta: {}, channels: { functional: { state: "passed" as const }, mutation: { state: "passed" as const }, privacy: { state: "passed" as const }, evidence: { state: "passed" as const }, quality: { state: "passed" as const } }, timings: { resolveMs: 1, executeMs: 1, verifyMs: 1, journalMs: 1, totalMs: 4 }, decisionBoundary: null };
    const repository = { beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: true, response }) };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    await expect(service.advance(principal, randomUUID(), input())).resolves.toEqual(response);
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("aggregates only protected actions into the privacy channel", async () => {
    const ordinary = { operationId: "ordinary", functionalResult: "succeeded" as const, mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const, evidenceResult: [], qualityFindings: [], durationMs: 1 };
    const protectedOutcome = { ...ordinary, operationId: "protected", mutationOutcome: "applied" as const, privacyResult: "verified" as const };
    const protectedReferenceId = randomUUID();
    const protectedIntent = {
      ...input().intents[0], intentId: "protected", action: {
        kind: "fill" as const, target: { concept: "password", role: "textbox" as const, name: "Password", exact: true },
        protectedReferenceId,
      }, authorization: { kind: "authentication" as const }, protectedInputReferences: [protectedReferenceId],
    };
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn()
        .mockResolvedValueOnce({ outcome: ordinary, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } })
        .mockResolvedValueOnce({ outcome: protectedOutcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } }),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn()
      .mockResolvedValueOnce({ outcome: ordinary, timings: { resolveMs: 0, executeMs: 0, verifyMs: 0 } })
      .mockResolvedValueOnce({ outcome: protectedOutcome, timings: { resolveMs: 0, executeMs: 0, verifyMs: 0 } }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), { ...input(), budgets: { maxOperations: 2, maxDurationMs: 30_000 }, intents: [input().intents[0], protectedIntent] } as never);
    expect(result.channels.privacy).toEqual({ state: "passed" });
    expect(result.completed.map((delta) => delta.privacyApplicable)).toEqual([false, true]);
  });

  it("coalesces concurrent identical turns before browser execution", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const outcome = { operationId: "once", functionalResult: "succeeded" as const, mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const, evidenceResult: [], qualityFindings: [], durationMs: 1 };
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn().mockResolvedValue({ outcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } }),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn(async () => { await barrier; return { outcome, timings: { resolveMs: 0, executeMs: 0, verifyMs: 0 } }; }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const sessionId = randomUUID();
    const first = service.advance(principal, sessionId, input());
    await vi.waitFor(() => expect(runner.execute).toHaveBeenCalledOnce());
    const second = service.advance(principal, sessionId, input());
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(runner.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(secondResult)).toBe(JSON.stringify(firstResult));
  });

  it("does not hand off or execute a second idempotency key while a turn is active", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const outcome = { operationId: "once", functionalResult: "succeeded" as const, mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const, evidenceResult: [], qualityFindings: [], durationMs: 1 };
    const repository = {
      beginTurn: vi.fn()
        .mockResolvedValueOnce({ turnId: ids.turnId, replayed: false, response: null })
        .mockRejectedValueOnce(new ConflictException({ code: "MISSION_AUTHORING_TURN_IN_PROGRESS", turnId: ids.turnId, phase: "execute" })),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn().mockResolvedValue({ outcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } }),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn(async () => { await barrier; return { outcome, timings: { resolveMs: 0, executeMs: 0, verifyMs: 0 } }; }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const sessionId = randomUUID();
    const first = service.advance(principal, sessionId, input());
    await vi.waitFor(() => expect(runner.execute).toHaveBeenCalledOnce());
    await expect(service.advance(principal, sessionId, { ...input(), idempotencyKey: "mission-turn-2" })).rejects.toMatchObject({ response: { code: "MISSION_AUTHORING_TURN_IN_PROGRESS" } });
    release();
    await first;
    expect(repository.handoff).toHaveBeenCalledOnce();
    expect(runner.execute).toHaveBeenCalledOnce();
  });

  it("resumes from the durable intent cursor without replaying the settled prefix", async () => {
    const firstOutcome = {
      operationId: "first",
      functionalResult: "succeeded" as const,
      mutationOutcome: "not_applied" as const,
      privacyResult: "unverified" as const,
      evidenceResult: [],
      qualityFindings: [],
      durationMs: 1,
    };
    const secondOutcome = { ...firstOutcome, operationId: "second" };
    const intents = [
      input().intents[0],
      { ...input().intents[0], intentId: "inspect-details" },
    ];
    let pendingResponse: unknown;
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({
        turnId: ids.turnId,
        replayed: false,
        response: null,
      }),
      continueTurn: vi.fn(async () => ({
        id: ids.turnId,
        replayed: false,
        safeInput: { intents },
        safeResponse: pendingResponse,
        nextIntentIndex: 1,
      })),
      validateIntentAdmission: vi.fn(),
      handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn()
        .mockResolvedValueOnce({
          outcome: firstOutcome,
          decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] },
        })
        .mockResolvedValueOnce({
          outcome: secondOutcome,
          decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] },
        }),
      persistPending: vi.fn(async ({ result }) => {
        pendingResponse = result;
        return result;
      }),
      settleTurn: vi.fn(async ({ result }) => result),
      markOperationFailed: vi.fn(),
    };
    const runner = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          outcome: firstOutcome,
          timings: { resolveMs: 1, executeMs: 1, verifyMs: 1 },
        })
        .mockResolvedValueOnce({
          outcome: secondOutcome,
          timings: { resolveMs: 1, executeMs: 1, verifyMs: 1 },
        }),
    };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const sessionId = randomUUID();
    const pending = await service.advance(principal, sessionId, {
      ...input(),
      intents,
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    } as never);
    expect(pending).toMatchObject({
      state: "pending",
      continuation: { turnId: ids.turnId, phase: "budget" },
      completed: [{ intentId: "inspect" }],
    });
    expect(repository.persistPending).toHaveBeenCalledWith(expect.objectContaining({
      nextIntentIndex: 1,
    }));

    const completed = await service.advance(principal, sessionId, {
      kind: "continue",
      turnId: ids.turnId,
      idempotencyKey: "mission-turn-continuation-1",
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    });
    expect(completed).toMatchObject({
      state: "completed",
      completed: [{ intentId: "inspect" }, { intentId: "inspect-details" }],
    });
    expect(runner.execute).toHaveBeenCalledTimes(2);
    expect(repository.beginMissionOperation).toHaveBeenCalledTimes(2);
  });
});
