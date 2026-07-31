import "reflect-metadata";

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { NestFactory } from "@nestjs/core";
import {
  executionPolicyV1Schema,
  testPlanSchema,
  type Artifact,
} from "@scry/contracts";
import { executePlan, type ExecutionReport } from "@scry/executor";
import { Worker, type Job } from "bullmq";

import { AppModule } from "./app.module.js";
import { ExecutionRepository } from "./execution.repository.js";
import {
  RUN_QUEUE_NAME,
  RunQueueService,
  type RunJob,
} from "./queue.service.js";
import { RedisConnection } from "./redis.js";

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ["log", "warn", "error"],
});
const executions = app.get(ExecutionRepository);
const redis = app.get(RedisConnection);
const runQueue = app.get(RunQueueService);
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
const artifactRoot = path.resolve(process.env.ARTIFACT_ROOT ?? "artifacts/runs");
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 2_000);
const staleMs = Number(process.env.WORKER_STALE_MS ?? 15_000);

await recoverStaleRuns();

const worker = new Worker<RunJob>(
  RUN_QUEUE_NAME,
  async (job) => processRun(job),
  {
    connection: redis.client,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
    lockDuration: Math.max(staleMs * 2, 30_000),
  },
);

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

async function processRun(job: Job<RunJob>) {
  const claimToken = randomUUID();
  const attempt = await executions.claimAttempt(job.data.runId, workerId, claimToken);
  if (!attempt) return { state: "cancelled" };
  const controller = new AbortController();
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  let heartbeat: NodeJS.Timeout | undefined;
  let cancellation: NodeJS.Timeout | undefined;

  try {
    const snapshot = await executions.loadExecution(job.data.runId);
    const plan = testPlanSchema.parse(snapshot.planSnapshot);
    const policy = executionPolicyV1Schema.parse(snapshot.policySnapshot);
    const execution = snapshot.executionSnapshot as {
      viewport: { width: number; height: number };
      readinessTimeoutMultiplier?: number;
    };
    await executions.markRunning(job.data.runId, attempt.id, claimToken);

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
    const report = await executePlan({
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
      onEvent: async (event) => {
        await executions.appendEvent(attempt.id, claimToken, {
          sequence: event.sequence,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: event.payload,
        });
      },
    });
    await executions.markFinalizing(job.data.runId, attempt.id, claimToken);
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
    if (report.outcomeClassification === "readiness_timeout") {
      try {
        const confirmationRunId = await executions.createConfirmationRun(job.data.runId, 2);
        if (confirmationRunId) await runQueue.start(confirmationRunId);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({
          message: "Confirmation run could not be queued",
          runId: job.data.runId,
          error: error instanceof Error ? error.message : String(error),
        })}\n`);
      }
    }
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

async function persistReport(
  report: ExecutionReport,
  outputDirectory: string,
  attemptId: string,
  claimToken: string,
) {
  for (const step of report.steps) {
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
  for (const artifact of report.artifacts) {
    await executions.recordArtifact({
      attemptId,
      claimToken,
      ...(stepArtifacts.has(artifact.id)
        ? { stepId: stepArtifacts.get(artifact.id)! }
        : {}),
      artifact,
      storageKey: artifactStorageKey(
        outputDirectory,
        report,
        artifact,
        stepArtifacts.get(artifact.id),
      ),
    });
  }
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
      await runQueue.queue.add("execute", { runId }, { jobId: runId });
    }
  }
}

const shutdown = async () => {
  await worker.close();
  await app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
