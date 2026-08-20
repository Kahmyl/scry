import type {
  AssuranceDescriptor,
  AssuranceEvidenceRef,
  AssuranceStatus,
  MaybePromise,
} from "../core/types.js";

import {
  normalizeVerificationResult,
  notRunResult,
  type VerificationObservation,
  type VerificationResult,
} from "../core/results.js";

export interface VerificationCase<TContext = undefined> extends AssuranceDescriptor {
  /**
   * Explicit factual claim this verification attempts to establish.
   */
  claim: string;

  /**
   * Oracle that evaluates the claim.
   *
   * Where practical, the subsystem under test must not be the
   * sole source of truth for whether it succeeded.
   */
  oracle(context: TContext): MaybePromise<VerificationObservation>;
}

export interface VerificationAttempt {
  attempt: number;
  result: VerificationResult;
}

export interface VerificationExecution extends AssuranceDescriptor {
  claim: string;
  status: AssuranceStatus;
  evidence: readonly AssuranceEvidenceRef[];
  attempts: readonly VerificationAttempt[];
  summary?: string;
  reasonCode?: string;
}

export function defineVerification<TContext = undefined>(
  definition: VerificationCase<TContext>,
): VerificationCase<TContext> {
  return definition;
}

export async function runVerification<TContext>(
  verification: VerificationCase<TContext>,
  context: TContext,
): Promise<VerificationExecution> {
  return runVerificationAttempts(verification, context, 1);
}

export async function runVerificationAttempts<TContext>(
  verification: VerificationCase<TContext>,
  context: TContext,
  attemptCount: number,
): Promise<VerificationExecution> {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error("ASSURANCE_ATTEMPT_COUNT_INVALID");
  }

  const attempts: VerificationAttempt[] = [];

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    let result: VerificationResult;

    try {
      result = normalizeVerificationResult(await verification.oracle(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      result = {
        status: "inconclusive",
        reasonCode: "ORACLE_ERROR",
        summary: message,
        evidence: [
          {
            source: "assurance",
            kind: "oracle-error",
            ref: error instanceof Error ? error.name : "unknown-error",
            description: message,
          },
        ],
      };
    }

    attempts.push({
      attempt,
      result,
    });
  }

  const distinctStatuses = new Set(attempts.map(({ result }) => result.status));

  let status: AssuranceStatus;
  let reasonCode: string | undefined;

  if (distinctStatuses.size === 1) {
    status = attempts[0]!.result.status;
  } else {
    status = "inconclusive";
    reasonCode = "MIXED_ATTEMPT_OUTCOMES";
  }

  const evidence = attempts.flatMap(({ result }) => result.evidence);

  const summary = attempts.length === 1 ? attempts[0]!.result.summary : undefined;

  return {
    id: verification.id,
    title: verification.title,
    claim: verification.claim,
    status,
    evidence,
    attempts,

    ...(verification.description ? { description: verification.description } : {}),

    ...(verification.tags ? { tags: verification.tags } : {}),

    ...(summary ? { summary } : {}),

    ...(reasonCode
      ? { reasonCode }
      : attempts[0]?.result.reasonCode
        ? { reasonCode: attempts[0].result.reasonCode }
        : {}),
  };
}

export function notRunVerification(
  verification: VerificationCase<unknown>,
  reasonCode = "NOT_RUN",
): VerificationExecution {
  const result = notRunResult(reasonCode);

  return {
    id: verification.id,
    title: verification.title,
    claim: verification.claim,
    status: result.status,
    evidence: [],
    attempts: [],
    reasonCode,

    ...(verification.description ? { description: verification.description } : {}),

    ...(verification.tags ? { tags: verification.tags } : {}),
  };
}
