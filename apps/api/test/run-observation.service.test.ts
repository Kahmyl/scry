import { describe, expect, it, vi } from "vitest";

import { RunObservationService } from "../src/runs/index.js";

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const artifactId = "33333333-3333-4333-8333-333333333333";
const timelineId = "44444444-4444-4444-8444-444444444444";

describe("canonical run observation", () => {
  it("assembles failure channels and safe artifact resources from one authoritative model", async () => {
    const repository = { getRun: vi.fn().mockResolvedValue(failedRun()) };
    const database = { query: vi.fn(async (text: string) => rowsFor(text)) };
    const service = new RunObservationService(database as never, repository as never);

    const observation = await service.observe({ kind: "service", subject: "scry-service" }, runId);

    expect(observation.failure).toMatchObject({
      provenance: "plan",
      code: "readiness_timeout",
      stepId: "open",
      channel: "readiness",
    });
    expect(observation.steps[0]).toMatchObject({
      stepId: "open",
      action: { status: "passed" },
      readiness: { status: "failed" },
    });
    expect(observation.artifacts[0]).toMatchObject({
      id: artifactId,
      resource: `scry://artifact/${artifactId}`,
    });
    expect(observation.artifacts[0]).not.toHaveProperty("storageKey");
    expect(observation.integrity).toEqual({ status: "complete", issues: [] });
    expect(observation.safeActions).toEqual(["rerun", "revise_flow", "read_artifact"]);
    expect(observation.veil).toMatchObject({
      effectiveProfile: "private",
      policyDigest: "a".repeat(64),
      status: "verified",
      findings: [],
    });
  });

  it("reports cross-table observation corruption explicitly", async () => {
    const repository = { getRun: vi.fn().mockResolvedValue(failedRun()) };
    const database = {
      query: vi.fn(async (text: string) => {
        const result = rowsFor(text);
        if (text.includes("artifact_timeline_entries")) {
          return {
            rows: [
              {
                ...result.rows[0],
                metadata: {
                  ...(result.rows[0] as any).metadata,
                  artifactId: "55555555-5555-4555-8555-555555555555",
                },
              },
            ],
          };
        }
        return result;
      }),
    };
    const service = new RunObservationService(database as never, repository as never);

    const observation = await service.observe({ kind: "service", subject: "scry-service" }, runId);

    expect(observation.integrity.status).toBe("failed");
    expect(observation.integrity.issues.map(({ code }) => code)).toContain(
      "TIMELINE_ARTIFACT_MISSING",
    );
  });
});

function failedRun() {
  return {
    id: runId,
    projectId: "66666666-6666-4666-8666-666666666666",
    environmentId: "77777777-7777-4777-8777-777777777777",
    flowRevisionId: "88888888-8888-4888-8888-888888888888",
    state: "failed",
    phase: "completed",
    currentPhase: "failed",
    outcomeClassification: "readiness_timeout",
    planSnapshot: {
      name: "Observation smoke",
      objective: "Open",
      steps: [{ id: "open", title: "Open application" }],
    },
    environmentSnapshot: { baseOrigin: "https://example.test" },
    policySnapshot: {},
    veilPolicySnapshot: {
      schemaVersion: 1,
      profile: "private",
      allowedOrigins: ["https://example.test"],
      controls: {
        screenshots: true,
        video: false,
        dom: false,
        accessibility: true,
        diagnostics: false,
        network: false,
        trace: false,
        clipboard: false,
        downloads: false,
        maskSensitiveVisuals: true,
        sanitizeStructuredEvidence: true,
        quarantineUnknown: true,
      },
      leaseTtlMs: 5000,
      digest: "a".repeat(64),
    },
    executionSnapshot: { browser: "chromium", viewport: { width: 1280, height: 720 }, seed: 1 },
    rerunOfRunId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:02.000Z",
  };
}

function rowsFor(text: string): { rows: Array<Record<string, unknown>> } {
  if (text.includes("FROM attempts WHERE run_id"))
    return {
      rows: [
        {
          id: attemptId,
          attemptNumber: 1,
          state: "failed",
          startedAt: "2026-08-01T00:00:00.000Z",
          completedAt: "2026-08-01T00:00:02.000Z",
          error: "DOM readiness timed out",
        },
      ],
    };
  if (text.includes("FROM step_results"))
    return {
      rows: [
        {
          attemptId,
          stepId: "open",
          ordinal: 0,
          actionStatus: "passed",
          actionError: null,
          readiness: { status: "failed", error: "DOM readiness timed out" },
          assertionsSummary: { passed: 0, failed: 0, unevaluated: 0 },
          evidence: [{ kind: "screenshot", status: "available" }],
          startedAt: "2026-08-01T00:00:00.000Z",
          completedAt: "2026-08-01T00:00:02.000Z",
          durationMs: 2000,
        },
      ],
    };
  if (text.includes("FROM assertion_results")) return { rows: [] };
  if (text.includes("FROM run_events"))
    return {
      rows: [
        {
          id: 1,
          attemptId,
          sequence: 1,
          type: "policy.rejected",
          payload: { code: "ORIGIN_NOT_ALLOWED", disposition: "blocked_subresource" },
          occurredAt: "2026-08-01T00:00:01.000Z",
        },
        {
          id: 2,
          attemptId,
          sequence: 2,
          type: "step.failed",
          payload: { stepId: "open" },
          occurredAt: "2026-08-01T00:00:02.000Z",
        },
      ],
    };
  if (text.includes("FROM artifacts WHERE"))
    return {
      rows: [
        {
          id: artifactId,
          attemptId,
          stepId: null,
          kind: "video",
          availability: "available",
          privacyClassification: "safe",
          failureProvenance: null,
          reasonCode: null,
          contentType: "video/webm",
          sizeBytes: "100",
          checksumSha256: "a".repeat(64),
          observation: {},
          createdAt: "2026-08-01T00:00:02.000Z",
        },
      ],
    };
  if (text.includes("artifact_timeline_entries"))
    return {
      rows: [
        {
          id: timelineId,
          sequence: 0,
          type: "video_segment",
          metadata: {
            type: "video_segment",
            id: timelineId,
            sequence: 0,
            pageId: "page-1",
            startedAt: "2026-08-01T00:00:00.000Z",
            endedAt: "2026-08-01T00:00:02.000Z",
            reason: "run_started",
            status: "available",
            privacyStatus: "verified_safe",
            artifactId,
          },
        },
      ],
    };
  return { rows: [] };
}
