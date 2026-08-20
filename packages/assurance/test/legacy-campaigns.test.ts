import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  CampaignMetricsCollector,
  CampaignRedactionError,
  assertRequiredMetricPhases,
  evaluateRequiredChecks,
  finalizeCampaignResult,
  latestPassingCurrentRelease,
  matchesCampaignRelease,
  retainCampaignReport,
  serializeSanitizedCampaign,
  startAdaptiveFixture,
} from "../src/legacy/index.js";

describe("adaptive campaign authority", () => {
  it("provides deterministic protected acquisition fixtures with independent dispatch counts", async () => {
    const fixture = await startAdaptiveFixture(0, "127.0.0.1", {
      protectedValue: "controlled-protected-canary",
      interruptedRevealDelayMs: 250,
    });
    try {
      for (const path of ["readonly-input", "text-output", "interrupted-acquisition"]) {
        const page = await fetch(`${fixture.origin}/protected/${path}`).then((response) =>
          response.text(),
        );
        expect(page).toContain("Generate credential");
        expect(page).toContain("Client secret");
        await fetch(`${fixture.origin}/protected/dispatch?campaign=${path}`, { method: "POST" });
      }
      expect(fixture.snapshot().protectedDispatches).toEqual({
        readonlyInput: 1,
        textOutput: 1,
        interruptedAcquisition: 1,
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not allow observational or future-scope failures to change the verdict", () => {
    const metrics = validMetrics();
    const result = finalizeCampaignResult({
      schemaVersion: 1,
      campaignId: randomUUID(),
      correlationId: metrics.measurements[0]!.correlationId,
      milestone: "M0",
      target: "production_shaped",
      releaseId: "test",
      schemaFingerprint: "test",
      runtimeVersion: "test",
      gitCommit: "test",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      requiredChecks: [{ id: "required", description: "required", status: "passed" }],
      observationalChecks: [{ id: "observation", description: "observed", status: "failed" }],
      futureScope: [{ id: "future", description: "future", status: "failed" }],
      metrics,
      artifactRefs: [],
    });
    expect(result.verdict).toBe("pass");
  });

  it("fails when a required check is missing or awaiting verification", () => {
    expect(evaluateRequiredChecks([])).toBe("fail");
    expect(
      evaluateRequiredChecks([
        { id: "required", description: "required", status: "awaiting_codex_verification" },
      ]),
    ).toBe("fail");
  });

  it("rejects seeded and secret-shaped values before report serialization", () => {
    expect(() => serializeSanitizedCampaign({ safe: "seed-value" }, ["seed-value"])).toThrow(
      CampaignRedactionError,
    );
    expect(() => serializeSanitizedCampaign({ authorization: "value" })).toThrow(
      "CAMPAIGN_SECRET_FIELD",
    );
    expect(() => serializeSanitizedCampaign({ safe: "Bearer abcdefghijklmnop" })).toThrow(
      "CAMPAIGN_SECRET_VALUE",
    );
  });

  it("emits count, p50, p95, max and slow operations", () => {
    const metrics = new CampaignMetricsCollector(randomUUID());
    metrics.record("a", "browser_startup", 10, event("browser_event", "a"));
    metrics.record("b", "browser_startup", 50, event("browser_event", "b"));
    metrics.record("c", "browser_startup", 20, event("browser_event", "c"));
    const snapshot = metrics.snapshot(100);
    expect(snapshot.phases.browser_startup).toEqual({ count: 3, p50Ms: 20, p95Ms: 50, maxMs: 50 });
    expect(snapshot.slowestOperations[0]?.operationId).toBe("b");
  });

  it("fails verification when one required latency phase is omitted", () => {
    const metrics = new CampaignMetricsCollector(randomUUID());
    for (const phase of [
      "queue_wait",
      "browser_startup",
      "document_observation",
      "praxis_grounding",
      "interaction_execution",
      "evidence_finalization",
      "artifact_retrieval",
      "compilation",
    ]) {
      metrics.record(phase, phase, 1, event("campaign_client", phase));
    }
    const result = campaignResult(metrics.snapshot());
    expect(() => assertRequiredMetricPhases(result)).toThrow(
      "M0_METRIC_PHASE_REQUIRED:expected_effect_verification",
    );
  });

  it("cannot pass production-shaped evidence with missing or fraudulent measurements", () => {
    const empty = campaignResult(new CampaignMetricsCollector(randomUUID()).snapshot(10));
    expect(empty.verdict).toBe("fail");
    expect(empty.requiredChecks).toContainEqual(
      expect.objectContaining({
        id: "measurement-integrity",
        status: "failed",
        reasonCode: "MEASUREMENT_UNAVAILABLE",
      }),
    );

    const valid = validMetrics();
    const fraudulent = {
      ...valid,
      mcpRequests: valid.mcpRequests + 1,
    };
    const result = campaignResult(fraudulent);
    expect(result.verdict).toBe("fail");
    expect(
      result.requiredChecks.find((check) => check.id === "measurement-integrity")?.safeDetail,
    ).toEqual(
      expect.objectContaining({ failures: expect.arrayContaining(["UNPROVEN_COUNT:mcpRequests"]) }),
    );
  });

  it("does not treat control-plane health as deployed worker traversal", () => {
    const valid = validMetrics();
    const measurements = valid.measurements.map((measurement) =>
      measurement.metric === "phase:document_observation"
        ? { ...measurement, source: "control_plane_query" as const }
        : measurement,
    );
    const result = campaignResult({ ...valid, measurements });
    expect(result.verdict).toBe("fail");
    expect(
      result.requiredChecks.find((check) => check.id === "measurement-integrity")?.safeDetail,
    ).toEqual(
      expect.objectContaining({
        failures: expect.arrayContaining([
          "MISSING_SOURCE_METRIC:worker_event:phase:document_observation",
        ]),
      }),
    );
  });

  it("keeps campaign semantics deterministic outside identity and timing fields", () => {
    const first = campaignResult(new CampaignMetricsCollector(randomUUID()).snapshot(10));
    const second = {
      ...campaignResult(new CampaignMetricsCollector(randomUUID()).snapshot(20)),
      campaignId: randomUUID(),
      correlationId: randomUUID(),
      startedAt: new Date(2).toISOString(),
      completedAt: new Date(3).toISOString(),
    };
    expect(stableSemantics(first)).toEqual(stableSemantics(second));
  });

  it("retains a sanitized failed report without overwriting prior evidence", async () => {
    const directory = await mkdtemp(`${os.tmpdir()}/scry-campaign-test-`);
    try {
      const failed = {
        ...campaignResult(new CampaignMetricsCollector(randomUUID()).snapshot(10)),
        requiredChecks: [
          {
            id: "infrastructure",
            description: "Infrastructure is available",
            status: "failed" as const,
            reasonCode: "CAMPAIGN_INFRASTRUCTURE_FAILED",
          },
        ],
        verdict: "fail" as const,
      };
      const file = await retainCampaignReport({ directory, result: failed });
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ verdict: "fail" });
      await expect(retainCampaignReport({ directory, result: failed })).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects stale passing reports even when they are newer than the current release", () => {
    const current = {
      ...campaignResult(validMetrics()),
      releaseId: "release-current",
      schemaFingerprint: "schema-current",
      runtimeVersion: "runtime-current",
      gitCommit: "commit-current",
      completedAt: new Date(1).toISOString(),
    };
    const stale = {
      ...current,
      releaseId: "release-stale",
      completedAt: new Date(2).toISOString(),
    };
    const identity = {
      releaseId: "release-current",
      schemaFingerprint: "schema-current",
      runtimeVersion: "runtime-current",
      gitCommit: "commit-current",
    };
    expect(matchesCampaignRelease(stale, identity)).toBe(false);
    expect(latestPassingCurrentRelease([current, stale], identity)?.releaseId).toBe(
      "release-current",
    );
    expect(latestPassingCurrentRelease([stale], identity)).toBeUndefined();
  });
});

function campaignResult(metrics: ReturnType<CampaignMetricsCollector["snapshot"]>) {
  const correlationId = metrics.measurements[0]?.correlationId ?? randomUUID();
  return finalizeCampaignResult({
    schemaVersion: 1,
    campaignId: randomUUID(),
    correlationId,
    milestone: "M0",
    target: "production_shaped",
    releaseId: "test",
    schemaFingerprint: "test",
    runtimeVersion: "test",
    gitCommit: "test",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    requiredChecks: [{ id: "required", description: "required", status: "passed" }],
    observationalChecks: [],
    futureScope: [],
    metrics,
    artifactRefs: [],
  });
}

function validMetrics() {
  const metrics = new CampaignMetricsCollector(randomUUID());
  const phases = [
    ["queue_wait", "queue_event"],
    ["browser_startup", "browser_event"],
    ["document_observation", "worker_event"],
    ["praxis_grounding", "praxis_result"],
    ["interaction_execution", "praxis_result"],
    ["expected_effect_verification", "praxis_result"],
    ["evidence_finalization", "artifact_event"],
    ["artifact_retrieval", "artifact_event"],
    ["compilation", "worker_event"],
    ["certification", "worker_event"],
  ] as const;
  for (const [phase, source] of phases) {
    metrics.record(phase, phase, 1, event(source, `phase-${phase}`));
  }
  metrics.countMcpRequest(event("mcp_http", "mcp-request"));
  metrics.countApiRequest(event("api_http", "api-request"));
  metrics.countDecisionBoundary(event("mcp_http", "decision-boundary"));
  metrics.countBytesReturned(10, event("mcp_http", "response-bytes"));
  return metrics.snapshot(10);
}

function event(
  source: import("@scry/contracts").CampaignMetrics["measurements"][number]["source"],
  eventId: string,
) {
  return { source, eventId };
}

function stableSemantics(result: ReturnType<typeof campaignResult>) {
  return {
    ...result,
    campaignId: "<id>",
    correlationId: "<id>",
    startedAt: "<time>",
    completedAt: "<time>",
    metrics: {
      ...result.metrics,
      totalWallClockMs: 0,
      phases: Object.fromEntries(
        Object.entries(result.metrics.phases).map(([phase, value]) => [
          phase,
          { ...value, p50Ms: 0, p95Ms: 0, maxMs: 0 },
        ]),
      ),
      slowestOperations: [],
    },
  };
}
