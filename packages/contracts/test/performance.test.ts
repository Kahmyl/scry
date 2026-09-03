import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  performanceDurationSchema,
  performanceIterationSchema,
  performanceStageSchema,
} from "../src/index.js";

describe("performance benchmark contracts", () => {
  it("requires an explicit timing state for every canonical stage", () => {
    const stages = Object.fromEntries(
      performanceStageSchema.options.map((stage) => [
        stage,
        { status: "not_applicable", reasonCode: "SCENARIO_STAGE_NOT_EXERCISED" },
      ]),
    );
    const parsed = performanceIterationSchema.parse({
      schemaVersion: 1,
      kind: "scry.performance.iteration",
      sourceCommit: "a".repeat(40),
      releaseId: "release",
      schemaFingerprint: "fingerprint",
      runtimeVersion: "runtime",
      scenario: { id: "supported-journey", version: 1 },
      cohort: "scripted_product",
      iteration: 1,
      correlationId: randomUUID(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productWallClockMs: 123,
      externalAgentWallClock: { status: "measured", durationMs: 123 },
      modelIdleOrReasoningWait: {
        status: "not_applicable",
        reasonCode: "SCRIPTED_CLIENT_NO_MODEL",
      },
      stages,
      counters: {
        mcpCalls: 1,
        apiCalls: 1,
        agentTurns: 1,
        decisionBoundaries: 1,
        invalidCalls: 0,
        staleReferenceCalls: 0,
        unchangedReads: 0,
        browserLaunches: 1,
        browserRestarts: 0,
        browserReacquisitions: 0,
        reconciliationWaits: 0,
        evidenceFinalizations: 0,
        bytesReturned: 100,
      },
      campaignMetrics: {
        totalWallClockMs: 123,
        agentDecisionBoundaries: 1,
        mcpRequests: 1,
        apiRequests: 1,
        modelClientIdleMs: 0,
        bytesReturnedToAgent: 100,
        unchangedStateReads: 0,
        retriesByReason: {},
        phases: {},
        slowestOperations: [],
        measurements: [],
      },
      campaignReportRef: "raw/iteration-1.json",
      verdict: "pass",
    });

    expect(Object.keys(parsed.stages)).toEqual(performanceStageSchema.options);
  });

  it("does not allow unavailable timing to masquerade as zero", () => {
    expect(() =>
      performanceDurationSchema.parse({
        status: "unavailable",
        durationMs: 0,
        reasonCode: "MODEL_PREREQUISITE_MISSING",
      }),
    ).toThrow();
  });
});
