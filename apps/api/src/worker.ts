import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NestFactory } from "@nestjs/core";
import {
  executionPolicySchema,
  currentPlanSchema,
  type Artifact,
} from "@scry/contracts";
import { executePlan, probeFlowPlan, verifyBrowserObservationRuntime, type BrowserStorageState, type ExecuteOptions, type ExecutionReport } from "@scry/executor";
import { LocalArtifactStore } from "@scry/artifact";
import { Worker, type Job } from "bullmq";

import { AppModule } from "./app.module.js";
import { ExecutionRepository } from "./execution.repository.js";
import {
  RUN_QUEUE_NAME,
  CALIBRATION_QUEUE_NAME,
  PROBE_QUEUE_NAME,
  RunQueueService,
  type RunJob,
  type CalibrationJob,
  type ProbeJob,
} from "./queue.service.js";
import { RedisConnection } from "./redis.js";
import { CalibrationRuntimeRepository } from "./calibration-runtime.repository.js";
import { runCalibrationAttestation } from "./calibration-runner.js";
import { ProbeRuntimeRepository } from "./probe-runtime.repository.js";
import { Database } from "./database.js";

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
const artifactStore = new LocalArtifactStore(artifactRoot);
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 2_000);
const staleMs = Number(process.env.WORKER_STALE_MS ?? 15_000);
const releaseId = process.env.SCRY_RELEASE_ID ?? "development";
const schemaFingerprint = process.env.SCRY_SCHEMA_FINGERPRINT ?? "development-baseline";
const observationRuntime = await verifyBrowserObservationRuntime(process.env.SCRY_BROWSER_CHANNEL??"chrome");
if (!observationRuntime.healthy) throw new Error(`OBSERVATION_RUNTIME_UNAVAILABLE:${observationRuntime.forbiddenIdentifiers.join(",")}`);
await database.query(`INSERT INTO browser_runtime_manifests(release_id,schema_fingerprint,runtime_hash,capability_manifest_hash,health,ready) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(release_id,schema_fingerprint,runtime_hash) DO UPDATE SET capability_manifest_hash=EXCLUDED.capability_manifest_hash,health=EXCLUDED.health,ready=EXCLUDED.ready,created_at=now()`,[releaseId,schemaFingerprint,observationRuntime.runtimeHash,observationRuntime.capabilityManifestHash,JSON.stringify({...observationRuntime.health,diagnostics:observationRuntime.diagnostics}),observationRuntime.healthy]);

await executions.heartbeatWorker(workerId, releaseId, schemaFingerprint);
const workerHeartbeat = setInterval(() => {
  void executions.heartbeatWorker(workerId, releaseId, schemaFingerprint);
}, Math.min(staleMs, 10_000));

await recoverStaleRuns();
let recoveryRunning = false;
const staleRecovery = setInterval(() => {
  if (recoveryRunning) return;
  recoveryRunning = true;
  void recoverStaleRuns().catch((error) => {
    process.stderr.write(`${JSON.stringify({ message: "Stale-state recovery failed", code: safeCalibrationCode(error), dependencyCode: safeDependencyCode(error) })}\n`);
  }).finally(() => { recoveryRunning = false; });
}, Math.max(staleMs, 5_000));

const worker = new Worker<RunJob>(
  RUN_QUEUE_NAME,
  async (job) => processRun(job),
  {
    connection: redis.client,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
    lockDuration: Math.max(staleMs * 2, 30_000),
  },
);

const calibrationWorker = new Worker<CalibrationJob>(
  CALIBRATION_QUEUE_NAME,
  async (job) => processCalibration(job),
  { connection: redis.client, concurrency: 1, lockDuration: 30_000 },
);
const probeWorker=new Worker<ProbeJob>(PROBE_QUEUE_NAME,async job=>processProbe(job),{connection:redis.client,concurrency:1,lockDuration:60_000});

worker.on("failed", (job, error) => {
  process.stderr.write(
    `${JSON.stringify({
      message: "Run job failed",
      runId: job?.data.runId,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    })}\n`,
  );
});

calibrationWorker.on("failed", (job, error) => {
  process.stderr.write(`${JSON.stringify({ message: "Calibration job failed", calibrationSessionId: job?.data.calibrationSessionId, code: safeCalibrationCode(error) })}\n`);
});
probeWorker.on("failed",(job,error)=>{process.stderr.write(`${JSON.stringify({message:"Probe job failed",probeSessionId:job?.data.probeSessionId,code:safeCalibrationCode(error)})}\n`);});

async function processProbe(job:Job<ProbeJob>){if(job.data.releaseId!==releaseId||job.data.schemaFingerprint!==schemaFingerprint)throw new Error("WORKER_RELEASE_MISMATCH");const token=randomUUID();const runtime=await probes.claim(job.data.probeSessionId,workerId,token);if(!runtime)return{state:"not_claimed"};let heartbeat:NodeJS.Timeout|undefined;let capturedState:BrowserStorageState|undefined;const directory=await mkdtemp(path.join(os.tmpdir(),"scry-probe-"));try{if(!await probes.running(runtime))return{state:"claim_fenced"};heartbeat=setInterval(()=>void probes.heartbeat(runtime),heartbeatMs);if(await probes.cancelled(runtime))throw new Error("PROBE_CANCELLED");const result=await probeFlowPlan({plan:currentPlanSchema.parse(runtime.plan),level:runtime.level,policy:executionPolicySchema.parse(runtime.policy),browserChannel:process.env.SCRY_BROWSER_CHANNEL??"chrome",outputDirectory:directory,secretResolver:reference=>probes.resolveCredential(runtime,reference),captureBrowserState:state=>{capturedState=state;}});if(capturedState&&result.allResolved)await probes.storeAuthenticatedState(runtime,capturedState,result.authenticationFingerprint??result.pageFingerprint,observationRuntime.runtimeHash);await probes.complete(runtime,result);return{state:"completed",allResolved:result.allResolved};}catch(error){const code=safeCalibrationCode(error);await probes.fail(runtime,code,code==="PROBE_CANCELLED"?"cancelled":"infrastructure");return{state:"failed",code};}finally{if(heartbeat)clearInterval(heartbeat);capturedState=undefined;await rm(directory,{recursive:true,force:true});}}

async function processCalibration(job: Job<CalibrationJob>) {
  if (job.data.releaseId !== releaseId || job.data.schemaFingerprint !== schemaFingerprint) throw new Error("WORKER_RELEASE_MISMATCH");
  const claimToken = randomUUID();
  const runtime = await calibrations.claim(job.data.calibrationSessionId, workerId, claimToken, releaseId, schemaFingerprint);
  if (!runtime) return { state: "not_claimed" };
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    if (!(await calibrations.markRunning(runtime, "executing_preflight"))) return { state: "claim_fenced" };
    heartbeat = setInterval(() => { void calibrations.heartbeat(runtime); }, heartbeatMs);
    const result = await runCalibrationAttestation(
      runtime,
      process.env.SCRY_BROWSER_CHANNEL ?? "chromium",
      (reference) => calibrations.resolveCredential(runtime, reference),
      (state) => calibrations.markMutation(runtime, state),
      (phase) => calibrations.markPhase(runtime, phase),
    );
    await calibrations.complete(runtime, result);
    return { state: result.passed ? "passed" : "failed" };
  } catch (error) {
    const code = "CALIBRATION_WORKER_EXECUTION_FAILED";
    await calibrations.failClaim(runtime, code, safeDependencyCode(error)).catch(() => false);
    return { state: "failed", code };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function safeCalibrationCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "CALIBRATION_EXECUTION_FAILED";
}
function safeDependencyCode(error: unknown) {
  const value = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return /^[A-Z0-9]{2,12}$/.test(value) ? value : undefined;
}

async function processRun(job: Job<RunJob>) {
  if (job.data.releaseId !== releaseId || job.data.schemaFingerprint !== schemaFingerprint) {
    throw new Error("WORKER_RELEASE_MISMATCH");
  }
  const claimToken = randomUUID();
  const attempt = await executions.claimAttempt(job.data.runId, workerId, claimToken);
  if (!attempt) return { state: "cancelled" };
  const controller = new AbortController();
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  let heartbeat: NodeJS.Timeout | undefined;
  let cancellation: NodeJS.Timeout | undefined;

  try {
    const snapshot = await executions.loadExecution(job.data.runId);
    const plan = currentPlanSchema.parse(snapshot.planSnapshot);
    const policy = executionPolicySchema.parse(snapshot.policySnapshot);
    const execution = snapshot.executionSnapshot as {
      viewport: { width: number; height: number };
      readinessTimeoutMultiplier?: number;
    };
    await executions.markRunning(job.data.runId, attempt.id, claimToken);
    await executions.setRunPhase(job.data.runId, "executing_action");

    heartbeat = setInterval(() => {
      void executions.heartbeat(attempt.id, claimToken).then((owned) => {
        if (!owned) controller.abort(new Error("Worker claim was fenced"));
      });
    }, heartbeatMs);
    cancellation = setInterval(() => {
      void executions.isCancellationRequested(job.data.runId).then((requested) => {
        if (requested) controller.abort(new Error("Run cancellation requested"));
      });
    }, Math.min(heartbeatMs, 1_000));

    const outputDirectory = path.join(
      artifactRoot,
      job.data.runId,
      `attempt-${attempt.attemptNumber}`,
    );
    const executionOptions: Omit<ExecuteOptions, "plan"> & { plan: typeof plan } = {
      plan,
      policy,
      outputDirectory,
      runId: job.data.runId,
      attemptId: attempt.id,
      browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      viewport: execution.viewport,
      ...(execution.readinessTimeoutMultiplier !== undefined
        ? { readinessTimeoutMultiplier: execution.readinessTimeoutMultiplier }
        : {}),
      signal: controller.signal,
      secretResolver: (credentialId) => executions.resolveCredential(job.data.runId, credentialId),
      secretCapture: (name, value) => executions.captureCredential(job.data.runId, name, value),
      atomicSecretCapture: ({ operationId, reference, name, value, scope }) => executions.persistCapturedSecret({ runId: job.data.runId, operationId, reference, name, value, scope }),
      publicValueCapture: ({ operationId, reference, name, value, scope }) => executions.persistGeneratedPublicValue({ runId: job.data.runId, operationId, reference, name, value, scope }),
      publicValueResolver: (valueId) => executions.resolveGeneratedPublicValue(job.data.runId, valueId),
      protectedTransactionStore: {
        claim: (input) => executions.claimProtectedTransaction(job.data.runId, claimToken, input) as never,
        transition: (input) => executions.transitionProtectedMutation(job.data.runId, claimToken, input),
        record: (input) => executions.recordProtectedTransaction(job.data.runId, claimToken, input),
      },
      checkpointStore: {
        establish: (input) => executions.establishCheckpoint(job.data.runId, input),
        claim: (checkpointId) => executions.claimCheckpoint(job.data.runId, checkpointId),
        complete: (checkpointId, outcome, reasonCode) => executions.completeCheckpoint(job.data.runId, checkpointId, outcome, reasonCode),
      },
      flowRevisionId: String(snapshot.flowRevisionId),
      environmentId: String(snapshot.environmentId),
      calibrationVerifier: ({ attestationId, operationId, operationDigest, structureFingerprint }) => executions.verifyCalibrationAttestation(job.data.runId, attestationId, operationId, operationDigest, structureFingerprint),
      markCredentialCompromised: async (credentialId, code, operationId) => { await executions.markCapturedCredentialCompromised(job.data.runId, credentialId, code, operationId); },
      recordContextProvenance: (input) => executions.recordContextProvenance(job.data.runId, input),
      recoverAcquisition: async (input) => await executions.protectedRecoveryDecision(job.data.runId,input.operationId) as { action: "retry"|"request_secure_assistance"|"revoke"|"abandon"|"expired"; correctedScope?: import("@scry/contracts").SemanticScope }|undefined ?? { action: "retry" },
      groundingHistory: (intentDigest) => executions.groundingHistory(job.data.runId,intentDigest),
      onEvent: async (event) => {
        const phase = phaseForEvent(event.type);
        if (phase) await executions.setRunPhase(job.data.runId, phase);
        await executions.appendEvent(attempt.id, claimToken, {
          sequence: event.sequence,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: event.payload,
        });
        if (event.type === "grounding.resolved" || event.type === "grounding.rejected") await executions.recordGroundingDiagnostic(job.data.runId,event.payload);
      },
    };
    const report = await executePlan(executionOptions as Parameters<typeof executePlan>[0]);
    await executions.markFinalizing(job.data.runId, attempt.id, claimToken);
    await executions.setRunPhase(job.data.runId, "finalizing");
    await persistReport(report, outputDirectory, attempt.id, claimToken);

    if (report.state === "infrastructure_error") {
      throw new Error(report.error ?? "Executor infrastructure error");
    }
    await executions.completeAttempt(
      job.data.runId,
      attempt.id,
      claimToken,
      report.state,
      report.outcomeClassification,
      report.error,
    );
    return { state: report.state, attemptId: attempt.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await executions.failAttempt(
      job.data.runId,
      attempt.id,
      claimToken,
      message,
      !finalAttempt,
    );
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancellation) clearInterval(cancellation);
  }
}

function phaseForEvent(type: string) {
  if (type === "step.started") return "executing_action";
  if (type === "step.readiness_started") return "waiting_readiness";
  if (type === "step.assertions_started") return "evaluating_assertions";
  if (type === "step.evidence_started") return "capturing_evidence";
  if (type === "attempt.finalizing") return "finalizing";
  return undefined;
}

async function persistReport(
  report: ExecutionReport,
  outputDirectory: string,
  attemptId: string,
  claimToken: string,
) {
  for (const [ordinal, step] of report.steps.entries()) {
    await executions.recordStepResult({ attemptId, claimToken, ordinal, step });
    for (const assertion of step.assertions) {
      await executions.recordAssertion({
        attemptId,
        claimToken,
        stepId: step.id,
        assertionIndex: assertion.index,
        assertionType: assertion.type,
        status: assertion.status,
        ...(assertion.error ? { error: assertion.error } : {}),
      });
    }
  }

  const stepArtifacts = new Map<string, string>();
  for (const step of report.steps) {
    for (const artifact of step.artifacts) stepArtifacts.set(artifact.id, step.id);
  }
  const artifactProvenance = new Map<string, { contextId: string; captureEpoch: number }>();
  let activeProvenance: { contextId: string; captureEpoch: number } | undefined;
  for (const entry of report.artifactTimeline) {
    if (entry.type === "capture_epoch") activeProvenance = { contextId: entry.contextId, captureEpoch: entry.epoch };
    if ((entry.type === "video_segment" || entry.type === "trace_segment") && entry.artifactId && activeProvenance) artifactProvenance.set(entry.artifactId, activeProvenance);
  }
  const defaultProvenance = report.artifactTimeline.find((entry): entry is Extract<(typeof report.artifactTimeline)[number], { type: "capture_epoch" }> => entry.type === "capture_epoch");
  // Epoch provenance is immutable and must exist before any available artifact
  // can be admitted. Browser context state may already be parked or destroyed.
  await executions.recordCaptureEpochs(attemptId, claimToken, report.artifactTimeline);
  for (const artifact of report.artifacts) {
    const storageKey = artifactStorageKey(
      outputDirectory,
      report,
      artifact,
      stepArtifacts.get(artifact.id),
    );
    if (artifact.availability === "available") {
      const sourcePath = path.join(artifactRoot, storageKey);
      const stored = await artifactStore.put(storageKey, await readFile(sourcePath));
      artifact.sizeBytes = stored.sizeBytes;
      artifact.checksumSha256 = stored.checksumSha256;
    }
    await executions.recordArtifact({
      attemptId,
      claimToken,
      ...(stepArtifacts.has(artifact.id)
        ? { stepId: stepArtifacts.get(artifact.id)! }
        : {}),
      artifact,
      ...(artifact.availability === "available" ? { storageKey } : {}),
      ...(artifact.availability === "available" && (artifactProvenance.get(artifact.id) || defaultProvenance) ? {
        contextId: (artifactProvenance.get(artifact.id) ?? { contextId: defaultProvenance!.contextId }).contextId,
        captureEpoch: (artifactProvenance.get(artifact.id) ?? { captureEpoch: defaultProvenance!.epoch }).captureEpoch,
      } : {}),
    });
  }
  await executions.recordArtifactTimeline(attemptId, claimToken, report.artifactTimeline);
}

function artifactStorageKey(
  outputDirectory: string,
  report: ExecutionReport,
  artifact: Artifact,
  stepId?: string,
) {
  const relativeRoot = path.relative(artifactRoot, outputDirectory);
  if (artifact.relativePath) return path.join(relativeRoot, artifact.relativePath);
  if (artifact.kind === "trace") return path.join(relativeRoot, "trace.zip");
  return path.join(relativeRoot, artifact.id);
}

async function recoverStaleRuns() {
  const runIds = await executions.recoverStaleAttempts(
    new Date(Date.now() - staleMs),
  );
  for (const runId of runIds) {
    const existing = await runQueue.queue.getJob(runId);
    if (!existing) {
      await runQueue.queue.add("execute", { runId, releaseId, schemaFingerprint }, { jobId: runId });
    }
  }
  await calibrations.recoverStale(new Date(Date.now() - staleMs));
  await probes.recoverStale(new Date(Date.now() - staleMs));
}

const shutdown = async () => {
  clearInterval(workerHeartbeat);
  clearInterval(staleRecovery);
  await worker.close();
  await calibrationWorker.close();
  await probeWorker.close();
  await app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
