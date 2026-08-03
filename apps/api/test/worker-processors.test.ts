import { describe, expect, it, vi } from "vitest";

import {
  createCalibrationProcessor,
  createProbeProcessor,
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
