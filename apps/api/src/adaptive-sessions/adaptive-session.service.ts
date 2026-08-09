import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type {
  AdaptiveSessionTransitionInput,
  AdaptiveSessionOperationInput,
  AdvanceAdaptiveSessionInput,
  StartAdaptiveSessionInput,
} from "@scry/contracts";

import type { Principal } from "../auth/index.js";
import { ReleaseAdmissionService } from "../runtime/index.js";
import { AdaptiveSessionKernelRunner } from "./adaptive-session-kernel.runner.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";

@Injectable()
export class AdaptiveSessionService {
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

  async advance(principal: Principal, sessionId: string, input: AdvanceAdaptiveSessionInput) {
    await this.admission.assertAcceptingWork();
    this.requireWrite(principal);
    if ("operations" in input) {
      const startedAt = performance.now();
      const operationsCompleted = [];
      for (const operation of input.operations) {
        if (performance.now() - startedAt >= input.budgets.maxDurationMs) {
          return {
            operationsCompleted,
            decisionBoundary: {
              type: "turn_budget_exhausted" as const,
              reasonCode: "ADAPTIVE_TURN_DURATION_BUDGET_EXHAUSTED",
              safeActions: ["advance_session"],
            },
          };
        }
        const result = await this.advanceOne(principal, sessionId, operation);
        operationsCompleted.push(compactOperationDelta(result));
        if (
          result.state === "running" ||
          ("outcome" in result &&
            result.outcome &&
            (result.outcome.functionalResult !== "succeeded" ||
              result.outcome.mutationOutcome === "unknown" ||
              result.outcome.nextDecisionBoundary))
        ) {
          return {
            operationsCompleted,
            decisionBoundary:
              "decisionBoundary" in result && result.decisionBoundary
                ? result.decisionBoundary
                : {
                    type: "environment_unavailable" as const,
                    reasonCode: "ADAPTIVE_OPERATION_IN_PROGRESS",
                    safeActions: ["get_adaptive_session"],
                  },
          };
        }
      }
      return {
        operationsCompleted,
        decisionBoundary: {
          type: "objective_completed" as const,
          reasonCode: "ADAPTIVE_TURN_COMPLETED",
          safeActions: [],
        },
        durationMs: performance.now() - startedAt,
      };
    }
    return this.advanceOne(principal, sessionId, input);
  }

  private async advanceOne(
    principal: Principal,
    sessionId: string,
    input: AdaptiveSessionOperationInput,
  ) {
    const claim = await this.sessions.beginOperation(workspaceId(principal), sessionId, input);
    if (claim.replayed) {
      if (claim.state === "running") {
        const disposition = await this.sessions.replayDisposition(sessionId, input.operationId);
        if (!disposition.requiresReconciliation && !disposition.canResume) {
          return {
            operationId: input.operationId,
            state: "running",
            dispatchBoundary: disposition.dispatchBoundary,
            replayed: true,
          };
        }
        if (disposition.requiresReconciliation) {
          await this.sessions.markRunningOperationRecoveryRequired(sessionId, input.operationId);
          throw new ConflictException({
            code: "ADAPTIVE_OPERATION_RECONCILIATION_REQUIRED",
            mutationOutcome: "unknown",
            safeActions: ["get_adaptive_session", "cancel_adaptive_session"],
          });
        }
      }
      if (claim.state !== "running") return claim;
    }
    try {
      const result = await this.runner.execute(sessionId, input);
      return {
        operationId: input.operationId,
        replayed: claim.replayed,
        ...(await this.sessions.settleOperation({
          sessionId,
          operationId: input.operationId,
          ...result,
        })),
      };
    } catch (error) {
      await Promise.resolve(this.runner.close(sessionId)).catch(() => undefined);
      const code = errorCode(error, "ADAPTIVE_SESSION_EXECUTION_FAILED");
      await this.sessions.markOperationFailed(sessionId, input.operationId, code);
      throw new ConflictException({
        code,
        safeActions: ["get_adaptive_session", "advance_adaptive_session"],
      });
    }
  }

  async suspend(principal: Principal, sessionId: string, input: AdaptiveSessionTransitionInput) {
    this.requireWrite(principal);
    const result = await this.sessions.transition({
      workspaceId: workspaceId(principal),
      sessionId,
      ...input,
      target: "suspended",
      eventType: "session_suspended",
    });
    await this.runner.close(sessionId);
    return result;
  }

  resume(principal: Principal, sessionId: string, input: AdaptiveSessionTransitionInput) {
    this.requireWrite(principal);
    return this.sessions.transition({
      workspaceId: workspaceId(principal),
      sessionId,
      ...input,
      target: "active",
      eventType: "session_resumed",
    });
  }

  async cancel(principal: Principal, sessionId: string, input: AdaptiveSessionTransitionInput) {
    this.requireWrite(principal);
    const result = await this.sessions.transition({
      workspaceId: workspaceId(principal),
      sessionId,
      ...input,
      target: "cancelled",
      eventType: "session_cancelled",
    });
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

function compactOperationDelta(result: Record<string, unknown>) {
  const outcome =
    result.outcome && typeof result.outcome === "object"
      ? (result.outcome as Record<string, unknown>)
      : undefined;
  return {
    operationId: result.operationId,
    state: result.state,
    replayed: result.replayed,
    ...(outcome
      ? {
          functionalResult: outcome.functionalResult,
          mutationOutcome: outcome.mutationOutcome,
          privacyResult: outcome.privacyResult,
          ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
          ...(outcome.resolvedTarget ? { resolvedTarget: outcome.resolvedTarget } : {}),
          qualityFindingCount: Array.isArray(outcome.qualityFindings)
            ? outcome.qualityFindings.length
            : 0,
          evidenceChannelCount: Array.isArray(outcome.evidenceResult)
            ? outcome.evidenceResult.length
            : 0,
        }
      : {}),
  };
}
