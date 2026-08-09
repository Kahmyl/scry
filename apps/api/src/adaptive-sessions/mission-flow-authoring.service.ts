import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type {
  AdaptiveSessionOperationInput,
  AdvanceAdaptiveSessionInput,
  MissionAuthoringAdvanceInput,
  MissionAuthoringIntent,
  MissionAuthoringTurnResult,
  StartAdaptiveSessionInput,
} from "@scry/contracts";
import { createHash } from "node:crypto";

import type { Principal } from "../auth/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";
import { deriveMissionAuthoringOperation } from "./mission-authoring-derivation.js";

@Injectable()
export class MissionFlowAuthoringService {
  private readonly inFlightTurns = new Map<string, Promise<MissionAuthoringTurnResult>>();

  constructor(
    @Inject(AdaptiveSessionRepository) private readonly sessions: AdaptiveSessionRepository,
    @Inject(AdaptiveSessionKernelRunner) private readonly runner: AdaptiveSessionKernelRunner,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
  ) {}

  async start(principal: Principal, input: StartAdaptiveSessionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    const result = await this.sessions.create(workspaceId(principal), input);
    return {
      ...(await this.sessions.get(workspaceId(principal), result.id)),
      replayed: result.replayed,
    };
  }

  get(principal: Principal, sessionId: string) {
    return this.sessions.get(workspaceId(principal), sessionId);
  }

  async advance(principal: Principal, sessionId: string, input: MissionAuthoringAdvanceInput | AdvanceAdaptiveSessionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    if (!("kind" in input)) throw new ConflictException({ code: "MISSION_AUTHORING_INTENT_REQUIRED" });
    const missionInput: MissionAuthoringAdvanceInput = input;
    if (missionInput.kind === "intents") {
      const key = `${sessionId}:${missionInput.idempotencyKey}`;
      const inFlight = this.inFlightTurns.get(key);
      if (inFlight) return this.awaitInFlightTurn(inFlight, missionInput.budgets.maxDurationMs);
      const owner = this.advanceOwned(principal, sessionId, missionInput);
      this.inFlightTurns.set(key, owner);
      try {
        return await owner;
      } finally {
        if (this.inFlightTurns.get(key) === owner) this.inFlightTurns.delete(key);
      }
    }
    return this.advanceOwned(principal, sessionId, missionInput);
  }

  private async advanceOwned(principal: Principal, sessionId: string, input: MissionAuthoringAdvanceInput) {
    let turn: {
      turnId: string;
      replayed: boolean;
      response: MissionAuthoringTurnResult | null;
      safeInput?: { intents?: MissionAuthoringIntent[] };
      nextIntentIndex: number;
    };
    if (input.kind === "intents") {
      const created = await this.sessions.beginTurn({
        workspaceId: workspaceId(principal), sessionId, idempotencyKey: input.idempotencyKey,
        inputDigest: digest({ intents: input.intents, budgets: input.budgets }), budgets: input.budgets, intents: input.intents,
      });
      turn = {
        turnId: created.turnId,
        replayed: created.replayed,
        response: created.response,
        nextIntentIndex: 0,
      };
    } else {
      const continued = await this.sessions.continueTurn({
        workspaceId: workspaceId(principal), sessionId, turnId: input.turnId,
        idempotencyKey: input.idempotencyKey, budgets: input.budgets,
      });
      turn = {
        turnId: continued.id,
        replayed: continued.replayed,
        response: continued.safeResponse,
        safeInput: continued.safeInput,
        nextIntentIndex: continued.nextIntentIndex,
      };
    }
    if (turn.replayed && turn.response) return turn.response;
    if (turn.replayed) {
      throw new ConflictException({ code: "MISSION_AUTHORING_TURN_IN_PROGRESS", turnId: turn.turnId });
    }
    const intents = input.kind === "intents" ? input.intents : turn.safeInput?.intents;
    if (!intents?.length) throw new ConflictException({ code: "MISSION_AUTHORING_TURN_INPUT_UNAVAILABLE" });
    return this.executeTurn(
      principal,
      sessionId,
      turn.turnId,
      intents,
      input.budgets,
      turn.nextIntentIndex,
      input.kind === "continue" ? turn.response : null,
    );
  }

  private async awaitInFlightTurn(
    owner: Promise<MissionAuthoringTurnResult>,
    maxDurationMs: number,
  ): Promise<MissionAuthoringTurnResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        owner,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new ConflictException({ code: "MISSION_AUTHORING_TURN_IN_PROGRESS" })),
            Math.min(maxDurationMs, 60_000),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeTurn(
    principal: Principal,
    sessionId: string,
    turnId: string,
    intents: MissionAuthoringIntent[],
    budgets: { maxOperations: number; maxDurationMs: number },
    nextIntentIndex = 0,
    priorResult: MissionAuthoringTurnResult | null = null,
  ) {
    const startedAt = performance.now();
    const completed: MissionAuthoringTurnResult["completed"] = [...(priorResult?.completed ?? [])];
    const timings = {
      resolveMs: priorResult?.timings.resolveMs ?? 0,
      executeMs: priorResult?.timings.executeMs ?? 0,
      verifyMs: priorResult?.timings.verifyMs ?? 0,
      journalMs: priorResult?.timings.journalMs ?? 0,
    };
    let handoffChanged = Boolean(
      priorResult?.stateDelta.activeObjectiveId && priorResult.stateDelta.activeFlowDraftId,
    );
    let active = priorResult?.stateDelta.activeObjectiveId && priorResult.stateDelta.activeFlowDraftId
      ? {
          objectiveId: priorResult.stateDelta.activeObjectiveId,
          flowDraftId: priorResult.stateDelta.activeFlowDraftId,
        }
      : undefined;
    let safeState = priorResult?.stateDelta.url !== undefined && priorResult.stateDelta.documentEpoch !== undefined
      ? { url: priorResult.stateDelta.url, documentEpoch: priorResult.stateDelta.documentEpoch }
      : undefined;
    let operationsThisAttempt = 0;
    const priorTotalMs = priorResult?.timings.totalMs ?? 0;
    for (let intentIndex = nextIntentIndex; intentIndex < intents.length; intentIndex += 1) {
      const intent = intents[intentIndex]!;
      if (
        operationsThisAttempt >= budgets.maxOperations ||
        performance.now() - startedAt >= budgets.maxDurationMs
      ) {
        const pending = turnResult({
          turnId,
          state: "pending",
          completed,
          handoffChanged,
          ...(active ? { active } : {}),
          ...(safeState ? { safeState } : {}),
          startedAt,
          elapsedBaseMs: priorTotalMs,
          phase: "budget",
          timings,
        });
        return this.sessions.persistPending({
          sessionId,
          turnId,
          result: pending,
          phase: "budget",
          nextIntentIndex: intentIndex,
        });
      }
      const resolveStartedAt = performance.now();
      await this.sessions.validateIntentAdmission({ sessionId, intent });
      const handoff = await this.sessions.handoff({
        workspaceId: workspaceId(principal), sessionId, objectiveId: intent.objectiveId,
        flowDraftId: intent.flowDraftId, idempotencyKey: `handoff:${turnId}:${intent.intentId}`,
        reason: "Intent Flow ownership changed",
      });
      handoffChanged ||= handoff.handedOff;
      if (handoff.handedOff) active = { objectiveId: intent.objectiveId, flowDraftId: intent.flowDraftId };
      const derived = deriveMissionAuthoringOperation({ turnId, intent });
      const operation: AdaptiveSessionOperationInput = {
        operationId: derived.operationId, idempotencyKey: derived.idempotencyKey,
        action: derived.action, expectedEffect: derived.expectedEffect, mode: derived.mode,
        protectedInputReferences: intent.protectedInputReferences,
      };
      const claim = await this.sessions.beginMissionOperation({
        workspaceId: workspaceId(principal), sessionId, intent, ...derived,
      });
      timings.resolveMs += performance.now() - resolveStartedAt;
      if (claim.replayed && "outcome" in claim && claim.state !== "running" && claim.outcome) {
        completed.push(compactSemanticDelta(intent.intentId, claim.outcome, requiresProtectedInterval(intent)));
        continue;
      }
      operationsThisAttempt += 1;
      try {
        const result = await this.executeWithOnePreDispatchRetry(sessionId, operation);
        timings.resolveMs += result.timings.resolveMs;
        timings.executeMs += result.timings.executeMs;
        timings.verifyMs += result.timings.verifyMs;
        safeState = result.safeState;
        const journalStartedAt = performance.now();
        const settled = await this.sessions.settleMissionOperation({
          sessionId, operationId: operation.operationId, intent, action: operation.action, ...result,
        });
        timings.journalMs += performance.now() - journalStartedAt;
        completed.push(compactSemanticDelta(intent.intentId, settled.outcome, requiresProtectedInterval(intent)));
        if (settled.outcome.functionalResult !== "succeeded" || settled.outcome.mutationOutcome === "unknown" || settled.decisionBoundary.type !== "objective_completed") {
          const decision = turnResult({ turnId, state: "decision_required", completed, handoffChanged, ...(active ? { active } : {}), ...(safeState ? { safeState } : {}), startedAt, elapsedBaseMs: priorTotalMs, decisionBoundary: settled.decisionBoundary, timings });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
      } catch (error) {
        const code = errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED");
        await this.sessions.markOperationFailed(sessionId, operation.operationId, code);
        const decision = turnResult({ turnId, state: "decision_required", completed, handoffChanged, ...(active ? { active } : {}), ...(safeState ? { safeState } : {}), startedAt, elapsedBaseMs: priorTotalMs, timings, decisionBoundary: {
          type: "environment_unavailable", reasonCode: code, safeActions: ["get_flow_authoring"],
        } });
        return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
      }
    }
    return this.settleTurn(sessionId, turnId, turnResult({ turnId, state: "completed", completed, handoffChanged, ...(active ? { active } : {}), ...(safeState ? { safeState } : {}), startedAt, elapsedBaseMs: priorTotalMs, timings }), timings, startedAt);
  }

  private async settleTurn(sessionId: string, turnId: string, result: MissionAuthoringTurnResult, timings: { resolveMs: number; executeMs: number; verifyMs: number; journalMs: number }, startedAt: number) {
    void timings;
    void startedAt;
    return this.sessions.settleTurn({ sessionId, turnId, result });
  }

  private async executeWithOnePreDispatchRetry(sessionId: string, operation: AdaptiveSessionOperationInput) {
    try {
      return await this.runner.execute(sessionId, operation);
    } catch (error) {
      if (!(typeof error === "object" && error && "preDispatchTransient" in error && error.preDispatchTransient === true)) throw error;
      return this.runner.execute(sessionId, operation);
    }
  }

  async close(principal: Principal, sessionId: string, idempotencyKey: string) {
    this.requireWrite(principal);
    const result = await this.sessions.closeAtSafeBoundary({ workspaceId: workspaceId(principal), sessionId, idempotencyKey });
    await this.runner.close(sessionId);
    return result;
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Workspace viewers have read-only access");
    }
  }
}

function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}

function errorCode(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === "object" && response && "code" in response) {
      const code = (response as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : fallback;
}

function compactSemanticDelta(
  intentId: string,
  outcome: import("@scry/contracts").OperationOutcome,
  privacyApplicable: boolean,
): MissionAuthoringTurnResult["completed"][number] {
  return {
    intentId,
    state: outcome.functionalResult === "succeeded" ? "completed" : "failed",
    effectVerified: outcome.functionalResult === "succeeded",
    ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
    functionalResult: outcome.functionalResult,
    mutationOutcome: outcome.mutationOutcome,
    privacyApplicable,
    privacyResult: outcome.privacyResult,
    evidence: {
      state: outcome.evidenceResult.some((channel) => channel.state === "failed") ? "failed" :
        outcome.evidenceResult.some((channel) => channel.state === "quarantined") ? "quarantined" :
        outcome.evidenceResult.some((channel) => channel.state === "suppressed") ? "suppressed" : "available",
      count: outcome.evidenceResult.length,
      reasonCodes: outcome.evidenceResult.flatMap((channel) => channel.reasonCode ? [channel.reasonCode] : []).slice(0, 8),
    },
    quality: {
      findingCount: outcome.qualityFindings.length,
      reasonCodes: outcome.qualityFindings
        .flatMap((finding) => typeof finding.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(finding.code) ? [finding.code] : [])
        .slice(0, 8),
    },
  };
}

function turnResult(input: {
  turnId: string;
  state: MissionAuthoringTurnResult["state"];
  completed: MissionAuthoringTurnResult["completed"];
  handoffChanged: boolean;
  active?: { objectiveId: string; flowDraftId: string };
  safeState?: { url: string; documentEpoch: number };
  startedAt: number;
  elapsedBaseMs?: number;
  timings: { resolveMs: number; executeMs: number; verifyMs: number; journalMs: number };
  phase?: string;
  decisionBoundary?: MissionAuthoringTurnResult["decisionBoundary"];
}): MissionAuthoringTurnResult {
  const failed = input.completed.some((delta) => delta.functionalResult !== "succeeded");
  const unknown = input.completed.some((delta) => delta.mutationOutcome === "unknown");
  const evidenceFailed = input.completed.some((delta) => delta.evidence.state === "failed" || delta.evidence.state === "quarantined");
  return {
    turnId: input.turnId,
    state: input.state,
    completed: input.completed,
    stateDelta: {
      ...(input.handoffChanged && input.active ? { activeObjectiveId: input.active.objectiveId, activeFlowDraftId: input.active.flowDraftId } : {}),
      ...(input.safeState ? { url: input.safeState.url, documentEpoch: input.safeState.documentEpoch } : {}),
    },
    channels: {
      functional: { state: input.state === "pending" ? "pending" : failed ? "failed" : "passed" },
      mutation: { state: unknown ? "failed" : "passed" },
      privacy: privacyChannel(input.completed),
      evidence: { state: input.state === "pending" ? "pending" : evidenceFailed ? "failed" : "passed" },
      quality: { state: "passed", ...(input.completed.some((delta) => delta.quality.findingCount > 0) ? { reasonCode: "QUALITY_FINDINGS_PRESENT" } : {}) },
    },
    timings: { resolveMs: Math.round(input.timings.resolveMs), executeMs: Math.round(input.timings.executeMs), verifyMs: Math.round(input.timings.verifyMs), journalMs: Math.round(input.timings.journalMs), totalMs: Math.round((input.elapsedBaseMs ?? 0) + performance.now() - input.startedAt) },
    decisionBoundary: input.decisionBoundary ?? null,
    ...(input.state === "pending" ? { continuation: { turnId: input.turnId, phase: input.phase ?? "resume" } } : {}),
  };
}

function privacyChannel(completed: MissionAuthoringTurnResult["completed"]): MissionAuthoringTurnResult["channels"]["privacy"] {
  const privacy = completed.filter((delta) => delta.privacyApplicable).map((delta) => delta.privacyResult);
  if (!privacy.length) return { state: "not_applicable" };
  if (privacy.includes("sealed")) return { state: "failed", reasonCode: "PRIVACY_SEALED" };
  if (privacy.includes("degraded")) return { state: "failed", reasonCode: "PRIVACY_DEGRADED" };
  if (privacy.includes("unverified")) return { state: "failed", reasonCode: "PRIVACY_UNVERIFIED" };
  return { state: "passed" };
}

function requiresProtectedInterval(intent: MissionAuthoringIntent) {
  return (intent.action.kind === "fill" && Boolean(intent.action.protectedReferenceId)) ||
    intent.action.kind === "same_origin_request";
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
