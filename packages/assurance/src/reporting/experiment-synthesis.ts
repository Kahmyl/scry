import type { AssuranceMetric } from "../observability/primitives.js";
import type { ExperimentResult, ExperimentVariantResult } from "../experiments/primitives.js";

export interface ExperimentMetricComparison {
  name: string;
  unit?: string;
  baselineAverage: number;
  candidateAverage: number;
  delta: number;
}

export interface ExperimentVariantComparison {
  variantId: string;
  verificationStatus: ExperimentVariantResult["verification"]["status"];
  evidenceCount: number;
  metrics: readonly ExperimentMetricComparison[];
}

export interface ExperimentSynthesis {
  experimentId: string;
  hypothesis: string;

  executionStatus: ExperimentResult["executionStatus"];

  baselineVariantId: string;

  candidates: readonly ExperimentVariantComparison[];

  /**
   * Assurance intentionally does not convert comparative evidence
   * into a production architecture decision.
   */
  productionDecision: "undetermined";
}

export function synthesizeExperiment(experiment: ExperimentResult): ExperimentSynthesis {
  const baseline = experiment.variants.find(({ role }) => role === "baseline");

  if (!baseline) {
    throw new Error("ASSURANCE_EXPERIMENT_BASELINE_RESULT_REQUIRED");
  }

  const baselineMetrics = summarizeMetrics(baseline.metrics);

  const candidates = experiment.variants
    .filter(({ role }) => role === "candidate")
    .map((candidate): ExperimentVariantComparison => ({
      variantId: candidate.id,

      verificationStatus: candidate.verification.status,

      evidenceCount: candidate.verification.evidence.length,

      metrics: compareMetrics(baselineMetrics, summarizeMetrics(candidate.metrics)),
    }));

  return {
    experimentId: experiment.id,

    hypothesis: experiment.hypothesis,

    executionStatus: experiment.executionStatus,

    baselineVariantId: baseline.id,

    candidates,

    productionDecision: "undetermined",
  };
}

interface MetricSummary {
  name: string;
  unit?: string;
  average: number;
}

function summarizeMetrics(metrics: readonly AssuranceMetric[]): ReadonlyMap<string, MetricSummary> {
  const values = new Map<
    string,
    {
      name: string;
      unit?: string;
      values: number[];
    }
  >();

  for (const metric of metrics) {
    const key = metricKey(metric.name, metric.unit);

    const group = values.get(key) ?? {
      name: metric.name,
      ...(metric.unit
        ? {
            unit: metric.unit,
          }
        : {}),
      values: [],
    };

    group.values.push(metric.value);

    values.set(key, group);
  }

  return new Map(
    [...values.entries()].map(([key, group]) => [
      key,
      {
        name: group.name,

        ...(group.unit
          ? {
              unit: group.unit,
            }
          : {}),

        average: group.values.reduce((sum, value) => sum + value, 0) / group.values.length,
      },
    ]),
  );
}

function compareMetrics(
  baseline: ReadonlyMap<string, MetricSummary>,
  candidate: ReadonlyMap<string, MetricSummary>,
): readonly ExperimentMetricComparison[] {
  const result: ExperimentMetricComparison[] = [];

  for (const [key, baselineMetric] of baseline) {
    const candidateMetric = candidate.get(key);

    if (!candidateMetric) {
      continue;
    }

    result.push({
      name: baselineMetric.name,

      ...(baselineMetric.unit
        ? {
            unit: baselineMetric.unit,
          }
        : {}),

      baselineAverage: baselineMetric.average,

      candidateAverage: candidateMetric.average,

      delta: candidateMetric.average - baselineMetric.average,
    });
  }

  return result.sort((left, right) =>
    metricKey(left.name, left.unit).localeCompare(metricKey(right.name, right.unit)),
  );
}

function metricKey(name: string, unit?: string): string {
  return `${name}\u0000${unit ?? ""}`;
}
