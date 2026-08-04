import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { type ArtifactStore } from "@scry/artifact";
import {
  currentPlanSchema,
  executionPolicySchema,
  veilEvidenceManifestSchema,
  veilPolicySnapshotSchema,
  type Artifact,
} from "@scry/contracts";
import { executePlan, type ExecuteOptions, type ExecutionReport } from "@scry/executor";
import type { Job } from "bullmq";

import type { ExecutionRepository, RunJob } from "../../runtime/index.js";

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
      const executionOptions: Omit<ExecuteOptions, "plan"> & { plan: typeof plan } = {
        plan,
        policy,
        veilPolicySnapshot,
        outputDirectory,
        runId: job.data.runId,
        attemptId: attempt.id,
        veilAdmissionKey: options.veilAdmissionKey,
        browserChannel: options.browserChannel,
        viewport: execution.viewport,
        ...(execution.readinessTimeoutMultiplier !== undefined
          ? { readinessTimeoutMultiplier: execution.readinessTimeoutMultiplier }
          : {}),
        signal: controller.signal,
        secretResolver: (credentialId) =>
          options.executions.resolveCredential(job.data.runId, credentialId),
        secretCapture: (name, value) =>
          options.executions.captureCredential(job.data.runId, name, value),
        atomicSecretCapture: (input) =>
          options.executions.persistCapturedSecret({ runId: job.data.runId, ...input }),
        publicValueCapture: (input) =>
          options.executions.persistGeneratedPublicValue({ runId: job.data.runId, ...input }),
        publicValueResolver: (valueId) =>
          options.executions.resolveGeneratedPublicValue(job.data.runId, valueId),
        protectedTransactionStore: {
          claim: (input) =>
            options.executions.claimProtectedTransaction(
              job.data.runId,
              claimToken,
              input,
            ) as never,
          transition: (input) =>
            options.executions.transitionProtectedMutation(job.data.runId, claimToken, input),
          record: (input) =>
            options.executions.recordProtectedTransaction(job.data.runId, claimToken, input),
        },
        checkpointStore: {
          establish: (input) => options.executions.establishCheckpoint(job.data.runId, input),
          claim: (checkpointId) => options.executions.claimCheckpoint(job.data.runId, checkpointId),
          complete: (checkpointId, outcome, reasonCode) =>
            options.executions.completeCheckpoint(
              job.data.runId,
              checkpointId,
              outcome,
              reasonCode,
            ),
        },
        flowRevisionId: String(snapshot.flowRevisionId),
        environmentId: String(snapshot.environmentId),
        calibrationVerifier: (input) =>
          options.executions.verifyCalibrationAttestation(
            job.data.runId,
            input.attestationId,
            input.operationId,
            input.operationDigest,
            input.structureFingerprint,
          ),
        markCredentialCompromised: async (credentialId, code, operationId) => {
          await options.executions.markCapturedCredentialCompromised(
            job.data.runId,
            credentialId,
            code,
            operationId,
          );
        },
        recordContextProvenance: (input) =>
          options.executions.recordContextProvenance(job.data.runId, input),
        recoverAcquisition: async (input) =>
          ((await options.executions.protectedRecoveryDecision(
            job.data.runId,
            input.operationId,
          )) as
            | {
                action: "retry" | "request_secure_assistance" | "revoke" | "abandon" | "expired";
                correctedScope?: import("@scry/contracts").SemanticScope;
              }
            | undefined) ?? { action: "retry" },
        groundingHistory: (intentDigest) =>
          options.executions.groundingHistory(job.data.runId, intentDigest),
        onPraxisResult: (result) =>
          options.executions.recordPraxisResult(job.data.runId, attempt.id, result),
        onEvent: async (event) => {
          const phase = phaseForEvent(event.type);
          if (phase) await options.executions.setRunPhase(job.data.runId, phase);
          await options.executions.appendEvent(attempt.id, claimToken, event);
        },
      };
      const report = await executePlan(executionOptions as Parameters<typeof executePlan>[0]);
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
  for (const [ordinal, step] of report.steps.entries()) {
    await options.executions.recordStepResult({ attemptId, claimToken, ordinal, step });
    for (const assertion of step.assertions) {
      await options.executions.recordAssertion({
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
  for (const step of report.steps)
    for (const artifact of step.artifacts) stepArtifacts.set(artifact.id, step.id);
  const artifactProvenance = new Map<string, { contextId: string; captureEpoch: number }>();
  let activeProvenance: { contextId: string; captureEpoch: number } | undefined;
  for (const entry of report.artifactTimeline) {
    if (entry.type === "capture_epoch")
      activeProvenance = { contextId: entry.contextId, captureEpoch: entry.epoch };
    if (
      (entry.type === "video_segment" || entry.type === "trace_segment") &&
      entry.artifactId &&
      activeProvenance
    )
      artifactProvenance.set(entry.artifactId, activeProvenance);
  }
  const defaultProvenance = report.artifactTimeline.find(
    (
      entry,
    ): entry is Extract<(typeof report.artifactTimeline)[number], { type: "capture_epoch" }> =>
      entry.type === "capture_epoch",
  );
  await options.executions.recordCaptureEpochs(attemptId, claimToken, report.artifactTimeline);
  for (const artifact of report.artifacts) {
    const storageKey = artifactStorageKey(options.artifactRoot, outputDirectory, artifact);
    if (artifact.availability === "available") {
      const admission = veilEvidenceManifestSchema.safeParse(artifact.observation?.veilManifest);
      const token = artifact.observation?.veilAdmissionToken;
      const sanitation = artifact.observation?.veilSanitation;
      if (
        !admission.success ||
        admission.data.evidenceId !== artifact.id ||
        typeof token !== "string" ||
        !sanitation ||
        typeof sanitation !== "object"
      )
        throw new Error("VEIL_EVIDENCE_ADMISSION_REQUIRED");
      const stagedPath = path.join(options.artifactRoot, storageKey);
      const stored = await options.artifactStore.put(storageKey, await readFile(stagedPath), {
        manifest: admission.data,
        sanitation: sanitation as Record<string, unknown>,
        token,
      });
      artifact.sizeBytes = stored.sizeBytes;
      artifact.checksumSha256 = stored.checksumSha256;
      if (options.artifactStoreRemote) await rm(stagedPath, { force: true });
    } else if (artifact.availability === "quarantined" || artifact.availability === "destroyed") {
      await options.artifactStore.quarantine(storageKey);
    }
    const provenance =
      artifactProvenance.get(artifact.id) ??
      (defaultProvenance
        ? { contextId: defaultProvenance.contextId, captureEpoch: defaultProvenance.epoch }
        : undefined);
    await options.executions.recordArtifact({
      attemptId,
      claimToken,
      ...(stepArtifacts.has(artifact.id) ? { stepId: stepArtifacts.get(artifact.id)! } : {}),
      artifact,
      ...(artifact.availability === "available"
        ? {
            retentionUntil: new Date(Date.now() + options.artifactRetentionMs).toISOString(),
            storageKey,
          }
        : {}),
      ...(artifact.availability === "available" && provenance ? provenance : {}),
    });
  }
  await options.executions.recordArtifactTimeline(attemptId, claimToken, report.artifactTimeline);
}

function artifactStorageKey(artifactRoot: string, outputDirectory: string, artifact: Artifact) {
  const relativeRoot = path.relative(artifactRoot, outputDirectory);
  if (artifact.relativePath) return path.join(relativeRoot, artifact.relativePath);
  if (artifact.kind === "trace") return path.join(relativeRoot, "trace.zip");
  return path.join(relativeRoot, artifact.id);
}

function phaseForEvent(type: string) {
  if (type === "step.started") return "executing_action";
  if (type === "step.readiness_started") return "waiting_readiness";
  if (type === "step.assertions_started") return "evaluating_assertions";
  if (type === "step.evidence_started") return "capturing_evidence";
  if (type === "attempt.finalizing") return "finalizing";
  return undefined;
}
