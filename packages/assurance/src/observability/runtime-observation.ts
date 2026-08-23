import type { AssuranceEvidenceRef } from "../core/types.js";
import type { AssuranceMetric } from "./primitives.js";
import {
  runtimeObservationEvidence,
  type CapabilityEvidenceRecord,
} from "../support/classification.js";

export type RuntimeObservationOutcome = "succeeded" | "failed" | "inconclusive";

export interface RuntimeEnvironmentDimensions {
  application?: string;
  controlType?: string;
  frameworkBehavior?: string;
  pageLifecycle?: string;
  navigationBehavior?: string;
  authStyle?: string;
  acquisitionMethod?: string;
  mutationSemantics?: string;
  journeyDepth?: number;
  failureRecoveryClass?: string;
}

export interface RuntimeObservation {
  id: string;
  capability: string;
  outcome: RuntimeObservationOutcome;

  /**
   * Safe factual evidence only.
   *
   * Assurance does not accept raw browser state, secrets,
   * DOM dumps, credentials, or opaque runtime objects here.
   */
  evidence: readonly AssuranceEvidenceRef[];

  environment?: RuntimeEnvironmentDimensions;

  metrics?: readonly AssuranceMetric[];

  facts?: Readonly<{
    nativeResolutionSucceeded?: boolean;
    praxisFallbackRequired?: boolean;
    targetAmbiguityEncountered?: boolean;
    semanticTurns?: number;
    continuationRounds?: number;
    unexpectedDocumentEpoch?: boolean;
    recoveryRequired?: boolean;
    browserCleanupEscalated?: boolean;
  }>;

  failureClass?: string;
  summary?: string;
}

export interface RuntimeObservationValidation {
  valid: boolean;
  reasonCodes: readonly string[];
}

export function validateRuntimeObservation(
  observation: RuntimeObservation,
): RuntimeObservationValidation {
  const reasonCodes: string[] = [];

  if (!observation.id.trim()) {
    reasonCodes.push("RUNTIME_OBSERVATION_ID_REQUIRED");
  }

  if (!observation.capability.trim()) {
    reasonCodes.push("RUNTIME_OBSERVATION_CAPABILITY_REQUIRED");
  }

  if (observation.evidence.length === 0) {
    reasonCodes.push("RUNTIME_OBSERVATION_EVIDENCE_REQUIRED");
  }

  if (
    observation.environment?.journeyDepth !== undefined &&
    (!Number.isInteger(observation.environment.journeyDepth) ||
      observation.environment.journeyDepth < 0)
  ) {
    reasonCodes.push("RUNTIME_OBSERVATION_JOURNEY_DEPTH_INVALID");
  }

  for (const metric of observation.metrics ?? []) {
    if (!metric.name.trim() || !Number.isFinite(metric.value)) {
      reasonCodes.push("RUNTIME_OBSERVATION_METRIC_INVALID");
      break;
    }
  }

  for (const value of [observation.facts?.semanticTurns, observation.facts?.continuationRounds]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      reasonCodes.push("RUNTIME_OBSERVATION_COUNT_INVALID");
      break;
    }
  }

  return {
    valid: reasonCodes.length === 0,
    reasonCodes,
  };
}

export function runtimeObservationToCapabilityEvidence(
  observation: RuntimeObservation,
): CapabilityEvidenceRecord {
  const validation = validateRuntimeObservation(observation);

  if (!validation.valid) {
    throw new Error(["ASSURANCE_RUNTIME_OBSERVATION_INVALID", ...validation.reasonCodes].join(":"));
  }

  return runtimeObservationEvidence({
    id: observation.id,
    capability: observation.capability,
    status:
      observation.outcome === "succeeded"
        ? "pass"
        : observation.outcome === "failed"
          ? "fail"
          : "inconclusive",
    evidence: observation.evidence,
    ...(observation.summary ? { summary: observation.summary } : {}),
  });
}
