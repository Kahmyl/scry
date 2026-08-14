import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type {
  AdaptiveSessionOperationInput,
  AdvanceAdaptiveSessionInput,
  MissionAuthoringAdvanceInput,
  MissionAuthoringIntent,
  MissionAuthoringTurnResult,
  StartAdaptiveSessionInput,
  RecoverTrustedOriginsInput,
  CurrentAction,
  PrepareFlowAuthoringInput,
} from "@scry/contracts";
import { createHash } from "node:crypto";

import type { Principal } from "../auth/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";
import { OperationBoundProtectedInputRepository } from "./operation-bound-protected-input.repository.js";
import {
  deriveMissionAuthoringOperation,
  missionAuthoringOperationIdentity,
} from "./mission-authoring-derivation.js";
import {
  compileMissionAuthoringProtectedTransaction,
  missionAuthoringProtectedOperationReservation,
} from "./mission-authoring-protected-transaction.js";

@Injectable()
export class MissionFlowAuthoringService {
  private readonly inFlightTurns = new Map<string, Promise<MissionAuthoringTurnResult>>();
  private readonly inFlightProtectedOperations = new Map<string, Promise<void>>();

  constructor(
    @Inject(AdaptiveSessionRepository) private readonly sessions: AdaptiveSessionRepository,
    @Inject(AdaptiveSessionKernelRunner) private readonly runner: AdaptiveSessionKernelRunner,
    @Inject(ReleaseAdmissionService) private readonly admission: ReleaseAdmissionService,
    @Optional()
    @Inject(OperationBoundProtectedInputRepository)
    private readonly syntheticInputs?: OperationBoundProtectedInputRepository,
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

  async prepare(principal: Principal, input: PrepareFlowAuthoringInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.sessions.prepare(workspaceId(principal), input);
  }

  async recoverTrustedOrigins(principal: Principal, input: RecoverTrustedOriginsInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    return this.sessions.recoverTrustedOrigins(workspaceId(principal), input);
  }

  get(principal: Principal, sessionId: string) {
    return this.sessions.get(workspaceId(principal), sessionId);
  }

  async advance(
    principal: Principal,
    sessionId: string,
    input: MissionAuthoringAdvanceInput | AdvanceAdaptiveSessionInput,
  ) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    if (!("kind" in input))
      throw new ConflictException({ code: "MISSION_AUTHORING_INTENT_REQUIRED" });
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

  private async advanceOwned(
    principal: Principal,
    sessionId: string,
    input: MissionAuthoringAdvanceInput,
  ) {
    let turn: {
      turnId: string;
      replayed: boolean;
      response: MissionAuthoringTurnResult | null;
      safeInput?: { intents?: MissionAuthoringIntent[] };
      nextIntentIndex: number;
    };
    if (input.kind === "intents") {
      const created = await this.sessions.beginTurn({
        workspaceId: workspaceId(principal),
        sessionId,
        idempotencyKey: input.idempotencyKey,
        inputDigest: digest({ intents: input.intents, budgets: input.budgets }),
        budgets: input.budgets,
        intents: input.intents,
      });
      turn = {
        turnId: created.turnId,
        replayed: created.replayed,
        response: created.response,
        nextIntentIndex: 0,
      };
    } else {
      const continued = await this.sessions.continueTurn({
        workspaceId: workspaceId(principal),
        sessionId,
        turnId: input.turnId,
        idempotencyKey: input.idempotencyKey,
        budgets: input.budgets,
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
      throw new ConflictException({
        code: "MISSION_AUTHORING_TURN_IN_PROGRESS",
        turnId: turn.turnId,
      });
    }
    const intents = input.kind === "intents" ? input.intents : turn.safeInput?.intents;
    if (!intents?.length)
      throw new ConflictException({ code: "MISSION_AUTHORING_TURN_INPUT_UNAVAILABLE" });
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
    let active =
      priorResult?.stateDelta.activeObjectiveId && priorResult.stateDelta.activeFlowDraftId
        ? {
            objectiveId: priorResult.stateDelta.activeObjectiveId,
            flowDraftId: priorResult.stateDelta.activeFlowDraftId,
          }
        : undefined;
    let safeState =
      priorResult?.stateDelta.url !== undefined &&
      priorResult.stateDelta.documentEpoch !== undefined
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
      let operation: AdaptiveSessionOperationInput;
      let protectedReservation:
        ReturnType<typeof missionAuthoringProtectedOperationReservation> | undefined;
      let earlyProtectedOperationId: string | undefined;
      let replayedOperation: AdaptiveSessionOperationInput | null = null;
      try {
        await this.sessions.validateIntentAdmission({ sessionId, intent });
        const handoff = await this.sessions.handoff({
          workspaceId: workspaceId(principal),
          sessionId,
          objectiveId: intent.objectiveId,
          flowDraftId: intent.flowDraftId,
          idempotencyKey: `handoff:${turnId}:${intent.intentId}`,
          reason: "Intent Flow ownership changed",
        });
        handoffChanged ||= handoff.handedOff;
        if (handoff.handedOff)
          active = { objectiveId: intent.objectiveId, flowDraftId: intent.flowDraftId };
        let protectedTransaction;
        if (intent.action.kind === "acquire_protected_outputs") {
          const identity = missionAuthoringOperationIdentity(turnId, intent.intentId);
          replayedOperation = await this.sessions.replayMissionOperation({
            sessionId,
            operationId: identity.operationId,
          });
          if (!replayedOperation) {
            const reserved = await this.sessions.reserveMissionProtectedOperation({
              sessionId,
              operationId: identity.operationId,
              intent,
            });
            earlyProtectedOperationId = reserved.protectedOperationId;
            const runtime = await this.sessions.runtimeContextFor(sessionId);
            const entryUrl = runtime.lastObservation?.url;
            if (!entryUrl)
              throw new ConflictException({
                code: "MISSION_AUTHORING_PROTECTED_ENTRY_UNAVAILABLE",
              });
            const preparation = await this.sessions.protectedPreparationFor({
              sessionId,
              objectiveId: intent.objectiveId,
              flowDraftId: intent.flowDraftId,
              intentIds: intent.action.preparationIntentIds,
              entryUrl,
            });
            const resolvedSyntheticReferences: Record<string, string> = {};
            for (const preparationIntent of preparation) {
              if (
                preparationIntent.action.kind !== "fill" ||
                !preparationIntent.action.syntheticProtectedSource
              )
                continue;
              if (!this.syntheticInputs)
                throw new ConflictException({
                  code: "SYNTHETIC_PROTECTED_INPUT_RUNTIME_UNAVAILABLE",
                });
              const source = preparationIntent.action.syntheticProtectedSource;
              const materialized = await this.syntheticInputs.materialize({
                protectedOperationId: earlyProtectedOperationId,
                projectId: runtime.projectId,
                environmentId: runtime.environmentId,
                policy: runtime.policy,
                resourceKind: source.resourceKind,
                operation: source.operation,
                declaration: source,
              });
              resolvedSyntheticReferences[preparationIntent.intentId] = materialized.referenceId;
            }
            for (const source of intent.action.syntheticProtectedInputs ?? []) {
              if (!this.syntheticInputs)
                throw new ConflictException({
                  code: "SYNTHETIC_PROTECTED_INPUT_RUNTIME_UNAVAILABLE",
                });
              const materialized = await this.syntheticInputs.materialize({
                protectedOperationId: earlyProtectedOperationId,
                projectId: runtime.projectId,
                environmentId: runtime.environmentId,
                policy: runtime.policy,
                resourceKind: source.resourceKind,
                operation: source.operation,
                declaration: source,
              });
              resolvedSyntheticReferences[`synthetic:${source.semantic}`] =
                materialized.referenceId;
            }
            protectedTransaction = compileMissionAuthoringProtectedTransaction({
              operationId: identity.operationId,
              entryUrl,
              action: intent.action,
              preparation,
              timeoutMs: intent.constraints.timeoutMs,
              resolvedSyntheticReferences,
            });
            protectedReservation = missionAuthoringProtectedOperationReservation(
              protectedTransaction,
              runtime.policy.allowedOrigins,
            );
          }
        }
        const derived =
          replayedOperation ??
          deriveMissionAuthoringOperation({
            turnId,
            intent,
            ...(protectedTransaction ? { protectedTransaction } : {}),
          });
        operation = {
          operationId: derived.operationId,
          idempotencyKey: derived.idempotencyKey,
          action: derived.action,
          expectedEffect: derived.expectedEffect,
          mode: derived.mode,
          protectedInputReferences: intent.protectedInputReferences,
        };
      } catch (error) {
        if (earlyProtectedOperationId) {
          await this.sessions.closeReservedMissionProtectedOperation({
            protectedOperationId: earlyProtectedOperationId,
            reasonCode: "PROTECTED_OPERATION_COMPILATION_FAILED",
          });
        }
        timings.resolveMs += performance.now() - resolveStartedAt;
        const decision = turnResult({
          turnId,
          state: "decision_required",
          completed,
          handoffChanged,
          ...(active ? { active } : {}),
          ...(safeState ? { safeState } : {}),
          startedAt,
          elapsedBaseMs: priorTotalMs,
          timings,
          decisionBoundary: admissionDecisionBoundary(error),
        });
        return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
      }
      const claim = await this.sessions.beginMissionOperation({
        workspaceId: workspaceId(principal),
        sessionId,
        intent,
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        action: operation.action,
        expectedEffect: operation.expectedEffect,
        mode: operation.mode,
        ...(protectedReservation ? { protectedReservation } : {}),
        ...(earlyProtectedOperationId ? { earlyProtectedOperationId } : {}),
      });
      timings.resolveMs += performance.now() - resolveStartedAt;
      if (
        operation.action.type !== "protectedTransaction" &&
        claim.replayed &&
        claim.state === "running"
      ) {
        const disposition = await this.sessions.replayDisposition(
          sessionId,
          operation.operationId,
        );
        if (disposition.requiresReconciliation) {
          await this.sessions.markRunningOperationRecoveryRequired(
            sessionId,
            operation.operationId,
          );
          const decision = turnResult({
            turnId, state: "decision_required", completed, handoffChanged,
            ...(active ? { active } : {}), ...(safeState ? { safeState } : {}),
            startedAt, elapsedBaseMs: priorTotalMs, timings,
            decisionBoundary: {
              type: "mutation_reconciliation_required",
              reasonCode: "ADAPTIVE_OPERATION_RECONCILIATION_REQUIRED",
              safeActions: ["get_flow_authoring", "do_not_retry"],
            },
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
        if (!disposition.canResume) {
          const pending = turnResult({
            turnId, state: "pending", completed, handoffChanged,
            ...(active ? { active } : {}), ...(safeState ? { safeState } : {}),
            startedAt, elapsedBaseMs: priorTotalMs, phase: "operation_running", timings,
          });
          return this.sessions.persistPending({
            sessionId, turnId, result: pending, phase: "operation_running",
            nextIntentIndex: intentIndex,
          });
        }
      }
      if (operation.action.type === "protectedTransaction") {
        if (!claim.replayed) {
          operationsThisAttempt += 1;
          const pending = turnResult({
            turnId,
            state: "pending",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            phase: "protected_operation",
            timings,
          });
          const persisted = await this.sessions.persistPending({
            sessionId,
            turnId,
            result: pending,
            phase: "protected_operation",
            nextIntentIndex: intentIndex,
          });
          this.launchProtectedExecution(sessionId, operation);
          return persisted;
        }
        const projection = await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
        });
        if (projection.status === "pending") {
          // Re-enter the execution kernel for every expired durable active state.
          // Its protected repository claim is the sole authority that fences the
          // prior owner and applies process-loss recovery classification.
          if (!projection.leaseActive) {
            this.launchProtectedExecution(sessionId, operation);
          }
          const pending = turnResult({
            turnId,
            state: "pending",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            phase: "protected_operation",
            timings,
          });
          return this.sessions.persistPending({
            sessionId,
            turnId,
            result: pending,
            phase: "protected_operation",
            nextIntentIndex: intentIndex,
          });
        }
        completed.push(compactSemanticDelta(intent.intentId, projection.outcome, true));
        if (
          projection.outcome.functionalResult !== "succeeded" ||
          projection.outcome.mutationOutcome === "unknown" ||
          projection.decisionBoundary.type !== "objective_completed"
        ) {
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            decisionBoundary: projection.decisionBoundary,
            timings,
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
        continue;
      }
      if (claim.replayed && "outcome" in claim && claim.state !== "running" && claim.outcome) {
        completed.push(
          compactSemanticDelta(intent.intentId, claim.outcome, requiresProtectedInterval(intent)),
        );
        if (
          claim.outcome.functionalResult !== "succeeded" ||
          claim.outcome.mutationOutcome === "unknown"
        ) {
          const decisionBoundary = claim.outcome.nextDecisionBoundary ?? {
            type: "environment_unavailable" as const,
            reasonCode: claim.outcome.reasonCode ?? "ADAPTIVE_SESSION_EXECUTION_FAILED",
            safeActions: ["get_flow_authoring"],
          };
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            decisionBoundary,
            timings,
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
        continue;
      }
      operationsThisAttempt += 1;
      try {
        const remainingMs = Math.floor(budgets.maxDurationMs - (performance.now() - startedAt));
        if (remainingMs < 100) {
          const pending = turnResult({
            turnId, state: "pending", completed, handoffChanged,
            ...(active ? { active } : {}), ...(safeState ? { safeState } : {}),
            startedAt, elapsedBaseMs: priorTotalMs, phase: "budget", timings,
          });
          return this.sessions.persistPending({
            sessionId, turnId, result: pending, phase: "budget", nextIntentIndex: intentIndex,
          });
        }
        const result = await this.executeWithinTurnDeadline(sessionId, operation, remainingMs);
        timings.resolveMs += result.timings.resolveMs;
        timings.executeMs += result.timings.executeMs;
        timings.verifyMs += result.timings.verifyMs;
        safeState = result.safeState;
        const journalStartedAt = performance.now();
        const settled = await this.sessions.settleMissionOperation({
          sessionId,
          operationId: operation.operationId,
          intent,
          action: operation.action,
          ...result,
        });
        timings.journalMs += performance.now() - journalStartedAt;
        completed.push(
          compactSemanticDelta(intent.intentId, settled.outcome, requiresProtectedInterval(intent)),
        );
        if (
          settled.outcome.functionalResult !== "succeeded" ||
          settled.outcome.mutationOutcome === "unknown" ||
          settled.decisionBoundary.type !== "objective_completed"
        ) {
          const decision = turnResult({
            turnId,
            state: "decision_required",
            completed,
            handoffChanged,
            ...(active ? { active } : {}),
            ...(safeState ? { safeState } : {}),
            startedAt,
            elapsedBaseMs: priorTotalMs,
            decisionBoundary: settled.decisionBoundary,
            timings,
          });
          return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
        }
      } catch (error) {
        const code = errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED");
        const failure = await this.sessions.markOperationFailed(
          sessionId,
          operation.operationId,
          code,
        );
        const decision = turnResult({
          turnId,
          state: "decision_required",
          completed,
          handoffChanged,
          ...(active ? { active } : {}),
          ...(safeState ? { safeState } : {}),
          startedAt,
          elapsedBaseMs: priorTotalMs,
          timings,
          decisionBoundary: failure?.decisionBoundary ?? (
            code === "EXECUTION_MODE_POLICY_DENIED"
              ? liveReadPolicyBoundary(intent)
              : {
                  type: "environment_unavailable",
                  reasonCode: code,
                  safeActions: ["get_flow_authoring"],
                }),
        });
        return this.settleTurn(sessionId, turnId, decision, timings, startedAt);
      }
    }
    return this.settleTurn(
      sessionId,
      turnId,
      turnResult({
        turnId,
        state: "completed",
        completed,
        handoffChanged,
        ...(active ? { active } : {}),
        ...(safeState ? { safeState } : {}),
        startedAt,
        elapsedBaseMs: priorTotalMs,
        timings,
      }),
      timings,
      startedAt,
    );
  }

  private async settleTurn(
    sessionId: string,
    turnId: string,
    result: MissionAuthoringTurnResult,
    timings: { resolveMs: number; executeMs: number; verifyMs: number; journalMs: number },
    startedAt: number,
  ) {
    void timings;
    void startedAt;
    return this.sessions.settleTurn({ sessionId, turnId, result });
  }

  private async executeWithOnePreDispatchRetry(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    signal?: AbortSignal,
  ) {
    try {
      return await this.runner.execute(sessionId, operation, signal);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error &&
        "preDispatchTransient" in error &&
        error.preDispatchTransient === true
      ))
        throw error;
      return this.runner.execute(sessionId, operation, signal);
    }
  }

  private async executeWithinTurnDeadline(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    remainingMs: number,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("AUTHORING_TURN_BUDGET_EXHAUSTED"));
      void this.runner.cancelActiveOperation(sessionId);
    }, remainingMs);
    timeout.unref();
    const bounded = {
      ...operation,
      action: clampActionTimeout(operation.action, remainingMs),
    } satisfies AdaptiveSessionOperationInput;
    try {
      return await this.executeWithOnePreDispatchRetry(sessionId, bounded, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private launchProtectedExecution(sessionId: string, operation: AdaptiveSessionOperationInput) {
    const key = `${sessionId}:${operation.operationId}`;
    if (this.inFlightProtectedOperations.has(key)) return;
    const work = (async () => {
      try {
        await this.executeWithOnePreDispatchRetry(sessionId, operation);
        await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
        });
      } catch (error) {
        await this.sessions.projectProtectedOperationForAuthoring({
          sessionId,
          operationId: operation.operationId,
          missingFailureCode: errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED"),
        });
      }
    })();
    this.inFlightProtectedOperations.set(key, work);
    const release = () => {
      if (this.inFlightProtectedOperations.get(key) === work)
        this.inFlightProtectedOperations.delete(key);
    };
    void work.then(release, release);
  }

  async close(principal: Principal, sessionId: string, idempotencyKey: string) {
    this.requireWrite(principal);
    try {
      return await this.sessions.closeAtSafeBoundary({
        workspaceId: workspaceId(principal),
        sessionId,
        idempotencyKey,
      });
    } finally {
      // A durable unknown-mutation conflict must remain visible to the caller,
      // but it cannot leave this process owning a browser or runtime lease.
      await this.runner.close(sessionId);
    }
  }

  private requireWrite(principal: Principal) {
    if (principal.kind === "user" && principal.role === "viewer") {
      throw new ForbiddenException("Workspace viewers have read-only access");
    }
  }
}

function liveReadPolicyBoundary(
  intent: import("@scry/contracts").MissionAuthoringIntent,
): NonNullable<MissionAuthoringTurnResult["decisionBoundary"]> {
  const semanticEffect =
    intent.action.kind === "activate" ? (intent.action.semanticEffect ?? "unknown") : "resource_mutation";
  const readContext = semanticEffect === "read_context_transition";
  return {
    type: "policy_refused",
    reasonCode: "EXECUTION_MODE_POLICY_DENIED",
    safeActions: [],
    policyContext: {
      governingMode: "observe",
      requestedSemanticEffect: semanticEffect,
      gesture: intent.action.kind,
      effectApplied: false,
      strongerAuthorityCouldPermit: semanticEffect === "resource_mutation",
      recoverable: false,
      explanation: readContext
        ? "The declared read-context transition was not admitted; no dispatch occurred."
        : "Live-read authority does not permit resource mutations or interactions without a proven read-context-only effect.",
    },
  };
}

function workspaceId(principal: Principal) {
  return principal.kind === "user" ? principal.workspaceId : null;
}

function clampActionTimeout(action: CurrentAction, remainingMs: number): CurrentAction {
  if (!("timeoutMs" in action)) return action;
  return {
    ...action,
    timeoutMs: Math.max(100, Math.min(action.timeoutMs ?? remainingMs, remainingMs)),
  } as CurrentAction;
}

function errorCode(error: unknown, fallback: string) {
  const valid = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value);
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (valid(code)) return code;
  }
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: unknown }).response;
    if (typeof response === "object" && response && "code" in response) {
      const code = (response as { code?: unknown }).code;
      if (valid(code)) return code;
    }
  }
  return error instanceof Error && valid(error.message) ? error.message : fallback;
}

function admissionDecisionBoundary(
  error: unknown,
): NonNullable<MissionAuthoringTurnResult["decisionBoundary"]> {
  const code = errorCode(error, "MISSION_AUTHORING_ADMISSION_FAILED");
  if (code === "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED") {
    return {
      type: "authorization_required",
      reasonCode: code,
      safeActions: ["authorize_environment_credentials", "advance_flow_authoring"],
    };
  }
  if (code.includes("ORIGIN_NOT_ALLOWED") || code.includes("AUTHORIZATION")) {
    return { type: "policy_refused", reasonCode: code, safeActions: [] };
  }
  return {
    type: "environment_unavailable",
    reasonCode: code,
    safeActions: ["advance_flow_authoring"],
  };
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
      state: outcome.evidenceResult.some((channel) => channel.state === "failed")
        ? "failed"
        : outcome.evidenceResult.some((channel) => channel.state === "quarantined")
          ? "quarantined"
          : outcome.evidenceResult.some((channel) => channel.state === "suppressed")
            ? "suppressed"
            : "available",
      count: outcome.evidenceResult.length,
      reasonCodes: outcome.evidenceResult
        .flatMap((channel) => (channel.reasonCode ? [channel.reasonCode] : []))
        .slice(0, 8),
    },
    semanticEvidence: {
      count: outcome.resolvedTarget ? 1 : 0,
      ...(outcome.resolvedTarget ? { resolvedTarget: outcome.resolvedTarget } : {}),
    },
    ...(outcome.semanticPageContext ? { semanticPageContext: outcome.semanticPageContext } : {}),
    quality: {
      findingCount: outcome.qualityFindings.length,
      reasonCodes: outcome.qualityFindings
        .flatMap((finding) =>
          typeof finding.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(finding.code)
            ? [finding.code]
            : [],
        )
        .slice(0, 8),
    },
    ...(outcome.generatedReferences ? { generatedReferences: outcome.generatedReferences } : {}),
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
  const evidenceFailed = input.completed.some(
    (delta) => delta.evidence.state === "failed" || delta.evidence.state === "quarantined",
  );
  return {
    turnId: input.turnId,
    state: input.state,
    completed: input.completed,
    stateDelta: {
      ...(input.handoffChanged && input.active
        ? {
            activeObjectiveId: input.active.objectiveId,
            activeFlowDraftId: input.active.flowDraftId,
          }
        : {}),
      ...(input.safeState
        ? { url: input.safeState.url, documentEpoch: input.safeState.documentEpoch }
        : {}),
    },
    channels: {
      functional: { state: input.state === "pending" ? "pending" : failed ? "failed" : "passed" },
      mutation: { state: unknown ? "failed" : "passed" },
      privacy: privacyChannel(input.completed),
      evidence: {
        state: input.state === "pending" ? "pending" : evidenceFailed ? "failed" : "passed",
      },
      quality: {
        state: "passed",
        ...(input.completed.some((delta) => delta.quality.findingCount > 0)
          ? { reasonCode: "QUALITY_FINDINGS_PRESENT" }
          : {}),
      },
    },
    timings: {
      resolveMs: Math.round(input.timings.resolveMs),
      executeMs: Math.round(input.timings.executeMs),
      verifyMs: Math.round(input.timings.verifyMs),
      journalMs: Math.round(input.timings.journalMs),
      totalMs: Math.round((input.elapsedBaseMs ?? 0) + performance.now() - input.startedAt),
    },
    decisionBoundary: input.decisionBoundary ?? null,
    ...(input.state === "pending"
      ? { continuation: { turnId: input.turnId, phase: input.phase ?? "resume" } }
      : {}),
  };
}

function privacyChannel(
  completed: MissionAuthoringTurnResult["completed"],
): MissionAuthoringTurnResult["channels"]["privacy"] {
  const privacy = completed
    .filter((delta) => delta.privacyApplicable)
    .map((delta) => delta.privacyResult);
  if (!privacy.length) return { state: "not_applicable" };
  if (privacy.includes("degraded")) return { state: "failed", reasonCode: "PRIVACY_DEGRADED" };
  if (privacy.includes("unverified")) return { state: "failed", reasonCode: "PRIVACY_UNVERIFIED" };
  return { state: "passed" };
}

function requiresProtectedInterval(intent: MissionAuthoringIntent) {
  return (
    (intent.action.kind === "fill" && Boolean(intent.action.protectedReferenceId)) ||
    intent.action.kind === "same_origin_request"
  );
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
