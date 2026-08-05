import "reflect-metadata";

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { NestFactory } from "@nestjs/core";
import {
  PRAXIS_CONTRACT_VERSION,
  PRAXIS_RUNTIME_VERSION,
  PRAXIS_SCORING_POLICY_VERSION,
} from "@scry/contracts";
import { verifyBrowserObservationRuntime } from "@scry/praxis";
import { createArtifactStoreFromEnv } from "@scry/artifact";

import { AppModule } from "./app.module.js";
import { ArtifactRetentionService } from "./artifacts/index.js";
import { CalibrationRuntimeRepository } from "./calibration/index.js";
import { Database } from "./infrastructure/database.js";
import { ExecutionRepository } from "./runtime/index.js";
import { ProbeRuntimeRepository } from "./calibration/index.js";
import { RunQueueService } from "./runtime/index.js";
import { RedisConnection } from "./infrastructure/redis.js";
import { createWorkerFleet } from "./workers/index.js";
import {
  createCalibrationProcessor,
  createProbeProcessor,
  safeDependencyCode,
  safeWorkerCode,
} from "./workers/index.js";
import { createRunProcessor } from "./workers/index.js";

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ["log", "warn", "error"],
});
const executions = app.get(ExecutionRepository);
const redis = app.get(RedisConnection);
const runQueue = app.get(RunQueueService);
const calibrations = app.get(CalibrationRuntimeRepository);
const probes = app.get(ProbeRuntimeRepository);
const database = app.get(Database);
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
const artifactRoot = path.resolve(process.env.ARTIFACT_ROOT ?? "artifacts/runs");
const veilAdmissionKey = requireVeilAdmissionKey();
const artifactStorage = createArtifactStoreFromEnv(process.env, veilAdmissionKey);
const artifactStore = artifactStorage.store;
process.stdout.write(
  `${JSON.stringify({ event: "artifact.storage.ready", provider: artifactStorage.provider, remote: artifactStorage.remote })}\n`,
);
const artifactRetention = new ArtifactRetentionService(database, artifactStore);
const retentionIntervalMs = Math.max(
  10_000,
  Number(process.env.ARTIFACT_RETENTION_INTERVAL_MS ?? 60_000),
);
const artifactRetentionMs = Math.max(
  60_000,
  Number(process.env.ARTIFACT_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1_000),
);
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 2_000);
const staleMs = Number(process.env.WORKER_STALE_MS ?? 15_000);
const releaseId = process.env.SCRY_RELEASE_ID ?? "development";
const schemaFingerprint = process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline";
const browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
const praxisVersions = {
  contractVersion: PRAXIS_CONTRACT_VERSION,
  runtimeVersion: PRAXIS_RUNTIME_VERSION,
  scoringPolicyVersion: PRAXIS_SCORING_POLICY_VERSION,
};

const observationRuntime = await verifyBrowserObservationRuntime(browserChannel);
if (!observationRuntime.healthy) {
  throw new Error(
    `OBSERVATION_RUNTIME_UNAVAILABLE:${observationRuntime.forbiddenIdentifiers.join(",")}`,
  );
}
await database.query(
  `INSERT INTO browser_runtime_manifests(release_id,schema_fingerprint,runtime_hash,capability_manifest_hash,health,ready)
   VALUES($1,$2,$3,$4,$5::jsonb,$6)
   ON CONFLICT(release_id,schema_fingerprint,runtime_hash) DO UPDATE SET
     capability_manifest_hash=EXCLUDED.capability_manifest_hash,
     health=EXCLUDED.health,ready=EXCLUDED.ready,created_at=now()`,
  [
    releaseId,
    schemaFingerprint,
    observationRuntime.runtimeHash,
    observationRuntime.capabilityManifestHash,
    JSON.stringify({ ...observationRuntime.health, diagnostics: observationRuntime.diagnostics }),
    observationRuntime.healthy,
  ],
);

await executions.heartbeatWorker(workerId, releaseId, schemaFingerprint, praxisVersions);
const workerHeartbeat = setInterval(
  () => void executions.heartbeatWorker(workerId, releaseId, schemaFingerprint, praxisVersions),
  Math.min(staleMs, 10_000),
);

await recoverStaleWork();
await runArtifactRetention();
const retentionSweep = setInterval(() => void runArtifactRetention(), retentionIntervalMs);
let recoveryRunning = false;
const staleRecovery = setInterval(
  () => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    void recoverStaleWork()
      .catch((error) =>
        process.stderr.write(
          `${JSON.stringify({ message: "Stale-state recovery failed", code: safeWorkerCode(error), dependencyCode: safeDependencyCode(error) })}\n`,
        ),
      )
      .finally(() => {
        recoveryRunning = false;
      });
  },
  Math.max(staleMs, 5_000),
);

const workers = createWorkerFleet({
  connection: redis.client,
  staleMs,
  runConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
  processRun: createRunProcessor({
    executions,
    workerId,
    releaseId,
    schemaFingerprint,
    heartbeatMs,
    artifactRoot,
    artifactRetentionMs,
    artifactStore,
    artifactStoreRemote: artifactStorage.remote,
    veilAdmissionKey,
    browserChannel,
  }),
  processCalibration: createCalibrationProcessor({
    calibrations,
    workerId,
    releaseId,
    schemaFingerprint,
    heartbeatMs,
    browserChannel,
    veilAdmissionKey,
  }),
  processProbe: createProbeProcessor({
    probes,
    workerId,
    releaseId,
    schemaFingerprint,
    heartbeatMs,
    browserChannel,
    veilAdmissionKey,
    observationRuntimeHash: observationRuntime.runtimeHash,
  }),
});

async function recoverStaleWork() {
  const runIds = await executions.recoverStaleAttempts(new Date(Date.now() - staleMs));
  for (const runId of runIds) {
    if (!(await runQueue.queue.getJob(runId))) {
      await runQueue.queue.add(
        "execute",
        { runId, releaseId, schemaFingerprint },
        { jobId: runId },
      );
    }
  }
  await calibrations.recoverStale(new Date(Date.now() - staleMs));
  await probes.recoverStale(new Date(Date.now() - staleMs));
}

async function runArtifactRetention() {
  try {
    const results = await artifactRetention.runBatch(
      Number(process.env.ARTIFACT_RETENTION_BATCH_SIZE ?? 50),
    );
    for (const result of results)
      process.stdout.write(`${JSON.stringify({ event: "veil.artifact_retention", ...result })}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "veil.artifact_retention_failed", code: error instanceof Error ? error.name : "UNKNOWN" })}\n`,
    );
  }
}

function requireVeilAdmissionKey() {
  const key = process.env.VEIL_ADMISSION_KEY;
  if (!key) throw new Error("VEIL_ADMISSION_KEY_REQUIRED");
  return key;
}

async function shutdown() {
  clearInterval(workerHeartbeat);
  clearInterval(staleRecovery);
  clearInterval(retentionSweep);
  await workers.close();
  await app.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
