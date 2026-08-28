import { createHash } from "node:crypto";

import type { Q2CausalEnvelope, Q2SafeScope, Q2Scenario } from "./types.js";
import type { Q1Snapshot } from "../q1/types.js";

export function createCausalEnvelope(
  scenario: Q2Scenario,
  snapshot: Q1Snapshot,
  scope: Q2SafeScope,
  safeCauseRef: string,
): Q2CausalEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    phase: scenario.phase,
    component: scenario.component,
    reasonCode: `Q2_${scenario.boundary}_${scenario.failpoint.effect}`.toUpperCase(),
    causeCategory: scenario.causeCategory,
    dispatchBoundary: scenario.dispatchCategory,
    truth: Object.freeze({
      functional: snapshot.operation.functionalTruth,
      mutation: snapshot.operation.mutationTruth,
      privacy: snapshot.truth.privacy,
      evidence: snapshot.truth.evidence,
      runtime: snapshot.truth.runtime,
    }),
    retryClass: scenario.retryClass,
    causality: Object.freeze({ ...scope }),
    safeCauseRef,
  });
}

export function publicCausalProjection(envelope: Q2CausalEnvelope) {
  return Object.freeze({
    schemaVersion: envelope.schemaVersion,
    reasonCode: envelope.reasonCode,
    phase: envelope.phase,
    causeCategory: envelope.causeCategory,
    dispatchBoundary: envelope.dispatchBoundary,
    retryClass: envelope.retryClass,
    correlationId: envelope.causality.correlationId,
    safeCauseRef: createHash("sha256").update(envelope.safeCauseRef).digest("hex"),
  });
}
