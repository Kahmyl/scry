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
  it("releases the local runtime when durable safe closure requires reconciliation", async () => {
    const sessionId = randomUUID();
    const conflict = new ConflictException({
      code: "MISSION_AUTHORING_CLOSE_RECONCILIATION_REQUIRED",
    });
    const repository = {
      closeAtSafeBoundary: vi.fn().mockRejectedValue(conflict),
    };
    const runner = { close: vi.fn().mockResolvedValue(undefined) };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );

    await expect(
      service.close(principal, sessionId, "close-recovery-required"),
    ).rejects.toBe(conflict);

    expect(runner.close).toHaveBeenCalledOnce();
    expect(runner.close).toHaveBeenCalledWith(sessionId);
  });

  it("settles a turn when intent admission fails before any browser operation", async () => {
    const sessionId = randomUUID();
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn().mockRejectedValue(new ConflictException({
        code: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
      })),
      handoff: vi.fn(),
      beginMissionOperation: vi.fn(),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );

    const result = await service.advance(principal, sessionId, input());

    expect(result).toMatchObject({
      state: "decision_required",
      completed: [],
      decisionBoundary: {
        type: "authorization_required",
        reasonCode: "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
        safeActions: ["authorize_environment_credentials", "advance_flow_authoring"],
      },
    });
    expect(repository.settleTurn).toHaveBeenCalledOnce();
    expect(repository.handoff).not.toHaveBeenCalled();
    expect(repository.beginMissionOperation).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("projects inactive protected references before preparation or kernel launch", async () => {
    const sessionId = randomUUID();
    const protectedReferenceId = randomUUID();
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn().mockRejectedValue(new ConflictException({
        code: "PROTECTED_REFERENCE_INACTIVE",
      })),
      handoff: vi.fn(),
      runtimeContextFor: vi.fn(),
      protectedPreparationFor: vi.fn(),
      beginMissionOperation: vi.fn(),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const protectedIntent = {
      intentId: "inactive-protected-reference",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "fill" as const,
        target: { concept: "client id", role: "textbox" as const, name: "Client ID", exact: true },
        protectedReferenceId,
      },
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "authentication" as const },
      protectedInputReferences: [protectedReferenceId],
    };

    const result = await service.advance(principal, sessionId, {
      ...input(),
      idempotencyKey: "inactive-protected-reference-turn",
      intents: [protectedIntent],
    });

    expect(result).toMatchObject({
      state: "decision_required",
      completed: [],
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "PROTECTED_REFERENCE_INACTIVE",
      },
    });
    expect(repository.handoff).not.toHaveBeenCalled();
    expect(repository.runtimeContextFor).not.toHaveBeenCalled();
    expect(repository.protectedPreparationFor).not.toHaveBeenCalled();
    expect(repository.beginMissionOperation).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("settles a turn when protected preparation fails before an operation is created", async () => {
    const sessionId = randomUUID();
    const authorizationId = randomUUID();
    const preparationError = new ConflictException({ code: "MISSION_AUTHORING_PREPARATION_INVALID" });
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(),
      handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      replayMissionOperation: vi.fn().mockResolvedValue(null),
      reserveMissionProtectedOperation: vi.fn().mockResolvedValue({ protectedOperationId: randomUUID() }),
      closeReservedMissionProtectedOperation: vi.fn(),
      runtimeContextFor: vi.fn().mockResolvedValue({
        lastObservation: { url: "https://example.test/docs" },
        policy: { allowedOrigins: ["https://example.test"] },
      }),
      protectedPreparationFor: vi.fn().mockRejectedValue(preparationError),
      beginMissionOperation: vi.fn(),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const acquisition = {
      ...input().intents[0],
      intentId: "capture-order",
      action: {
        kind: "acquire_protected_outputs" as const,
        preparationIntentIds: ["prepare-order"],
        mutation: {
          kind: "one_time" as const,
          target: { concept: "run request", role: "button" as const, name: "Run", exact: true },
        },
        outputs: [{
          reference: "orderId",
          classification: "protected" as const,
          target: { concept: "order id", role: "value" as const, name: "id", exact: true },
          storageName: "Order ID",
        }],
      },
      authorization: { kind: "protected_mutation" as const, authorizationId },
    };

    const result = await service.advance(principal, sessionId, {
      ...input(),
      idempotencyKey: "protected-preparation-failure",
      intents: [acquisition],
    } as never);

    expect(result).toMatchObject({
      state: "decision_required",
      completed: [],
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "MISSION_AUTHORING_PREPARATION_INVALID",
        safeActions: ["advance_flow_authoring"],
      },
    });
    expect(repository.settleTurn).toHaveBeenCalledOnce();
    expect(repository.beginMissionOperation).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("returns a genuine pending first response, then continues a durable protected operation without replay", async () => {
    const sessionId = randomUUID();
    const credentialId = randomUUID();
    const valueId = randomUUID();
    const authorizationId = randomUUID();
    const preparation = {
      ...input().intents[0], intentId: "fill-name",
      action: { kind: "fill" as const, target: { concept: "credential name", role: "textbox" as const, name: "Name", exact: true }, publicValue: "Qualification" },
    };
    const acquisition = {
      ...input().intents[0], intentId: "generate", expectedEffect: { kind: "none" as const },
      action: { kind: "acquire_protected_outputs" as const, preparationIntentIds: ["fill-name"], mutation: { kind: "one_time" as const, target: { concept: "generate credential", role: "button" as const, name: "Generate", exact: true } }, outputs: [
        { reference: "clientId", classification: "public" as const, target: { concept: "client id", role: "textbox" as const, name: "Client ID", exact: true }, storageName: "Client ID" },
        { reference: "clientSecret", classification: "protected" as const, target: { concept: "client secret", role: "textbox" as const, name: "Client secret", exact: true }, storageName: "Client secret" },
      ] }, authorization: { kind: "protected_mutation" as const, authorizationId },
    };
    let finishExecution!: (value: unknown) => void;
    const execution = new Promise((resolve) => { finishExecution = resolve; });
    const repository = {
      beginTurn: vi.fn(async () => ({ turnId: ids.turnId, replayed: false, response: null })),
      continueTurn: vi.fn(async () => ({ id: ids.turnId, replayed: false, safeInput: { intents: [acquisition] }, safeResponse: null, nextIntentIndex: 0 })),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      replayMissionOperation: vi.fn()
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => {
          const created = repository.beginMissionOperation.mock.calls[0]![0];
          return {
            operationId: created.operationId,
            idempotencyKey: created.idempotencyKey,
            action: created.action,
            expectedEffect: created.expectedEffect,
            mode: created.mode,
            protectedInputReferences: [],
          };
        }),
      reserveMissionProtectedOperation: vi.fn().mockResolvedValue({ protectedOperationId: randomUUID() }),
      protectedPreparationFor: vi.fn().mockResolvedValue([preparation]),
      runtimeContextFor: vi.fn().mockResolvedValue({
        lastObservation: { url: "https://example.test/credentials" },
        policy: { allowedOrigins: ["https://example.test"] },
      }),
      beginMissionOperation: vi.fn()
        .mockResolvedValueOnce({ replayed: false, state: "running", outcome: null })
        .mockResolvedValueOnce({ replayed: true, state: "running", outcome: null }),
      projectProtectedOperationForAuthoring: vi.fn(async () => ({
        status: "settled",
        state: "completed",
        outcome: {
          operationId: "generate", functionalResult: "succeeded", mutationOutcome: "applied",
          privacyResult: "sealed", evidenceResult: [], qualityFindings: [], durationMs: 0,
          generatedReferences: [
            { reference: "clientId", classification: "public", valueId, scope: "project" },
            { reference: "clientSecret", classification: "protected", credentialId, scope: "project" },
          ],
        },
        decisionBoundary: { type: "objective_completed", reasonCode: "PROTECTED_OPERATION_COMPLETED", safeActions: [] },
      })),
      persistPending: vi.fn(async ({ result }) => result),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn(() => execution) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const first = await service.advance(principal, sessionId, {
      kind: "intents", intents: [acquisition], idempotencyKey: "protected-first",
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    } as never);
    expect(first.state).toBe("pending");
    expect(runner.execute).toHaveBeenCalledOnce();
    expect(repository.protectedPreparationFor).toHaveBeenCalledWith({
      sessionId,
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      intentIds: ["fill-name"],
      entryUrl: "https://example.test/credentials",
    });
    expect(repository.beginMissionOperation).toHaveBeenCalledWith(expect.objectContaining({
      protectedReservation: expect.objectContaining({
        mutationIdentity: expect.any(String),
        programDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        safeOutputManifest: [
          { reference: "clientId", classification: "public", storageName: "Client ID" },
          { reference: "clientSecret", classification: "protected", storageName: "Client secret" },
        ],
      }),
    }));
    expect(repository.beginMissionOperation.mock.invocationCallOrder[0])
      .toBeLessThan(runner.execute.mock.invocationCallOrder[0]!);
    finishExecution({
      outcome: { operationId: "generate", functionalResult: "failed", mutationOutcome: "not_applied", privacyResult: "unverified", evidenceResult: [], qualityFindings: [], durationMs: 1, reasonCode: "ADAPTIVE_SESSION_EXECUTION_FAILED" },
      capabilityManifestDigest: "a".repeat(64),
      decisionBoundary: { type: "environment_unavailable", reasonCode: "ADAPTIVE_SESSION_EXECUTION_FAILED", safeActions: [] },
      timings: { resolveMs: 1, executeMs: 1, verifyMs: 1 },
    });
    await vi.waitFor(() => expect(repository.projectProtectedOperationForAuthoring).toHaveBeenCalledOnce());
    const second = await service.advance(principal, sessionId, { kind: "continue", turnId: ids.turnId, idempotencyKey: "poll-two", budgets: { maxOperations: 1, maxDurationMs: 30_000 } });
    expect(second.channels.privacy).toEqual({ state: "passed" });
    expect(second.completed[0]?.generatedReferences).toEqual(expect.arrayContaining([
      { reference: "clientId", classification: "public", valueId, scope: "project" },
      { reference: "clientSecret", classification: "protected", credentialId, scope: "project" },
    ]));
    expect(JSON.stringify(second)).not.toMatch(/client.?secret.?value|selector|runtimeId|fingerprint|handle|outerHTML/i);
    expect(runner.execute).toHaveBeenCalledOnce();
    expect(repository.projectProtectedOperationForAuthoring).toHaveBeenCalledTimes(2);
  });

  it.each([
    "planned", "preparing", "ready_to_dispatch", "dispatching", "dispatched",
    "acquiring", "persisting", "persisted", "reconciling",
  ] as const)("re-drives an unleased %s reservation through authoritative reclaim after process loss", async (expiredState) => {
    const sessionId = randomUUID();
    const authorizationId = randomUUID();
    const acquisition = {
      ...input().intents[0],
      intentId: "generate-after-restart",
      action: {
        kind: "acquire_protected_outputs" as const,
        preparationIntentIds: [],
        mutation: {
          kind: "one_time" as const,
          target: { concept: "generate", role: "button" as const, name: "Generate", exact: true },
        },
        outputs: [{
          reference: "secret",
          classification: "protected" as const,
          target: { concept: "secret", role: "textbox" as const, name: "Secret", exact: true },
          storageName: "Secret",
        }],
      },
      authorization: { kind: "protected_mutation" as const, authorizationId },
    };
    const repository = {
      continueTurn: vi.fn(async () => ({
        id: ids.turnId,
        replayed: false,
        safeInput: { intents: [acquisition] },
        safeResponse: null,
        nextIntentIndex: 0,
      })),
      validateIntentAdmission: vi.fn(),
      handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      replayMissionOperation: vi.fn().mockResolvedValue({
        operationId: "m2-recovered",
        idempotencyKey: "protected:m2-recovered",
        action: { type: "protectedTransaction" },
        expectedEffect: { type: "none" },
        mode: "mutation",
        protectedInputReferences: [],
      }),
      runtimeContextFor: vi.fn().mockResolvedValue({
        lastObservation: { url: "https://example.test/credentials" },
        policy: { allowedOrigins: ["https://example.test"] },
      }),
      protectedPreparationFor: vi.fn().mockResolvedValue([]),
      beginMissionOperation: vi.fn().mockResolvedValue({
        replayed: true,
        state: "running",
        outcome: null,
      }),
      projectProtectedOperationForAuthoring: vi.fn().mockResolvedValue({
        status: "pending",
        state: expiredState,
        leaseActive: false,
      }),
      persistPending: vi.fn(async ({ result }) => result),
      settleTurn: vi.fn(async ({ result }) => result),
      markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn().mockResolvedValue({}) };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );
    const result = await service.advance(principal, sessionId, {
      kind: "continue",
      turnId: ids.turnId,
      idempotencyKey: "restart-continuation",
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    });
    expect(result.state).toBe("pending");
    await vi.waitFor(() => expect(runner.execute).toHaveBeenCalledOnce());
    expect(repository.replayMissionOperation).toHaveBeenCalledOnce();
    expect(repository.beginMissionOperation).toHaveBeenCalledWith(
      expect.not.objectContaining({ protectedReservation: expect.anything() }),
    );
  });

  it.each([
    ["unverified", "PRIVACY_UNVERIFIED"],
    ["degraded", "PRIVACY_DEGRADED"],
  ] as const)("keeps %s protected privacy terminal results failed", async (privacyResult, reasonCode) => {
    const outcome = { operationId: "protected", functionalResult: "succeeded" as const, mutationOutcome: "applied" as const, privacyResult, evidenceResult: [], qualityFindings: [], durationMs: 1 };
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn().mockResolvedValue({ state: "completed", outcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } }),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn().mockResolvedValue({ outcome, capabilityManifestDigest: "a".repeat(64), decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] }, timings: { resolveMs: 0, executeMs: 0, verifyMs: 0 } }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const protectedIntent = { ...input().intents[0], action: { kind: "fill" as const, target: { concept: "secret", role: "textbox" as const, name: "Secret", exact: true }, protectedReferenceId: randomUUID() }, authorization: { kind: "authentication" as const } };
    const result = await service.advance(principal, randomUUID(), { ...input(), intents: [protectedIntent] } as never);
    expect(result.channels.privacy).toEqual({ state: "failed", reasonCode });
  });

  it("returns compact independent channels and runner phase timings", async () => {
    const resolvedTarget = { fingerprint: "f".repeat(64), concept: "email", scopeKind: "page" as const, capabilityDigest: "c".repeat(64) };
    const outcome = { operationId: "ignored", functionalResult: "succeeded" as const, mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const, evidenceResult: [{ channel: "trace" as const, state: "available" as const }], qualityFindings: [{ code: "LOW_CONTRAST" }], resolvedTarget, durationMs: 5 };
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn().mockResolvedValue({ state: "completed", outcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } }),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn().mockResolvedValue({ outcome, capabilityManifestDigest: "a".repeat(64), decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] }, timings: { resolveMs: 7, executeMs: 11, verifyMs: 13 } }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), {
      ...input(),
      budgets: { maxOperations: 1, maxDurationMs: 1_000 },
      intents: [{ ...input().intents[0], constraints: {
        ...input().intents[0]!.constraints, timeoutMs: 60_000,
      } }],
    } as never);
    expect(result).toMatchObject({ state: "completed", channels: { functional: { state: "passed" }, privacy: { state: "not_applicable" }, quality: { state: "passed", reasonCode: "QUALITY_FINDINGS_PRESENT" } } });
    expect(result.completed[0]).toMatchObject({ functionalResult: "succeeded", mutationOutcome: "not_applied", privacyApplicable: false, privacyResult: "unverified", evidence: { count: 1 }, semanticEvidence: { count: 1, resolvedTarget }, quality: { findingCount: 1, reasonCodes: ["LOW_CONTRAST"] } });
    expect(result.timings).toMatchObject({ resolveMs: expect.any(Number), executeMs: expect.any(Number), verifyMs: 13, journalMs: expect.any(Number) });
    expect(result.timings.executeMs).toBeGreaterThanOrEqual(11);
    expect(runner.execute.mock.calls[0]?.[1]).toMatchObject({
      action: { timeoutMs: expect.any(Number) },
    });
    expect(runner.execute.mock.calls[0]![1].action.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(runner.execute.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it("replays the exact stored safe turn response without a browser call", async () => {
    const response = { turnId: ids.turnId, state: "completed" as const, completed: [], stateDelta: {}, channels: { functional: { state: "passed" as const }, mutation: { state: "passed" as const }, privacy: { state: "passed" as const }, evidence: { state: "passed" as const }, quality: { state: "passed" as const } }, timings: { resolveMs: 1, executeMs: 1, verifyMs: 1, journalMs: 1, totalMs: 4 }, decisionBoundary: null };
    const repository = { beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: true, response }) };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    await expect(service.advance(principal, randomUUID(), input())).resolves.toEqual(response);
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("preserves a failed durable operation as decision-required on continuation", async () => {
    const failed = {
      operationId: "failed-operation", functionalResult: "failed" as const,
      mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1, reasonCode: "PROTECTED_PREPARATION_FAILED",
    };
    const repository = {
      continueTurn: vi.fn(async () => ({
        id: ids.turnId, replayed: false, safeInput: { intents: input().intents },
        safeResponse: null, nextIntentIndex: 0,
      })),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: true, state: "failed", outcome: failed }),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), {
      kind: "continue", turnId: ids.turnId, idempotencyKey: "continue-failed",
      budgets: { maxOperations: 1, maxDurationMs: 30_000 },
    });
    expect(result).toMatchObject({
      state: "decision_required",
      decisionBoundary: { type: "environment_unavailable", reasonCode: "PROTECTED_PREPARATION_FAILED" },
    });
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("reconciles a reclaimed post-dispatch mutation as UNKNOWN without redispatch", async () => {
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null,
        recovered: true, phase: "resume" }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: true, state: "running", outcome: null }),
      replayDisposition: vi.fn().mockResolvedValue({ requiresReconciliation: true, canResume: false }),
      markRunningOperationRecoveryRequired: vi.fn(),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const runner = { execute: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never,
      { assertAcceptingWork: vi.fn() } as never);

    const result = await service.advance(principal, randomUUID(), input());

    expect(result).toMatchObject({ state: "decision_required", completed: [],
      decisionBoundary: { type: "mutation_reconciliation_required",
        reasonCode: "ADAPTIVE_OPERATION_RECONCILIATION_REQUIRED",
        safeActions: ["get_flow_authoring", "do_not_retry"] } });
    expect(repository.markRunningOperationRecoveryRequired).toHaveBeenCalledOnce();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("normalizes raw database SQLSTATE values to a valid safe failure code", async () => {
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(),
      handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      markOperationFailed: vi.fn(),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const databaseError = Object.assign(new Error("syntax error"), { code: "42601" });
    const runner = { execute: vi.fn().mockRejectedValue(databaseError) };
    const service = new MissionFlowAuthoringService(
      repository as never,
      runner as never,
      { assertAcceptingWork: vi.fn() } as never,
    );

    await expect(service.advance(principal, randomUUID(), input())).resolves.toMatchObject({
      state: "decision_required",
      completed: [],
      decisionBoundary: {
        type: "environment_unavailable",
        reasonCode: "ADAPTIVE_SESSION_EXECUTION_FAILED",
      },
    });
    expect(repository.markOperationFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "ADAPTIVE_SESSION_EXECUTION_FAILED",
    );
  });

  it("returns a causal fail-closed boundary for an unknown-effect activate under live_read", async () => {
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      markOperationFailed: vi.fn(), settleTurn: vi.fn(async ({ result }) => result),
    };
    const denied = Object.assign(new Error("denied"), { code: "EXECUTION_MODE_POLICY_DENIED" });
    const runner = { execute: vi.fn().mockRejectedValue(denied) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never, { assertAcceptingWork: vi.fn() } as never);
    const intent = {
      ...input().intents[0], intentId: "unknown-live-activate",
      action: { kind: "activate" as const, target: { concept: "unclassified control", role: "button" as const } },
      authorization: { kind: "live_read" as const },
    };

    await expect(service.advance(principal, randomUUID(), { ...input(), intents: [intent] } as never)).resolves.toMatchObject({
      state: "decision_required",
      decisionBoundary: {
        type: "policy_refused", reasonCode: "EXECUTION_MODE_POLICY_DENIED", safeActions: [],
        policyContext: {
          governingMode: "observe", requestedSemanticEffect: "unknown", gesture: "activate",
          effectApplied: false, strongerAuthorityCouldPermit: false, recoverable: false,
        },
      },
    });
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

  it("carries an ambiguous boundary into a fresh same-session revised-intent turn", async () => {
    const sessionId = randomUUID();
    const secondTurnId = randomUUID();
    const candidateDistinctions = [{
      label: "table row acting as link",
      distinction: "accessible name \"Scry Recovery 39ca1ecb Test Active\"; contains the requested identity rather than exactly equaling it; capabilities: focusable, pointer activatable; scope: page",
    }];
    const failed = {
      operationId: "first", functionalResult: "failed" as const,
      mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1,
      reasonCode: "PRAXIS_TARGET_AMBIGUOUS",
      nextDecisionBoundary: { type: "ambiguous_candidate" as const,
        reasonCode: "PRAXIS_TARGET_AMBIGUOUS", safeActions: ["advance_flow_authoring"],
        candidateDistinctions },
    };
    const succeeded = { ...failed, operationId: "second", functionalResult: "succeeded" as const,
      mutationOutcome: "applied" as const, reasonCode: undefined, nextDecisionBoundary: undefined };
    const repository = {
      beginTurn: vi.fn()
        .mockResolvedValueOnce({ turnId: ids.turnId, replayed: false, response: null })
        .mockResolvedValueOnce({ turnId: secondTurnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn(async ({ outcome }) => ({
        outcome,
        decisionBoundary: outcome.nextDecisionBoundary ?? {
          type: "objective_completed", reasonCode: "DONE", safeActions: [],
        },
      })),
      settleTurn: vi.fn(async ({ result }) => result), markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn()
      .mockResolvedValueOnce({ outcome: failed, timings: { resolveMs: 1, executeMs: 1, verifyMs: 1 } })
      .mockResolvedValueOnce({ outcome: succeeded, timings: { resolveMs: 1, executeMs: 1, verifyMs: 1 } }) };
    const service = new MissionFlowAuthoringService(repository as never, runner as never,
      { assertAcceptingWork: vi.fn() } as never);
    const firstInput = {
      ...input(), idempotencyKey: "mission-recovery-original",
      intents: [{ ...input().intents[0], intentId: "open-original", action: {
        kind: "activate" as const,
        target: { concept: "created application", role: "link" as const,
          name: "Scry Recovery 39ca1ecb", exact: true },
      } }],
    };
    const first = await service.advance(principal, sessionId, firstInput as never);
    expect(first).toMatchObject({ state: "decision_required", decisionBoundary: {
      type: "ambiguous_candidate", reasonCode: "PRAXIS_TARGET_AMBIGUOUS",
      safeActions: ["advance_flow_authoring"], candidateDistinctions,
    } });
    const secondInput = {
      ...input(), kind: "intents" as const, idempotencyKey: "mission-recovery-revised",
      intents: [{ ...input().intents[0], intentId: "open-revised",
        constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: true },
        action: {
          kind: "activate" as const,
          target: { concept: "created application", role: "link" as const,
            name: "Scry Recovery 39ca1ecb", exact: false },
        } }],
    };
    const second = await service.advance(principal, sessionId, secondInput as never);
    expect(second).toMatchObject({ state: "completed" });
    expect(runner.execute).toHaveBeenCalledTimes(2);
    expect(runner.execute.mock.calls.map(([calledSession]) => calledSession)).toEqual([sessionId, sessionId]);
    expect(secondInput.kind).toBe("intents");
    expect(secondInput.idempotencyKey).not.toBe(firstInput.idempotencyKey);
    expect(secondInput.intents[0]!.intentId).not.toBe(firstInput.intents[0]!.intentId);
    expect(runner.execute.mock.calls[1]?.[1]).toMatchObject({
      action: { target: { matching: "non_exact" } },
    });
    const serializedRequests = JSON.stringify([firstInput, secondInput]);
    expect(serializedRequests).not.toMatch(/candidateId|fingerprint|resumeToken/);
  });

  it("does not begin browser dispatch when admission consumes the turn deadline", async () => {
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(async () => new Promise((resolve) => setTimeout(resolve, 120))),
      handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      persistPending: vi.fn(async ({ result }) => result), settleTurn: vi.fn(),
    };
    const runner = { execute: vi.fn(), cancelActiveOperation: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never,
      { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), {
      ...input(), budgets: { maxOperations: 1, maxDurationMs: 100 },
    } as never);
    expect(result).toMatchObject({ state: "pending", continuation: { phase: "budget" } });
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("allows authoritative settlement to finish after budget and dispatches no later intent", async () => {
    const succeeded = { operationId: "first", functionalResult: "succeeded" as const,
      mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1 };
    const intents = [input().intents[0]!, { ...input().intents[0]!, intentId: "later" }];
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      settleMissionOperation: vi.fn(async ({ outcome }) => {
        await new Promise((resolve) => setTimeout(resolve, 130));
        return { outcome, decisionBoundary: { type: "objective_completed", reasonCode: "DONE", safeActions: [] } };
      }),
      persistPending: vi.fn(async ({ result }) => result), settleTurn: vi.fn(async ({ result }) => result),
      markOperationFailed: vi.fn(),
    };
    const runner = { execute: vi.fn().mockResolvedValue({ outcome: succeeded,
      timings: { resolveMs: 0, executeMs: 1, verifyMs: 0 },
      safeState: { url: "https://example.test", documentEpoch: 1 } }),
      cancelActiveOperation: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never,
      { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), {
      ...input(), intents, budgets: { maxOperations: 2, maxDurationMs: 120 },
    } as never);
    expect(result).toMatchObject({ state: "pending", completed: [{ intentId: "inspect" }] });
    expect(repository.settleMissionOperation).toHaveBeenCalledOnce();
    expect(runner.execute).toHaveBeenCalledOnce();
  });

  it("cancels active work, preserves post-dispatch UNKNOWN, and skips later intents", async () => {
    const intents = [input().intents[0]!, { ...input().intents[0]!, intentId: "must-not-run" }];
    const unknownBoundary = { type: "mutation_reconciliation_required" as const,
      reasonCode: "ADAPTIVE_OPERATION_OUTCOME_UNKNOWN", safeActions: ["get_flow_authoring"] };
    const repository = {
      beginTurn: vi.fn().mockResolvedValue({ turnId: ids.turnId, replayed: false, response: null }),
      validateIntentAdmission: vi.fn(), handoff: vi.fn().mockResolvedValue({ handedOff: false }),
      beginMissionOperation: vi.fn().mockResolvedValue({ replayed: false, state: "running" }),
      markOperationFailed: vi.fn().mockResolvedValue({ decisionBoundary: unknownBoundary }),
      settleTurn: vi.fn(async ({ result }) => result),
    };
    const runner = { execute: vi.fn(async (_sessionId, _operation, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("AUTHORING_TURN_BUDGET_EXHAUSTED"),
          { code: "AUTHORING_TURN_BUDGET_EXHAUSTED" })), { once: true }))),
      cancelActiveOperation: vi.fn() };
    const service = new MissionFlowAuthoringService(repository as never, runner as never,
      { assertAcceptingWork: vi.fn() } as never);
    const result = await service.advance(principal, randomUUID(), {
      ...input(), intents, budgets: { maxOperations: 2, maxDurationMs: 150 },
    } as never);
    expect(result).toMatchObject({ state: "decision_required", completed: [],
      decisionBoundary: unknownBoundary });
    expect(runner.cancelActiveOperation).toHaveBeenCalledOnce();
    expect(runner.execute).toHaveBeenCalledOnce();
    expect(repository.markOperationFailed).toHaveBeenCalledOnce();
  });
});
