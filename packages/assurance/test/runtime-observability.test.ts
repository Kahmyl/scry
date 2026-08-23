import {
  ExperienceCorpus,
  assessCapabilitySupport,
  runtimeObservationToCapabilityEvidence,
  validateRuntimeObservation,
  type RuntimeObservation,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const evidence = {
  source: "chronicle" as const,
  kind: "run-operation",
  ref: "run:operation:1",
};

function observation(input: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    id: input.id ?? "observation-1",
    capability: input.capability ?? "semantic-target-resolution",
    outcome: input.outcome ?? "succeeded",
    evidence: input.evidence ?? [evidence],
    environment: input.environment ?? {
      application: "example",
      controlType: "button",
      frameworkBehavior: "react",
      journeyDepth: 7,
    },
    metrics: input.metrics ?? [
      {
        name: "operation_latency_ms",
        value: 120,
        unit: "ms",
      },
    ],
    facts: input.facts ?? {
      nativeResolutionSucceeded: true,
      praxisFallbackRequired: false,
      targetAmbiguityEncountered: false,
      semanticTurns: 1,
      continuationRounds: 0,
      recoveryRequired: false,
      browserCleanupEscalated: false,
    },
    ...(input.failureClass
      ? {
          failureClass: input.failureClass,
        }
      : {}),
    ...(input.summary
      ? {
          summary: input.summary,
        }
      : {}),
  };
}

describe("ordinary-run Assurance observations", () => {
  it("requires evidence before admitting a runtime observation", () => {
    const result = validateRuntimeObservation(
      observation({
        evidence: [],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reasonCodes: ["RUNTIME_OBSERVATION_EVIDENCE_REQUIRED"],
    });
  });

  it("rejects invalid journey depth and counters", () => {
    const result = validateRuntimeObservation(
      observation({
        environment: {
          journeyDepth: -1,
        },
        facts: {
          semanticTurns: -1,
        },
      }),
    );

    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "RUNTIME_OBSERVATION_JOURNEY_DEPTH_INVALID",
        "RUNTIME_OBSERVATION_COUNT_INVALID",
      ]),
    );
  });

  it("converts successful ordinary-run truth into observed support evidence", () => {
    const record = runtimeObservationToCapabilityEvidence(observation());

    expect(record).toMatchObject({
      level: "observed",
      kind: "runtime_observation",
      status: "pass",
      capability: "semantic-target-resolution",
    });

    expect(assessCapabilitySupport("semantic-target-resolution", [record])).toMatchObject({
      status: "experimental",
      observedInRealApplications: true,
    });
  });

  it("does not turn a failed real observation into positive support", () => {
    const record = runtimeObservationToCapabilityEvidence(
      observation({
        outcome: "failed",
        failureClass: "TARGET_AMBIGUITY",
      }),
    );

    expect(assessCapabilitySupport("semantic-target-resolution", [record]).status).toBe("unproven");
  });

  it("deduplicates identical observations by durable observation id", () => {
    const corpus = new ExperienceCorpus();

    const value = observation();

    expect(corpus.ingest(value).valid).toBe(true);

    expect(corpus.ingest(value).valid).toBe(true);

    expect(corpus.observations()).toHaveLength(1);
  });

  it("refuses conflicting facts under the same observation id", () => {
    const corpus = new ExperienceCorpus();

    expect(corpus.ingest(observation()).valid).toBe(true);

    expect(
      corpus.ingest(
        observation({
          outcome: "failed",
        }),
      ),
    ).toEqual({
      valid: false,
      reasonCodes: ["RUNTIME_OBSERVATION_ID_CONFLICT"],
    });
  });

  it("summarizes failure, fallback, recovery, ambiguity, cleanup, and latency facts", () => {
    const corpus = new ExperienceCorpus();

    corpus.ingest(
      observation({
        id: "one",
        capability: "activation",
        metrics: [
          {
            name: "operation_latency_ms",
            value: 100,
          },
        ],
      }),
    );

    corpus.ingest(
      observation({
        id: "two",
        capability: "activation",
        outcome: "failed",
        failureClass: "TARGET_AMBIGUITY",
        metrics: [
          {
            name: "operation_latency_ms",
            value: 300,
          },
        ],
        facts: {
          praxisFallbackRequired: true,
          recoveryRequired: true,
          targetAmbiguityEncountered: true,
          browserCleanupEscalated: true,
        },
      }),
    );

    expect(corpus.summary()).toEqual({
      observationCount: 2,
      capabilities: ["activation"],
      failureClasses: {
        TARGET_AMBIGUITY: 1,
      },
      fallbackCount: 1,
      recoveryCount: 1,
      ambiguityCount: 1,
      cleanupEscalationCount: 1,
      metrics: {
        operation_latency_ms: {
          count: 2,
          min: 100,
          max: 300,
          average: 200,
        },
      },
    });
  });

  it("preserves capability × environment dimensions for later corpus analysis", () => {
    const corpus = new ExperienceCorpus();

    corpus.ingest(
      observation({
        environment: {
          application: "vitract",
          controlType: "custom-button",
          frameworkBehavior: "react-spa",
          pageLifecycle: "document-replacement",
          navigationBehavior: "client-side",
          authStyle: "session-cookie",
          acquisitionMethod: "network-response",
          mutationSemantics: "one-time",
          journeyDepth: 17,
          failureRecoveryClass: "post-dispatch-recovery",
        },
      }),
    );

    expect(corpus.observations()[0]?.environment).toMatchObject({
      application: "vitract",
      journeyDepth: 17,
      mutationSemantics: "one-time",
      failureRecoveryClass: "post-dispatch-recovery",
    });
  });
});
