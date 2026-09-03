import type { AssuranceMetric } from "../observability/primitives.js";
import {
  runtimeObservationToCapabilityEvidence,
  validateRuntimeObservation,
  type RuntimeObservation,
  type RuntimeObservationValidation,
} from "../observability/runtime-observation.js";
import type { CapabilityEvidenceRecord } from "../support/classification.js";

export interface ExperienceCorpusSummary {
  observationCount: number;
  capabilities: readonly string[];
  failureClasses: Readonly<Record<string, number>>;
  fallbackCount: number;
  recoveryCount: number;
  ambiguityCount: number;
  cleanupEscalationCount: number;
  metrics: Readonly<
    Record<
      string,
      {
        count: number;
        min: number;
        max: number;
        average: number;
      }
    >
  >;
}

export class ExperienceCorpus {
  readonly #observations = new Map<string, RuntimeObservation>();

  ingest(observation: RuntimeObservation): RuntimeObservationValidation {
    const validation = validateRuntimeObservation(observation);

    if (!validation.valid) {
      return validation;
    }

    const existing = this.#observations.get(observation.id);

    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      return {
        valid: false,
        reasonCodes: ["RUNTIME_OBSERVATION_ID_CONFLICT"],
      };
    }

    this.#observations.set(observation.id, observation);

    return {
      valid: true,
      reasonCodes: [],
    };
  }

  observations(): readonly RuntimeObservation[] {
    return [...this.#observations.values()];
  }

  capabilityEvidence(): readonly CapabilityEvidenceRecord[] {
    return this.observations().map(runtimeObservationToCapabilityEvidence);
  }

  observationsForCapability(capability: string): readonly RuntimeObservation[] {
    return this.observations().filter((observation) => observation.capability === capability);
  }

  summary(): ExperienceCorpusSummary {
    const observations = this.observations();

    const failureClasses = new Map<string, number>();

    const metrics = new Map<string, number[]>();

    let fallbackCount = 0;
    let recoveryCount = 0;
    let ambiguityCount = 0;
    let cleanupEscalationCount = 0;

    for (const observation of observations) {
      if (observation.failureClass) {
        failureClasses.set(
          observation.failureClass,
          (failureClasses.get(observation.failureClass) ?? 0) + 1,
        );
      }

      if (observation.facts?.praxisFallbackRequired) {
        fallbackCount += 1;
      }

      if (observation.facts?.recoveryRequired) {
        recoveryCount += 1;
      }

      if (observation.facts?.targetAmbiguityEncountered) {
        ambiguityCount += 1;
      }

      if (observation.facts?.browserCleanupEscalated) {
        cleanupEscalationCount += 1;
      }

      collectMetrics(metrics, observation.metrics ?? []);
    }

    return {
      observationCount: observations.length,

      capabilities: [...new Set(observations.map(({ capability }) => capability))].sort(),

      failureClasses: Object.fromEntries(
        [...failureClasses.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),

      fallbackCount,
      recoveryCount,
      ambiguityCount,
      cleanupEscalationCount,

      metrics: Object.fromEntries(
        [...metrics.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, values]) => [name, distribution(values)]),
      ),
    };
  }
}

function collectMetrics(target: Map<string, number[]>, metrics: readonly AssuranceMetric[]): void {
  for (const metric of metrics) {
    const values = target.get(metric.name) ?? [];

    values.push(metric.value);

    target.set(metric.name, values);
  }
}

function distribution(values: readonly number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: values.length > 0 ? total / values.length : 0,
  };
}
