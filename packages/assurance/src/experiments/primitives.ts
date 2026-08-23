import type {
  AssuranceDescriptor,
  AssuranceEvidenceRef,
  AssuranceStatus,
  MaybePromise,
} from "../core/types.js";
import type { AssuranceMetric } from "../observability/primitives.js";
import {
  runVerificationAttempts,
  type VerificationCase,
  type VerificationExecution,
} from "../verification/primitives.js";

export type ExperimentVariantRole = "baseline" | "candidate";

export interface ExperimentVariant<TContext> extends AssuranceDescriptor {
  role: ExperimentVariantRole;

  /**
   * Produces the context in which the exact same verification
   * is evaluated for this controlled variant.
   */
  prepare(baseContext: TContext): MaybePromise<TContext>;
}

export interface ExperimentDefinition<TContext> extends AssuranceDescriptor {
  hypothesis: string;

  verification: VerificationCase<TContext>;

  variants: readonly ExperimentVariant<TContext>[];

  attemptsPerVariant?: number;

  /**
   * Optional factual measurements.
   *
   * Measurements are evidence for comparison, not a production
   * architecture decision.
   */
  measure?(
    context: TContext,
    execution: VerificationExecution,
  ): MaybePromise<readonly AssuranceMetric[]>;
}

export interface ExperimentVariantResult extends AssuranceDescriptor {
  role: ExperimentVariantRole;
  verification: VerificationExecution;
  metrics: readonly AssuranceMetric[];
}

export interface ExperimentResult extends AssuranceDescriptor {
  hypothesis: string;

  /**
   * "complete" means every variant produced a conclusive
   * verification result.
   *
   * A candidate legitimately failing its verification is still
   * a complete experiment: that failure is useful evidence.
   */
  executionStatus: "complete" | "inconclusive";

  variants: readonly ExperimentVariantResult[];

  evidence: readonly AssuranceEvidenceRef[];
}

export function defineExperiment<TContext>(
  definition: ExperimentDefinition<TContext>,
): ExperimentDefinition<TContext> {
  validateExperimentDefinition(definition);

  return definition;
}

export async function runExperiment<TContext>(
  experiment: ExperimentDefinition<TContext>,
  baseContext: TContext,
): Promise<ExperimentResult> {
  validateExperimentDefinition(experiment);

  const attempts = experiment.attemptsPerVariant ?? 1;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("ASSURANCE_EXPERIMENT_ATTEMPT_COUNT_INVALID");
  }

  const variants: ExperimentVariantResult[] = [];

  for (const variant of experiment.variants) {
    const context = await variant.prepare(baseContext);

    const verification = await runVerificationAttempts(experiment.verification, context, attempts);

    const metrics = experiment.measure
      ? [...(await experiment.measure(context, verification))]
      : [];

    variants.push({
      id: variant.id,
      title: variant.title,
      role: variant.role,
      verification,
      metrics,

      ...(variant.description
        ? {
            description: variant.description,
          }
        : {}),

      ...(variant.tags
        ? {
            tags: variant.tags,
          }
        : {}),
    });
  }

  const executionStatus = variants.every(({ verification }) => isConclusive(verification.status))
    ? "complete"
    : "inconclusive";

  return {
    id: experiment.id,
    title: experiment.title,
    hypothesis: experiment.hypothesis,
    executionStatus,
    variants,
    evidence: dedupeEvidence(variants.flatMap(({ verification }) => verification.evidence)),

    ...(experiment.description
      ? {
          description: experiment.description,
        }
      : {}),

    ...(experiment.tags
      ? {
          tags: experiment.tags,
        }
      : {}),
  };
}

function validateExperimentDefinition<TContext>(experiment: ExperimentDefinition<TContext>): void {
  if (experiment.variants.length < 2) {
    throw new Error("ASSURANCE_EXPERIMENT_VARIANTS_REQUIRED");
  }

  const baselineCount = experiment.variants.filter(({ role }) => role === "baseline").length;

  if (baselineCount !== 1) {
    throw new Error("ASSURANCE_EXPERIMENT_SINGLE_BASELINE_REQUIRED");
  }

  const identifiers = experiment.variants.map(({ id }) => id);

  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("ASSURANCE_EXPERIMENT_VARIANT_ID_DUPLICATE");
  }
}

function isConclusive(status: AssuranceStatus): boolean {
  return status === "pass" || status === "fail";
}

function dedupeEvidence(input: readonly AssuranceEvidenceRef[]): readonly AssuranceEvidenceRef[] {
  const result: AssuranceEvidenceRef[] = [];

  const seen = new Set<string>();

  for (const item of input) {
    const key = [item.source, item.kind, item.ref].join("\u0000");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}
