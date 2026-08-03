import { Worker, type Job, type WorkerOptions } from "bullmq";

import {
  CALIBRATION_QUEUE_NAME,
  PROBE_QUEUE_NAME,
  RUN_QUEUE_NAME,
  type CalibrationJob,
  type ProbeJob,
  type RunJob,
} from "../runtime/index.js";

export interface WorkerFleetOptions {
  connection: WorkerOptions["connection"];
  staleMs: number;
  runConcurrency: number;
  processRun: (job: Job<RunJob>) => Promise<unknown>;
  processCalibration: (job: Job<CalibrationJob>) => Promise<unknown>;
  processProbe: (job: Job<ProbeJob>) => Promise<unknown>;
}

export interface WorkerFleet {
  close(): Promise<void>;
}

export function createWorkerFleet(options: WorkerFleetOptions): WorkerFleet {
  const run = new Worker<RunJob>(RUN_QUEUE_NAME, options.processRun, {
    connection: options.connection,
    concurrency: options.runConcurrency,
    lockDuration: Math.max(options.staleMs * 2, 30_000),
  });
  const calibration = new Worker<CalibrationJob>(
    CALIBRATION_QUEUE_NAME,
    options.processCalibration,
    { connection: options.connection, concurrency: 1, lockDuration: 30_000 },
  );
  const probe = new Worker<ProbeJob>(PROBE_QUEUE_NAME, options.processProbe, {
    connection: options.connection,
    concurrency: 1,
    lockDuration: 60_000,
  });

  run.on("failed", (job, error) => {
    writeFailure({
      message: "Run job failed",
      runId: job?.data.runId,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    });
  });
  calibration.on("failed", (job, error) => {
    writeFailure({
      message: "Calibration job failed",
      calibrationSessionId: job?.data.calibrationSessionId,
      code: safeWorkerCode(error),
    });
  });
  probe.on("failed", (job, error) => {
    writeFailure({
      message: "Probe job failed",
      probeSessionId: job?.data.probeSessionId,
      code: safeWorkerCode(error),
    });
  });

  return {
    async close() {
      await Promise.all([run.close(), calibration.close(), probe.close()]);
    },
  };
}

function safeWorkerCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "WORKER_EXECUTION_FAILED";
}

function writeFailure(payload: Record<string, unknown>) {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}
