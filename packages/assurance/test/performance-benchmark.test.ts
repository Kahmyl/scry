import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CampaignMetricsCollector,
  performanceIterationFromCampaign,
  summarizePerformanceBenchmark,
} from "../src/index.js";

describe("performance benchmark", () => {
  it("projects factual campaign spans and ranks non-additive bottlenecks", () => {
    const correlationId = randomUUID();
    const metrics = new CampaignMetricsCollector(correlationId);
    metrics.record("capabilities", "api", 4, {
      source: "api_http",
      eventId: "capabilities",
    });
    metrics.record("ready", "readiness", 10, {
      source: "campaign_client",
      eventId: "ready",
    });
    metrics.record("turn", "mcp_round_trip", 80, {
      source: "mcp_http",
      eventId: "turn",
    });
    metrics.record("dispatch", "interaction_execution", 50, {
      source: "worker_event",
      eventId: "dispatch",
    });
    metrics.countMcpRequest({ source: "mcp_http", eventId: "mcp-count" });
    metrics.countBrowserLaunch({ source: "browser_event", eventId: "browser-count" });
    const record = performanceIterationFromCampaign({
      sourceCommit: "a".repeat(40),
      releaseId: "release",
      schemaFingerprint: "fingerprint",
      runtimeVersion: "runtime",
      scenario: { id: "mission-owned-fixture-authoring", version: 1 },
      iteration: 1,
      correlationId,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productWallClockMs: 100,
      campaignMetrics: metrics.snapshot(100),
      campaignReportRef: "raw/iteration-1.json",
      verdict: "pass",
    });
    const summary = summarizePerformanceBenchmark({
      iterations: [record],
      requestedIterations: 1,
      agentCohort: {
        status: "unavailable",
        reasonCode: "DEEPSEEK_EGRESS_UNAVAILABLE",
      },
    });

    expect(record.stages.authoring).toEqual({ status: "measured", durationMs: 80 });
    expect(record.stages.authorization).toEqual({
      status: "not_applicable",
      reasonCode: "NO_ONE_WAY_MUTATION_IN_SCENARIO",
    });
    expect(record.counters.browserLaunches).toBe(1);
    expect(summary.cohort.status).toBe("complete");
    expect(summary.rankedBottlenecks[0]?.stage).toBe("authoring");
    expect(summary.stageTimingSemantics).toBe("overlapping_factual_spans_not_additive");
  });

  it("rejects aggregation across different source commits", () => {
    const correlationId = randomUUID();
    const metrics = new CampaignMetricsCollector(correlationId).snapshot(1);
    const base = performanceIterationFromCampaign({
      sourceCommit: "a".repeat(40),
      releaseId: "release",
      schemaFingerprint: "fingerprint",
      runtimeVersion: "runtime",
      scenario: { id: "mission-owned-fixture-authoring", version: 1 },
      iteration: 1,
      correlationId,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      productWallClockMs: 1,
      campaignMetrics: metrics,
      campaignReportRef: "raw/iteration-1.json",
      verdict: "pass",
    });

    expect(() =>
      summarizePerformanceBenchmark({
        iterations: [base, { ...base, iteration: 2, sourceCommit: "b".repeat(40) }],
        requestedIterations: 2,
      }),
    ).toThrow("PERFORMANCE_ITERATIONS_NOT_COMPARABLE");
  });
});
