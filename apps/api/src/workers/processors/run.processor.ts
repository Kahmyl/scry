import { commitExecutionReport } from "../../runtime/report-commit.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type ArtifactStore } from "@scry/chronicle/legacy";
import {
  currentPlanSchema,
  executionPolicySchema,
  veilPolicySnapshotSchema,
} from "@scry/contracts";
import type { ExecutionReport } from "@scry/executor";
import type { Job } from "bullmq";

import {
  type ExecutionCapabilityFactory,
  type ExecutionKernelService,
  type ExecutionRepository,
  type RunJob,
} from "../../runtime/index.js";

export interface RunProcessorOptions {
  executions: ExecutionRepository;
  workerId: string;
  releaseId: string;
  schemaFingerprint: string;
  heartbeatMs: number;
  artifactRoot: string;
  artifactRetentionMs: number;
  artifactStore: ArtifactStore;
  artifactStoreRemote: boolean;
  veilAdmissionKey: string;
  browserChannel: string;
  kernel: ExecutionKernelService;
  capabilities: ExecutionCapabilityFactory;
}

export function createRunProcessor(options: RunProcessorOptions) {
  return async (job: Job<RunJob>) => {
    if (
      job.data.releaseId !== options.releaseId ||
      job.data.schemaFingerprint !== options.schemaFingerprint
    ) {
      throw new Error("WORKER_RELEASE_MISMATCH");
    }
    const claimToken = randomUUID();
    const attempt = await options.executions.claimAttempt(
      job.data.runId,
      options.workerId,
      claimToken,
    );
    if (!attempt) return { state: "cancelled" };
    const controller = new AbortController();
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    let heartbeat: NodeJS.Timeout | undefined;
    let cancellation: NodeJS.Timeout | undefined;

    try {
      const snapshot = await options.executions.loadExecution(job.data.runId);
      const plan = currentPlanSchema.parse(snapshot.planSnapshot);
      const policy = executionPolicySchema.parse(snapshot.policySnapshot);
      const veilPolicySnapshot = veilPolicySnapshotSchema.parse(snapshot.veilPolicySnapshot);
      const execution = snapshot.executionSnapshot as {
        viewport: { width: number; height: number };
        readinessTimeoutMultiplier?: number;
        protectedAuthorizations?: Record<string, string>;
      };
      await options.executions.markRunning(job.data.runId, attempt.id, claimToken);
      await options.executions.setRunPhase(job.data.runId, "executing_action");

      heartbeat = setInterval(() => {
        void options.executions.heartbeat(attempt.id, claimToken).then((owned) => {
          if (!owned) controller.abort(new Error("Worker claim was fenced"));
        });
      }, options.heartbeatMs);
      cancellation = setInterval(
        () => {
          void options.executions.isCancellationRequested(job.data.runId).then((requested) => {
            if (requested) controller.abort(new Error("Run cancellation requested"));
          });
        },
        Math.min(options.heartbeatMs, 1_000),
      );

      const outputDirectory = path.join(
        options.artifactRoot,
        job.data.runId,
        `attempt-${attempt.attemptNumber}`,
      );
      const correlationId = randomUUID();
      const mode = "run";
      const capabilities = options.capabilities.createRun({
        sessionId: job.data.runId,
        operationId: `attempt-${attempt.id}`,
        correlationId,
        mode,
        runId: job.data.runId,
        attemptId: attempt.id,
        claimToken,
        flowRevisionId: String(snapshot.flowRevisionId),
        environmentId: String(snapshot.environmentId),
        projectId: String(snapshot.projectId),
        missionId: String(snapshot.missionId),
        objectiveId: String(snapshot.objectiveId),
        agentSessionId: String(snapshot.agentSessionId),
        protectedAuthorizations: execution.protectedAuthorizations ?? {},
        options: {
          veilPolicySnapshot,
          outputDirectory,
          veilAdmissionKey: options.veilAdmissionKey,
          browserChannel: options.browserChannel,
          viewport: execution.viewport,
          ...(execution.readinessTimeoutMultiplier !== undefined
            ? { readinessTimeoutMultiplier: execution.readinessTimeoutMultiplier }
            : {}),
          signal: controller.signal,
          captureSuccessorCheckpoint: async (checkpoint) => {
            await options.executions.stageSuccessorCheckpoint(job.data.runId, checkpoint);
          },
          onEvent: async (event) => {
            const phase = phaseForEvent(event.type);
            if (phase) await options.executions.setRunPhase(job.data.runId, phase);
            await options.executions.appendEvent(attempt.id, claimToken, event);
          },
        },
      });
      const request = options.capabilities.request({
        sessionId: job.data.runId,
        operationId: `attempt-${attempt.id}`,
        correlationId,
        mode,
        plan,
        policy,
        capabilities,
        idempotencyKey: `run-attempt-${attempt.id}`,
        mutationIdentity: `run-${job.data.runId}`,
      });
      const report = (await options.kernel.execute({ request, capabilities })).report;
      await options.executions.markFinalizing(job.data.runId, attempt.id, claimToken);
      await options.executions.setRunPhase(job.data.runId, "finalizing");
      await persistReport(options, report, outputDirectory, attempt.id, claimToken);
      if (report.state === "infrastructure_error")
        throw new Error(report.error ?? "Executor infrastructure error");
      await options.executions.completeAttempt(
        job.data.runId,
        attempt.id,
        claimToken,
        report.state,
        report.outcomeClassification,
        report.error,
      );
      return { state: report.state, attemptId: attempt.id };
    } catch (error) {
      await options.executions.failAttempt(
        job.data.runId,
        attempt.id,
        claimToken,
        error instanceof Error ? error.message : String(error),
        !finalAttempt,
      );
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (cancellation) clearInterval(cancellation);
    }
  };
}

async function persistReport(
  options: RunProcessorOptions,
  report: ExecutionReport,
  outputDirectory: string,
  attemptId: string,
  claimToken: string,
) {
  await commitExecutionReport(
    {
      executions: options.executions,
      artifactRoot: options.artifactRoot,
      artifactRetentionMs: options.artifactRetentionMs,
      artifactStore: options.artifactStore,
      artifactStoreRemote: options.artifactStoreRemote,
    },
    report,
    outputDirectory,
    attemptId,
    claimToken,
  );
}

function phaseForEvent(type: string) {
  if (type === "step.started") return "executing_action";
  if (type === "step.readiness_started") return "waiting_readiness";
  if (type === "step.assertions_started") return "evaluating_assertions";
  if (type === "step.evidence_started") return "capturing_evidence";
  if (type === "attempt.finalizing") return "finalizing";
  return undefined;
}
