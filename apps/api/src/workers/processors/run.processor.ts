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
import type { OperationalCausality } from "@scry/observability";
import type { ApiOperationalEventWriter } from "../../infrastructure/index.js";

import { decideLifecycleTransition } from "../../lifecycle/lifecycle-transition.policy.js";

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
  operationalEvents?: ApiOperationalEventWriter;
}

export function createRunProcessor(options: RunProcessorOptions) {
  return async (job: Job<RunJob>) => {
    const controller = new AbortController();
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const startedAt = performance.now();
    const correlationId = randomUUID();
    let causality: OperationalCausality = {
      runId: job.data.runId,
      correlationId,
    };
    let attempt: Awaited<ReturnType<ExecutionRepository["claimAttempt"]>>;
    let claimToken: string | undefined;
    let transitionFrom = "queued";
    let heartbeat: NodeJS.Timeout | undefined;
    let cancellation: NodeJS.Timeout | undefined;

    try {
      if (
        job.data.releaseId !== options.releaseId ||
        job.data.schemaFingerprint !== options.schemaFingerprint
      )
        throw new Error("WORKER_RELEASE_MISMATCH");

      claimToken = randomUUID();
      attempt = await options.executions.claimAttempt(job.data.runId, options.workerId, claimToken);
      if (!attempt) return { state: "cancelled" };
      const ownedAttempt = attempt;
      const ownedClaimToken = claimToken;
      transitionFrom = "claimed";
      causality = { ...causality, attemptId: ownedAttempt.id };

      const snapshot = await options.executions.loadExecution(job.data.runId);
      const plan = currentPlanSchema.parse(snapshot.planSnapshot);
      const policy = executionPolicySchema.parse(snapshot.policySnapshot);
      const veilPolicySnapshot = veilPolicySnapshotSchema.parse(snapshot.veilPolicySnapshot);
      const execution = snapshot.executionSnapshot as {
        viewport: { width: number; height: number };
        readinessTimeoutMultiplier?: number;
        protectedAuthorizations?: Record<string, string>;
      };
      causality = {
        ...causality,
        projectId: String(snapshot.projectId),
        missionId: String(snapshot.missionId),
        objectiveId: String(snapshot.objectiveId),
        agentSessionId: String(snapshot.agentSessionId),
      };
      await options.executions.markRunning(job.data.runId, attempt.id, claimToken);
      transitionFrom = "running";
      await options.executions.setRunPhase(job.data.runId, "executing_action");

      heartbeat = setInterval(() => {
        void options.executions.heartbeat(ownedAttempt.id, ownedClaimToken).then((owned) => {
          if (!owned) controller.abort(new Error("WORKER_CLAIM_FENCED"));
        });
      }, options.heartbeatMs);
      cancellation = setInterval(
        () => {
          void options.executions.isCancellationRequested(job.data.runId).then((requested) => {
            if (requested) controller.abort(new Error("RUN_CANCELLATION_REQUESTED"));
          });
        },
        Math.min(options.heartbeatMs, 1_000),
      );

      const outputDirectory = path.join(
        options.artifactRoot,
        job.data.runId,
        `attempt-${attempt.attemptNumber}`,
      );
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
            await options.executions.appendEvent(ownedAttempt.id, ownedClaimToken, event);
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
      transitionFrom = "finalizing";
      await options.executions.setRunPhase(job.data.runId, "finalizing");
      await persistReport(options, report, outputDirectory, attempt.id, claimToken, causality);
      if (report.state === "infrastructure_error")
        throw new Error(report.error ?? "Executor infrastructure error");

      const lifecycleDecision = decideLifecycleTransition({
        kind: "complete_run",
        state: report.state,
        outcomeClassification: report.outcomeClassification,
        terminalProtectedBoundary: { kind: "not_requested" },
      });

      if (!lifecycleDecision.accepted) throw new Error(lifecycleDecision.code);

      await options.executions.completeAttempt(
        job.data.runId,
        attempt.id,
        claimToken,
        report.state,
        report.outcomeClassification,
        lifecycleDecision.successorCheckpoint,
        report.error,
      );
      return { state: report.state, attemptId: attempt.id };
    } catch (error) {
      const reasonCode = workerFailureCode(error);
      await emitOperationalFailure(options.operationalEvents, {
        name: "worker.execution_failed",
        classification: workerFailureClassification(error),
        reasonCode,
        outcome: "failed",
        causality,
        durationMs: performance.now() - startedAt,
        transition: {
          from: transitionFrom,
          to: reasonCode === "RUN_CANCELLATION_REQUESTED" ? "cancelled" : "failed",
        },
        details: {
          attemptsMade: job.attemptsMade,
          finalAttempt,
        },
      });
      if (attempt && claimToken)
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

async function emitOperationalFailure(
  events: ApiOperationalEventWriter | undefined,
  input: Parameters<ApiOperationalEventWriter["emit"]>[1],
) {
  try {
    await events?.emit("worker", input);
  } catch {
    // A telemetry sink or test double must never replace execution truth.
  }
}

async function persistReport(
  options: RunProcessorOptions,
  report: ExecutionReport,
  outputDirectory: string,
  attemptId: string,
  claimToken: string,
  causality: OperationalCausality,
) {
  await commitExecutionReport(
    {
      executions: options.executions,
      artifactRoot: options.artifactRoot,
      artifactRetentionMs: options.artifactRetentionMs,
      artifactStore: options.artifactStore,
      artifactStoreRemote: options.artifactStoreRemote,
      ...(options.operationalEvents ? { operationalEvents: options.operationalEvents } : {}),
      causality,
    },
    report,
    outputDirectory,
    attemptId,
    claimToken,
  );
}

function workerFailureCode(error: unknown) {
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*$/.test(candidate) ? candidate : "WORKER_EXECUTION_FAILED";
}

function workerFailureClassification(error: unknown) {
  const code = workerFailureCode(error);
  if (/PERSIST|DATABASE|ARTIFACT|STORAGE|SQL/.test(code)) return "persistence" as const;
  if (code === "RUN_CANCELLATION_REQUESTED") return "policy_refusal" as const;
  if (/POLICY|VEIL|DENIED|REFUSED/.test(code)) return "policy_refusal" as const;
  if (/STALE|FENCED|REFERENCE|AUTHORITY|RELEASE_MISMATCH/.test(code))
    return "stale_authority" as const;
  if (/UNKNOWN|RECONCILIATION/.test(code)) return "reconciliation_unknown" as const;
  return "infrastructure" as const;
}

function phaseForEvent(type: string) {
  if (type === "step.started") return "executing_action";
  if (type === "step.readiness_started") return "waiting_readiness";
  if (type === "step.assertions_started") return "evaluating_assertions";
  if (type === "step.evidence_started") return "capturing_evidence";
  if (type === "attempt.finalizing") return "finalizing";
  return undefined;
}
