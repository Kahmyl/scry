import "reflect-metadata";

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { NestFactory } from "@nestjs/core";
import {
  PRAXIS_CONTRACT_VERSION,
  PRAXIS_RUNTIME_VERSION,
  PRAXIS_SCORING_POLICY_VERSION,
  type CurrentPlan,
  type ExecutionPolicy,
} from "@scry/contracts";
import { verifyBrowserObservationRuntime } from "@scry/praxis";
import { compileDefaultVeilPolicy } from "@scry/veil";
import { createArtifactStoreFromEnv } from "@scry/chronicle/legacy";

import { AppModule } from "./app.module.js";
import { ArtifactRetentionService } from "./artifacts/index.js";
import {
  AuthoringRuntimeCommandRepository,
  AuthoringRuntimeRepository,
} from "./authoring/index.js";
import { CalibrationRuntimeRepository } from "./calibration/index.js";
import { Database } from "./infrastructure/database.js";
import { OperationalEvents } from "./infrastructure/index.js";
import {
  ExecutionCapabilityFactory,
  ExecutionKernelRepository,
  ExecutionKernelService,
  ExecutionRepository,
  NativeBrowserDriver,
} from "./runtime/index.js";
import { ProbeRuntimeRepository } from "./calibration/index.js";
import { PraxisRuntimeRepository } from "./praxis/index.js";
import { RunQueueService } from "./runtime/index.js";
import { RedisConnection } from "./infrastructure/redis.js";
import { createAuthoringRuntimeOwner, createWorkerFleet } from "./workers/index.js";
import { waitForHealthyObservationRuntime } from "./workers/observation-runtime-readiness.js";
import { learnedInteractionsFromAction } from "./authoring/learned-interaction.js";
import {
  createCalibrationProcessor,
  createProbeProcessor,
  createPraxisProcessor,
  safeDependencyCode,
  safeWorkerCode,
} from "./workers/index.js";
import { createRunProcessor } from "./workers/index.js";

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ["log", "warn", "error"],
});
const executions = app.get(ExecutionRepository);
const executionKernel = app.get(ExecutionKernelService);
const executionCapabilities = app.get(ExecutionCapabilityFactory);
const executionKernelRepository = app.get(ExecutionKernelRepository);
const redis = app.get(RedisConnection);
const runQueue = app.get(RunQueueService);
const calibrations = app.get(CalibrationRuntimeRepository);
const probes = app.get(ProbeRuntimeRepository);
const praxis = app.get(PraxisRuntimeRepository);
const authoringRuntimes = app.get(AuthoringRuntimeRepository);
const authoringRuntimeCommands = app.get(AuthoringRuntimeCommandRepository);
const database = app.get(Database);
const operationalEvents = app.get(OperationalEvents);
const nativeBrowser = app.get(NativeBrowserDriver);
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
const operationalRetentionIntervalMs = Math.max(
  60_000,
  Number(process.env.SCRY_OPERATIONAL_EVENT_RETENTION_INTERVAL_MS ?? 60 * 60 * 1_000),
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
const workerSourceIdentity = {
  commit: process.env.SCRY_GIT_COMMIT ?? "unknown",
  dirty: process.env.SCRY_SOURCE_DIRTY === "true",
  manifestSha256: process.env.SCRY_SOURCE_MANIFEST_SHA256 ?? "unknown",
};

const observationRuntime = await waitForHealthyObservationRuntime(
  () => verifyBrowserObservationRuntime(browserChannel, () => nativeBrowser.openBrowser()),
  {
    timeoutMs: 45_000,
    retryIntervalMs: 1_000,
  },
);
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

await executions.heartbeatWorker(
  workerId,
  releaseId,
  schemaFingerprint,
  praxisVersions,
  workerSourceIdentity,
);
const workerHeartbeat = setInterval(
  () =>
    void executions.heartbeatWorker(
      workerId,
      releaseId,
      schemaFingerprint,
      praxisVersions,
      workerSourceIdentity,
    ),
  Math.min(staleMs, 10_000),
);

await recoverStaleWork();
await runArtifactRetention();
await runOperationalEventRetention();
const retentionSweep = setInterval(() => void runArtifactRetention(), retentionIntervalMs);
const operationalRetentionSweep = setInterval(
  () => void runOperationalEventRetention(),
  operationalRetentionIntervalMs,
);
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

const authoringRuntimeOwner = createAuthoringRuntimeOwner({
  repository: authoringRuntimes,
  commands: authoringRuntimeCommands,
  workerId,
  browserChannel,
  veilAdmissionKey,
  heartbeatMs,
  pollMs: Number(process.env.AUTHORING_RUNTIME_POLL_MS ?? 1_000),
  createSession: async (session) => {
    const sessionId = session.sessionId;
    const environmentId = session.environmentId;
    const policy = session.policy;
    const operationId = `authoring-session-${sessionId}`;
    const correlationId = randomUUID();
    const capabilities = executionCapabilities.createSession({
      sessionId,
      operationId,
      correlationId,
      mode: "observe",
      options: authoringKernelOptions(sessionId, environmentId, policy, nativeBrowser),
    });
    const request = executionCapabilities.request({
      sessionId,
      operationId,
      correlationId,
      mode: "observe",
      plan: authoringObservationPlan(policy),
      policy,
      capabilities,
      idempotencyKey: operationId,
    });
    return executionKernel.openAuthoringSession({
      request,
      capabilities,
      session: {
        ...session,
        openBrowser: () => nativeBrowser.openBrowser(),
      },
    });
  },
  executeObservation: async ({
    sessionId,
    environmentId,
    policy,
    operationId,
    correlationId: requestedCorrelationId,
    perform,
  }) => {
    const correlationId = requestedCorrelationId ?? randomUUID();
    const capabilities = executionCapabilities.createSession({
      sessionId,
      operationId,
      correlationId,
      mode: "observe",
      options: authoringKernelOptions(sessionId, environmentId, policy, nativeBrowser),
    });
    const observed = await executionKernel.observe({
      request: executionCapabilities.request({
        sessionId,
        operationId,
        correlationId,
        mode: "observe",
        plan: authoringObservationPlan(policy),
        policy,
        capabilities,
        idempotencyKey: operationId,
      }),
      capabilities,
      perform,
    });
    return observed.value;
  },
  executeInteraction: async ({
    sessionId,
    environmentId,
    policy,
    page,
    action,
    ordinal,
    operationId,
    correlationId: requestedCorrelationId,
    mutationIdentity,
    expectedEffect,
    objectiveDelta,
    signal,
  }) => {
    const correlationId = requestedCorrelationId ?? randomUUID();
    const praxisResults: import("@scry/contracts").PraxisResult[] = [];
    const capabilities = executionCapabilities.createSession({
      sessionId,
      operationId,
      correlationId,
      mode: "rehearse",
      options: {
        outputDirectory: path.join(artifactRoot, "authoring", sessionId),
        browserChannel,
        environmentId,
        veilAdmissionKey,
        veilPolicySnapshot: compileDefaultVeilPolicy(policy),
        secretResolver: (reference) => authoringRuntimes.resolveCredential(sessionId, reference),
        onPraxisResult: (result) => {
          praxisResults.push(result);
        },
        ...(signal ? { signal } : {}),
      },
    });
    const outcome = await executionKernel.interact({
      request: {
        sessionId,
        operationId,
        correlationId,
        mode: "rehearse",
        policy,
        mutationIdentity: mutationIdentity ?? `authoring-${operationId}`,
        ...(objectiveDelta ? { semanticContext: objectiveDelta } : {}),
      },
      capabilities,
      page,
      action,
      ...(expectedEffect ? { expectedEffect } : {}),
      ordinal,
    });
    await authoringRuntimes.recordLearnedInteractions(
      sessionId,
      learnedInteractionsFromAction(action, praxisResults, operationId, {
        veilEvidenceClosed:
          outcome.privacyResult === "verified" &&
          outcome.evidenceResult.every(
            (evidence) => evidence.state === "available" || evidence.state === "suppressed",
          ),
      }),
    );
    return outcome;
  },
});

function authoringKernelOptions(
  sessionId: string,
  environmentId: string,
  policy: ExecutionPolicy,
  nativeBrowser: NativeBrowserDriver,
) {
  return {
    outputDirectory: path.join(artifactRoot, "authoring", sessionId),
    browserChannel,
    environmentId,
    veilAdmissionKey,
    openBrowser: (options?: import("playwright").BrowserContextOptions) =>
      nativeBrowser.openBrowser(options),
    veilPolicySnapshot: compileDefaultVeilPolicy(policy),
    secretResolver: (reference: string) =>
      authoringRuntimes.resolveCredential(sessionId, reference),
  };
}

function authoringObservationPlan(policy: ExecutionPolicy): CurrentPlan {
  return {
    name: "Authoring kernel observation",
    objective: "Admit one bounded authoring observation",
    preconditions: [],
    allowedOrigins: policy.allowedOrigins,
    budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "authoring-observation",
        title: "Observe the current document",
        action: { type: "navigate", url: policy.allowedOrigins[0]! },
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "transient",
        transientJustification: "The kernel contract represents an in-session observation.",
      },
    ],
  };
}

await authoringRuntimeOwner.start();

const workers = createWorkerFleet({
  connection: redis.client,
  staleMs,
  operationalEvents,
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
    kernel: executionKernel,
    capabilities: executionCapabilities,
    operationalEvents,
  }),
  processCalibration: createCalibrationProcessor({
    calibrations,
    workerId,
    releaseId,
    schemaFingerprint,
    heartbeatMs,
    browserChannel,
    veilAdmissionKey,
    kernel: executionKernel,
    capabilities: executionCapabilities,
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
    kernel: executionKernel,
    capabilities: executionCapabilities,
  }),
  processPraxis: createPraxisProcessor({
    praxis,
    authoringRuntimeOwner,
    workerId,
    releaseId,
    schemaFingerprint,
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
  await authoringRuntimeCommands.recoverStaleClaims(new Date(Date.now() - staleMs));
  await authoringRuntimes.recoverStale(new Date(Date.now() - staleMs));
  await executionKernelRepository.purgeExpiredValues();
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

async function runOperationalEventRetention() {
  try {
    const result = await operationalEvents.pruneExpired();
    process.stdout.write(
      `${JSON.stringify({ event: "operational_event.retention", ...result })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ event: "operational_event.retention_failed", code: error instanceof Error ? error.name : "UNKNOWN" })}\n`,
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
  clearInterval(operationalRetentionSweep);
  await authoringRuntimeOwner.close();
  await workers.close();
  await app.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
