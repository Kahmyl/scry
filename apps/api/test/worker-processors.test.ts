import { describe, expect, it, vi } from "vitest";

import {
  createCalibrationProcessor,
  createProbeProcessor,
  createPraxisProcessor,
  safeDependencyCode,
  safeWorkerCode,
} from "../src/workers/index.js";
import { createRunProcessor } from "../src/workers/index.js";

const identity = {
  workerId: "worker-1",
  releaseId: "release-1",
  schemaFingerprint: "schema-1",
  heartbeatMs: 10,
  browserChannel: "chromium",
};

describe("worker processor boundaries", () => {
  it("fences Run work before claiming when release metadata differs", async () => {
    const executions = { claimAttempt: vi.fn() };
    const processor = createRunProcessor({
      ...identity,
      executions: executions as never,
      artifactRoot: "/tmp/scry-worker-test",
      artifactRetentionMs: 60_000,
      artifactStore: {} as never,
      artifactStoreRemote: false,
      veilAdmissionKey: "test-key",
    });
    await expect(
      processor(job({ runId: "run-1", releaseId: "old", schemaFingerprint: "schema-1" }) as never),
    ).rejects.toThrow("WORKER_RELEASE_MISMATCH");
    expect(executions.claimAttempt).not.toHaveBeenCalled();
  });

  it("fences Probe work before claiming when schema metadata differs", async () => {
    const probes = { claim: vi.fn() };
    const processor = createProbeProcessor({
      ...identity,
      probes: probes as never,
      observationRuntimeHash: "runtime",
      veilAdmissionKey: "test-key",
    });
    await expect(
      processor(
        job({
          probeSessionId: "probe-1",
          releaseId: "release-1",
          schemaFingerprint: "old",
        }) as never,
      ),
    ).rejects.toThrow("WORKER_RELEASE_MISMATCH");
    expect(probes.claim).not.toHaveBeenCalled();
  });

  it("fences Calibration work before claiming when release metadata differs", async () => {
    const calibrations = { claim: vi.fn() };
    const processor = createCalibrationProcessor({
      ...identity,
      calibrations: calibrations as never,
      veilAdmissionKey: "test-key",
    });
    await expect(
      processor(
        job({
          calibrationSessionId: "cal-1",
          releaseId: "old",
          schemaFingerprint: "schema-1",
        }) as never,
      ),
    ).rejects.toThrow("WORKER_RELEASE_MISMATCH");
    expect(calibrations.claim).not.toHaveBeenCalled();
  });

  it("runs Praxis inspection through the owned authoring runtime page", async () => {
    const praxis = {
      claim: vi.fn(async () => ({
        id: "request-1",
        payload: {
          intent: {
            concept: "Continue",
            requiredCapabilities: ["pointer_activatable"],
            preferredEvidence: {
              roles: ["button"],
              names: ["Continue"],
              labels: [],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "page" },
            relations: [],
            prohibited: ["hidden", "disabled"],
            risk: "ordinary",
            confidence: {
              requiredFamilies: [],
              minimum: 0.35,
              minimumMargin: 0.05,
              minimumFamilyCount: 1,
            },
          },
          allowedOrigins: ["https://example.com"],
          probeSessionId: "probe-1",
        },
        claimToken: "claim-1",
      })),
      resolveActiveBrowserLease: vi.fn(async () => "lease-1"),
      complete: vi.fn(async () => true),
      fail: vi.fn(async () => undefined),
    };

    const authoringRuntimeOwner = {
      inspect: vi.fn(async () => ({
        resolution: "resolved",
        candidates: [
          {
            id: "candidate-1",
            fingerprint: "a".repeat(64),
            confidence: 0.95,
            runnerUpMargin: 0.5,
            evidenceFamilies: ["accessibility"],
            strategy: "native_activate",
            resumeToken: {
              id: "resume-1",
              intentDigest: "b".repeat(64),
              fingerprint: "a".repeat(64),
              documentEpoch: 1,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        ],
        policy: {
          allowsAgentCandidateChoice: true,
          allowsSelectorHint: true,
          requiresExplicitAuthorization: false,
        },
        diagnostic: {
          intentDigest: "b".repeat(64),
          documentEpoch: 1,
        },
      })),
    };

    const processor = createPraxisProcessor({
      ...identity,
      praxis: praxis as never,
      authoringRuntimeOwner: authoringRuntimeOwner as never,
    });

    const result = await processor(
      job({
        requestId: "request-1",
        releaseId: "release-1",
        schemaFingerprint: "schema-1",
      }) as never,
    );

    expect(result).toEqual({
      state: "completed",
      requestId: "request-1",
    });

    expect(praxis.resolveActiveBrowserLease).toHaveBeenCalledWith(
      "probe-1",
      "worker-1",
    );

    expect(authoringRuntimeOwner.inspect).toHaveBeenCalledWith(
      "lease-1",
      expect.any(Object),
      ["https://example.com"],
    );

    expect(praxis.complete).toHaveBeenCalledOnce();
  });

  it("fails Praxis inspection when the worker does not own the browser lease", async () => {
    const praxis = {
      claim: vi.fn(async () => ({
        id: "request-1",
        payload: {
          intent: {},
          allowedOrigins: ["https://example.com"],
          probeSessionId: "probe-1",
        },
        claimToken: "claim-1",
      })),
      resolveActiveBrowserLease: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };

    const authoringRuntimeOwner = {
      inspect: vi.fn(),
    };

    const processor = createPraxisProcessor({
      ...identity,
      praxis: praxis as never,
      authoringRuntimeOwner: authoringRuntimeOwner as never,
    });

    const result = await processor(
      job({
        requestId: "request-1",
        releaseId: "release-1",
        schemaFingerprint: "schema-1",
      }) as never,
    );

    expect(result).toEqual({
      state: "failed",
    });

    expect(praxis.resolveActiveBrowserLease).toHaveBeenCalledWith(
      "probe-1",
      "worker-1",
    );

    expect(authoringRuntimeOwner.inspect).not.toHaveBeenCalled();

    expect(praxis.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "request-1",
      }),
      "AUTHORING_BROWSER_SESSION_UNAVAILABLE",
    );
  });

  it("sanitizes unsafe worker and dependency diagnostics", () => {
    expect(safeWorkerCode(new Error("sensitive free-form detail"))).toBe(
      "CALIBRATION_EXECUTION_FAILED",
    );
    expect(safeWorkerCode(new Error("PROBE_CANCELLED"))).toBe("PROBE_CANCELLED");
    expect(safeDependencyCode({ code: "ECONNRESET" })).toBe("ECONNRESET");
    expect(safeDependencyCode({ code: "secret detail" })).toBeUndefined();
  });
});

function job(data: Record<string, unknown>) {
  return { data, attemptsMade: 0, opts: { attempts: 1 } };
}
