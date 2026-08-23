import {
  buildOperationalEvent,
  createFanOutOperationalEventSink,
  OperationalEventEmitter,
  type OperationalCausality,
  type OperationalEvent,
} from "@scry/observability";
import { describe, expect, it, vi } from "vitest";

import {
  ExperienceCorpus,
  observabilityFaultMatrix,
  observabilityQualificationToRuntimeObservation,
  qualifyObservabilityFault,
  type AssuranceEvidenceRef,
  type ObservabilityFaultCase,
  type ObservabilityFaultObservation,
} from "../src/index.js";

const injectedAt = "2026-08-23T12:00:00.000Z";
const availableAt = "2026-08-23T12:00:00.100Z";
const causalContext: Record<keyof OperationalCausality, string> = {
  projectId: "project-qualification",
  workspaceId: "workspace-qualification",
  missionId: "mission-qualification",
  objectiveId: "objective-qualification",
  agentSessionId: "agent-qualification",
  mcpSessionId: "mcp-qualification",
  runId: "run-qualification",
  attemptId: "attempt-qualification",
  praxisSessionId: "praxis-qualification",
  operationId: "operation-qualification",
  protectedOperationId: "protected-qualification",
  correlationId: "correlation-qualification",
  browserContextId: "browser-context-qualification",
  documentAuthorityId: "document-authority-qualification",
};

function evidence(kind: string, ref: string): AssuranceEvidenceRef {
  return { source: "fixture", kind, ref };
}

function passingObservation(scenario: ObservabilityFaultCase): ObservabilityFaultObservation {
  return {
    caseId: scenario.id,
    injectedAt,
    causalContext,
    productTruth: {
      value: scenario.expectedTruth,
      evidence: [evidence("durable-product-truth", `${scenario.id}:truth`)],
    },
    operationalEvents: scenario.requiredEvents.map((required, index) => ({
      event: buildOperationalEvent({
        component: required.component,
        releaseId: "qualification-release",
        schemaFingerprint: "qualification-schema",
        now: () => new Date(injectedAt),
        input: {
          name: required.name,
          classification: required.classification,
          reasonCode: required.reasonCode,
          outcome: required.outcome,
          causality: Object.fromEntries(
            required.causalIdentifiers.map((identifier) => [identifier, causalContext[identifier]]),
          ),
          ...(required.durationRequired ? { durationMs: 25 } : {}),
          ...(required.transition ? { transition: required.transition } : {}),
          ...(required.details ? { details: required.details } : {}),
        },
      }),
      availableAt,
      channel: scenario.id === "observability_sink_failure" ? "stdout_fallback" : "durable_store",
      evidence: [evidence("operational-event", `${scenario.id}:event:${index}`)],
    })),
    safeAction: {
      value: scenario.safeAction,
      evidence: [evidence("safe-action", `${scenario.id}:action`)],
    },
    telemetryFailure: {
      injected: true,
      changedProductTruth: false,
      evidence: [evidence("sink-failure-probe", `${scenario.id}:sink`)],
    },
  };
}

describe("Assurance causal-observability fault matrix", () => {
  it("declares the complete deterministic 13-case contract", () => {
    expect(observabilityFaultMatrix.map(({ id }) => id)).toEqual([
      "invalid_mcp_input",
      "invalid_api_input",
      "authorization_mismatch",
      "stale_exact_reference",
      "browser_authority_loss",
      "owned_request_timeout",
      "response_observed_persistence_failure",
      "database_failure",
      "worker_loss_fencing",
      "reconciliation_ambiguity",
      "artifact_store_failure",
      "report_finalization_failure",
      "observability_sink_failure",
    ]);
    for (const scenario of observabilityFaultMatrix) {
      expect(scenario.injectedFault).not.toBe("");
      expect(scenario.requiredEvents.length).toBeGreaterThan(0);
      expect(scenario.forbiddenFieldNames.length).toBeGreaterThan(0);
      expect(scenario.forbiddenValuePatterns.length).toBeGreaterThan(0);
      expect(Object.values(scenario.expectedEvidence).every(Boolean)).toBe(true);
      expect(scenario.availabilityDeadlineMs).toBeGreaterThan(0);
      if (scenario.expectedTruth.mutation === "unknown")
        expect(["requires_reconciliation", "do_not_retry"]).toContain(scenario.expectedTruth.retry);
    }
  });

  it.each(observabilityFaultMatrix)(
    "qualifies $id across all eight scored dimensions",
    (scenario) => {
      const result = qualifyObservabilityFault(scenario, passingObservation(scenario));

      expect(result).toMatchObject({
        caseId: scenario.id,
        status: "pass",
        points: 8,
        maximumPoints: 8,
        evidenceAvailability: "available",
      });
      expect(Object.values(result.scores).map(({ status }) => status)).toEqual(
        Array(8).fill("pass"),
      );
    },
  );

  it("reports missing operational evidence as unavailable instead of inferring it", () => {
    const scenario = observabilityFaultMatrix[0]!;
    const result = qualifyObservabilityFault(scenario, {
      ...passingObservation(scenario),
      operationalEvents: [],
    });

    expect(result.status).toBe("fail");
    expect(result.scores.detectionCoverage).toMatchObject({
      status: "inconclusive",
      points: 0,
      reasonCodes: ["REQUIRED_OPERATIONAL_EVENT_MISSING"],
      evidence: [],
    });
    expect(result.scores.causalSpecificity.status).toBe("inconclusive");
    expect(result.scores.timelinessAvailability).toMatchObject({
      status: "fail",
      reasonCodes: ["REQUIRED_EVIDENCE_UNAVAILABLE"],
    });
    expect(result.scores.privacy.status).toBe("inconclusive");
    expect(result.evidence.some(({ kind }) => kind === "operational-event")).toBe(false);
  });

  it("distinguishes detection from an incorrect causal reason", () => {
    const scenario = observabilityFaultMatrix[3]!;
    const observation = passingObservation(scenario);
    const wrong = {
      ...observation.operationalEvents[0]!.event,
      reasonCode: "GENERIC_BROWSER_FAILURE",
    } as OperationalEvent;
    const result = qualifyObservabilityFault(scenario, {
      ...observation,
      operationalEvents: [{ ...observation.operationalEvents[0]!, event: wrong }],
    });

    expect(result.scores.detectionCoverage.status).toBe("pass");
    expect(result.scores.causalSpecificity).toMatchObject({
      status: "fail",
      reasonCodes: ["OPERATIONAL_CAUSE_NOT_EXACT"],
    });
    expect(result.scores.correlationCompleteness.status).toBe("inconclusive");
  });

  it("fails exact causal identity, durable truth, timeliness, privacy, action, and sink isolation independently", () => {
    const scenario = observabilityFaultMatrix.find(({ id }) => id === "reconciliation_ambiguity")!;
    const observation = passingObservation(scenario);
    const leakedEvent = {
      ...observation.operationalEvents[0]!.event,
      causality: {
        ...observation.operationalEvents[0]!.event.causality,
        runId: "wrong-run",
      },
      details: {
        ...observation.operationalEvents[0]!.event.details,
        authorization: "Bearer must-never-appear",
      },
    } as OperationalEvent;
    const result = qualifyObservabilityFault(scenario, {
      ...observation,
      productTruth: {
        value: { ...scenario.expectedTruth, durableState: "fabricated_state" },
        evidence: observation.productTruth!.evidence,
      },
      operationalEvents: [
        {
          ...observation.operationalEvents[0]!,
          event: leakedEvent,
          availableAt: "2026-08-23T12:00:05.000Z",
        },
      ],
      safeAction: {
        value: "correct_request_before_resubmission",
        evidence: observation.safeAction!.evidence,
      },
      telemetryFailure: {
        injected: true,
        changedProductTruth: true,
        evidence: observation.telemetryFailure!.evidence,
      },
    });

    expect(result.scores.correlationCompleteness.reasonCodes).toEqual([
      "CAUSAL_IDENTIFIER_MISSING_OR_MISMATCHED",
    ]);
    expect(result.scores.stateFidelity.reasonCodes).toEqual(["PRODUCT_TRUTH_MISMATCH"]);
    expect(result.scores.timelinessAvailability.reasonCodes).toEqual([
      "EVIDENCE_AVAILABILITY_DEADLINE_MISSED",
    ]);
    expect(result.scores.privacy.reasonCodes).toEqual(["FORBIDDEN_SENSITIVE_FIELD_PRESENT"]);
    expect(result.scores.actionability.reasonCodes).toEqual(["SAFE_ACTION_MISMATCH"]);
    expect(result.scores.resilienceToTelemetryFailure.reasonCodes).toEqual([
      "TELEMETRY_FAILURE_CHANGED_PRODUCT_TRUTH",
    ]);
  });

  it("proves fan-out fallback survives durable sink failure without changing product truth", async () => {
    const fallback: OperationalEvent[] = [];
    const durable = vi.fn(async () => {
      throw new Error("DURABLE_SINK_UNAVAILABLE");
    });
    const emitter = new OperationalEventEmitter({
      component: "api",
      releaseId: "qualification-release",
      schemaFingerprint: "qualification-schema",
      now: () => new Date(injectedAt),
      sink: createFanOutOperationalEventSink([
        (event) => {
          fallback.push(event);
        },
        durable,
      ]),
    });
    const productTruth = { responseStatus: 400, admitted: false };

    await expect(
      emitter.emit({
        name: "api.request_rejected",
        classification: "validation",
        reasonCode: "API_INPUT_VALIDATION_FAILED",
        outcome: "refused",
        causality: { correlationId: causalContext.correlationId },
        details: { status: 400 },
      }),
    ).resolves.toBeUndefined();

    expect(durable).toHaveBeenCalledOnce();
    expect(fallback).toHaveLength(1);
    expect(productTruth).toEqual({ responseStatus: 400, admitted: false });

    const scenario = observabilityFaultMatrix.find(
      ({ id }) => id === "observability_sink_failure",
    )!;
    const observation = passingObservation(scenario);
    const result = qualifyObservabilityFault(scenario, {
      ...observation,
      operationalEvents: [
        {
          event: fallback[0]!,
          availableAt,
          channel: "stdout_fallback",
          evidence: [evidence("stdout-fallback", "sink-failure:event")],
        },
      ],
    });
    expect(result.status).toBe("pass");
  });

  it("retains qualification results in the existing runtime-observation experience corpus", () => {
    const corpus = new ExperienceCorpus();
    for (const scenario of observabilityFaultMatrix) {
      const result = qualifyObservabilityFault(scenario, passingObservation(scenario));
      expect(
        corpus.ingest(observabilityQualificationToRuntimeObservation(scenario, result)),
      ).toEqual({
        valid: true,
        reasonCodes: [],
      });
    }

    expect(corpus.summary()).toMatchObject({
      observationCount: 13,
      capabilities: ["causal-observability"],
      failureClasses: {},
      metrics: {
        observability_detectionCoverage: { count: 13, min: 1, max: 1, average: 1 },
        observability_resilienceToTelemetryFailure: { count: 13, min: 1, max: 1, average: 1 },
      },
    });
  });
});
