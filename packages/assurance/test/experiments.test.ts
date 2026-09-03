import {
  defineExperiment,
  defineVerification,
  runExperiment,
  synthesizeExperiment,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

interface Context {
  implementation: "baseline" | "candidate-a" | "candidate-b";
  latencyMs: number;
  succeeds: boolean;
}

const evidence = (value: string) => ({
  source: "fixture" as const,
  kind: "experiment-truth",
  ref: value,
});

const verification = defineVerification<Context>({
  id: "controlled-verification",
  title: "Controlled verification",
  claim: "The implementation completes the scenario",
  oracle(context) {
    return {
      status: context.succeeds ? "pass" : "fail",
      evidence: [evidence(`implementation:${context.implementation}`)],
    };
  },
});

describe("Assurance experiments", () => {
  it("requires exactly one baseline", () => {
    expect(() =>
      defineExperiment<Context>({
        id: "missing-baseline",
        title: "Missing baseline",
        hypothesis: "test",
        verification,
        variants: [
          {
            id: "candidate-a",
            title: "Candidate A",
            role: "candidate",
            prepare: (context) => context,
          },
          {
            id: "candidate-b",
            title: "Candidate B",
            role: "candidate",
            prepare: (context) => context,
          },
        ],
      }),
    ).toThrow("ASSURANCE_EXPERIMENT_SINGLE_BASELINE_REQUIRED");
  });

  it("runs the same verification against baseline and candidates", async () => {
    const experiment = defineExperiment<Context>({
      id: "comparison",
      title: "Implementation comparison",
      hypothesis: "Candidate A improves the mechanism without losing correctness",
      verification,
      variants: [
        {
          id: "baseline",
          title: "Baseline",
          role: "baseline",
          prepare() {
            return {
              implementation: "baseline",
              latencyMs: 200,
              succeeds: true,
            };
          },
        },
        {
          id: "candidate-a",
          title: "Candidate A",
          role: "candidate",
          prepare() {
            return {
              implementation: "candidate-a",
              latencyMs: 120,
              succeeds: true,
            };
          },
        },
      ],
      measure(context) {
        return [
          {
            name: "latency_ms",
            unit: "ms",
            value: context.latencyMs,
          },
        ];
      },
    });

    const result = await runExperiment(experiment, {
      implementation: "baseline",
      latencyMs: 0,
      succeeds: false,
    });

    expect(result.executionStatus).toBe("complete");

    expect(result.variants.map(({ id, verification }) => [id, verification.status])).toEqual([
      ["baseline", "pass"],
      ["candidate-a", "pass"],
    ]);
  });

  it("treats a conclusively failing candidate as useful completed evidence", async () => {
    const experiment = defineExperiment<Context>({
      id: "failed-candidate",
      title: "Failed candidate",
      hypothesis: "Candidate B may improve behavior",
      verification,
      variants: [
        {
          id: "baseline",
          title: "Baseline",
          role: "baseline",
          prepare() {
            return {
              implementation: "baseline",
              latencyMs: 200,
              succeeds: true,
            };
          },
        },
        {
          id: "candidate-b",
          title: "Candidate B",
          role: "candidate",
          prepare() {
            return {
              implementation: "candidate-b",
              latencyMs: 90,
              succeeds: false,
            };
          },
        },
      ],
    });

    const result = await runExperiment(experiment, {
      implementation: "baseline",
      latencyMs: 0,
      succeeds: false,
    });

    expect(result.executionStatus).toBe("complete");

    expect(result.variants[1]?.verification.status).toBe("fail");
  });

  it("marks mixed repeated attempts inconclusive rather than averaging truth", async () => {
    let calls = 0;

    const unstable = defineVerification<Context>({
      id: "unstable",
      title: "Unstable",
      claim: "Behavior remains stable",
      oracle() {
        calls += 1;

        return {
          status: calls % 2 === 1 ? "pass" : "fail",
          evidence: [evidence(`attempt:${calls}`)],
        };
      },
    });

    const experiment = defineExperiment<Context>({
      id: "unstable-experiment",
      title: "Unstable experiment",
      hypothesis: "Behavior is stable",
      verification: unstable,
      attemptsPerVariant: 2,
      variants: [
        {
          id: "baseline",
          title: "Baseline",
          role: "baseline",
          prepare: (context) => context,
        },
        {
          id: "candidate-a",
          title: "Candidate",
          role: "candidate",
          prepare: (context) => context,
        },
      ],
    });

    const result = await runExperiment(experiment, {
      implementation: "baseline",
      latencyMs: 0,
      succeeds: true,
    });

    expect(result.executionStatus).toBe("inconclusive");

    expect(
      result.variants.every(({ verification }) => verification.status === "inconclusive"),
    ).toBe(true);
  });

  it("synthesizes factual metric deltas without choosing production architecture", async () => {
    const experiment = defineExperiment<Context>({
      id: "latency-comparison",
      title: "Latency comparison",
      hypothesis: "Candidate A reduces latency",
      verification,
      variants: [
        {
          id: "baseline",
          title: "Baseline",
          role: "baseline",
          prepare() {
            return {
              implementation: "baseline",
              latencyMs: 200,
              succeeds: true,
            };
          },
        },
        {
          id: "candidate-a",
          title: "Candidate A",
          role: "candidate",
          prepare() {
            return {
              implementation: "candidate-a",
              latencyMs: 125,
              succeeds: true,
            };
          },
        },
      ],
      measure(context) {
        return [
          {
            name: "latency_ms",
            unit: "ms",
            value: context.latencyMs,
          },
        ];
      },
    });

    const result = await runExperiment(experiment, {
      implementation: "baseline",
      latencyMs: 0,
      succeeds: false,
    });

    expect(synthesizeExperiment(result)).toEqual({
      experimentId: "latency-comparison",
      hypothesis: "Candidate A reduces latency",
      executionStatus: "complete",
      baselineVariantId: "baseline",
      candidates: [
        {
          variantId: "candidate-a",
          verificationStatus: "pass",
          evidenceCount: 1,
          metrics: [
            {
              name: "latency_ms",
              unit: "ms",
              baselineAverage: 200,
              candidateAverage: 125,
              delta: -75,
            },
          ],
        },
      ],
      productionDecision: "undetermined",
    });
  });
});
