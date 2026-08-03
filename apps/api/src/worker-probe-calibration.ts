import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { probeFlowPlan, type BrowserStorageState } from "@scry/executor";
import type { Job } from "bullmq";

import { runCalibrationAttestation } from "./calibration-runner.js";
import type { CalibrationRuntimeRepository } from "./calibration-runtime.repository.js";
import type { ProbeRuntimeRepository } from "./probe-runtime.repository.js";
import type { CalibrationJob, ProbeJob } from "./queue.service.js";

interface SharedWorkerIdentity {
  workerId: string;
  releaseId: string;
  schemaFingerprint: string;
  heartbeatMs: number;
  browserChannel: string;
}

export function createProbeProcessor(
  options: SharedWorkerIdentity & {
    probes: ProbeRuntimeRepository;
    observationRuntimeHash: string;
  },
) {
  return async (job: Job<ProbeJob>) => {
    assertRelease(job.data, options);
    const token = randomUUID();
    const runtime = await options.probes.claim(job.data.probeSessionId, options.workerId, token);
    if (!runtime) return { state: "not_claimed" };
    let heartbeat: NodeJS.Timeout | undefined;
    let capturedState: BrowserStorageState | undefined;
    const directory = await mkdtemp(path.join(os.tmpdir(), "scry-probe-"));
    try {
      if (!(await options.probes.running(runtime))) return { state: "claim_fenced" };
      heartbeat = setInterval(() => void options.probes.heartbeat(runtime), options.heartbeatMs);
      if (await options.probes.cancelled(runtime)) throw new Error("PROBE_CANCELLED");
      const result = await probeFlowPlan({
        plan: currentPlanSchema.parse(runtime.plan),
        level: runtime.level,
        policy: executionPolicySchema.parse(runtime.policy),
        browserChannel: options.browserChannel,
        outputDirectory: directory,
        secretResolver: (reference) => options.probes.resolveCredential(runtime, reference),
        captureBrowserState: (state) => {
          capturedState = state;
        },
      });
      if (capturedState && result.allResolved) {
        await options.probes.storeAuthenticatedState(
          runtime,
          capturedState,
          result.authenticationFingerprint ?? result.pageFingerprint,
          options.observationRuntimeHash,
        );
      }
      await options.probes.complete(runtime, result);
      return { state: "completed", allResolved: result.allResolved };
    } catch (error) {
      const code = safeWorkerCode(error, "PROBE_EXECUTION_FAILED");
      await options.probes.fail(
        runtime,
        code,
        code === "PROBE_CANCELLED" ? "cancelled" : "infrastructure",
      );
      return { state: "failed", code };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      capturedState = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export function createCalibrationProcessor(
  options: SharedWorkerIdentity & {
    calibrations: CalibrationRuntimeRepository;
    veilAdmissionKey: string;
  },
) {
  return async (job: Job<CalibrationJob>) => {
    assertRelease(job.data, options);
    const claimToken = randomUUID();
    const runtime = await options.calibrations.claim(
      job.data.calibrationSessionId,
      options.workerId,
      claimToken,
      options.releaseId,
      options.schemaFingerprint,
    );
    if (!runtime) return { state: "not_claimed" };
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      if (!(await options.calibrations.markRunning(runtime, "executing_preflight")))
        return { state: "claim_fenced" };
      heartbeat = setInterval(
        () => void options.calibrations.heartbeat(runtime),
        options.heartbeatMs,
      );
      const result = await runCalibrationAttestation(
        runtime,
        options.browserChannel,
        (reference) => options.calibrations.resolveCredential(runtime, reference),
        (state) => options.calibrations.markMutation(runtime, state),
        (phase) => options.calibrations.markPhase(runtime, phase),
        options.veilAdmissionKey,
      );
      await options.calibrations.complete(runtime, result);
      return { state: result.passed ? "passed" : "failed" };
    } catch (error) {
      const code = "CALIBRATION_WORKER_EXECUTION_FAILED";
      await options.calibrations
        .failClaim(runtime, code, safeDependencyCode(error))
        .catch(() => false);
      return { state: "failed", code };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  };
}

export function safeWorkerCode(error: unknown, fallback = "CALIBRATION_EXECUTION_FAILED") {
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : fallback;
}

export function safeDependencyCode(error: unknown) {
  const value =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return /^[A-Z0-9]{2,12}$/.test(value) ? value : undefined;
}

function assertRelease(
  job: { releaseId: string; schemaFingerprint: string },
  expected: Pick<SharedWorkerIdentity, "releaseId" | "schemaFingerprint">,
) {
  if (
    job.releaseId !== expected.releaseId ||
    job.schemaFingerprint !== expected.schemaFingerprint
  ) {
    throw new Error("WORKER_RELEASE_MISMATCH");
  }
}
