import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { type ArtifactStore } from "@scry/chronicle/legacy";
import { veilEvidenceManifestSchema, type Artifact } from "@scry/contracts";
import type { ExecutionReport } from "@scry/executor";

import type { ExecutionRepository } from "./repositories/execution.repository.js";

export type CommitExecutionReportOptions = {
  executions: ExecutionRepository;
  artifactRoot: string;
  artifactRetentionMs: number;
  artifactStore: ArtifactStore;
  artifactStoreRemote: boolean;
};

export type CommitExecutionReportScope = {
  stepIdPrefix?: string;
  ordinalOffset?: number;
  timelineSequenceOffset?: number;
};

export async function commitExecutionReport(
  options: CommitExecutionReportOptions,
  report: ExecutionReport,
  outputDirectory: string,
  attemptId: string,
  claimToken: string,
  scope: CommitExecutionReportScope = {},
) {
  const stepId = (raw: string) => (scope.stepIdPrefix ? `${scope.stepIdPrefix}::${raw}` : raw);

  const timelineOffset = scope.timelineSequenceOffset ?? 0;
  const artifactTimeline =
    timelineOffset === 0
      ? report.artifactTimeline
      : report.artifactTimeline.map((entry) => ({
          ...entry,
          sequence: entry.sequence + timelineOffset,
        }));

  const stepArtifacts = new Map<string, string>();
  for (const step of report.steps)
    for (const artifact of step.artifacts) stepArtifacts.set(artifact.id, stepId(step.id));

  const artifactProvenance = new Map<string, { contextId: string; captureEpoch: number }>();
  let activeProvenance: { contextId: string; captureEpoch: number } | undefined;

  for (const entry of artifactTimeline) {
    if (entry.type === "capture_epoch")
      activeProvenance = { contextId: entry.contextId, captureEpoch: entry.epoch };

    if (
      (entry.type === "video_segment" || entry.type === "trace_segment") &&
      entry.artifactId &&
      activeProvenance
    )
      artifactProvenance.set(entry.artifactId, activeProvenance);
  }

  const defaultProvenance = artifactTimeline.find(
    (entry): entry is Extract<(typeof artifactTimeline)[number], { type: "capture_epoch" }> =>
      entry.type === "capture_epoch",
  );

  const uploadedStorageKeys: string[] = [];

  try {
    await options.executions.observationTransaction(async (executions) => {
      for (const [ordinal, step] of report.steps.entries()) {
        const persistedStep = {
          ...step,
          id: stepId(step.id),
        };

        await executions.recordStepResult({
          attemptId,
          claimToken,
          ordinal: (scope.ordinalOffset ?? 0) + ordinal,
          step: persistedStep,
        });

        for (const assertion of step.assertions) {
          await executions.recordAssertion({
            attemptId,
            claimToken,
            stepId: persistedStep.id,
            assertionIndex: assertion.index,
            assertionType: assertion.type,
            status: assertion.status,
            ...(assertion.error ? { error: assertion.error } : {}),
          });
        }
      }

      /*
       * Capture epoch rows must exist before available artifacts reference
       * (context_id, capture_epoch). Because this writer is transaction-scoped,
       * recordArtifactTimeline's repeated epoch reconciliation stays on the
       * same PostgreSQL client rather than creating a nested transaction.
       */
      await executions.recordCaptureEpochs(attemptId, claimToken, artifactTimeline);

      for (const artifact of report.artifacts) {
        const storageKey = artifactStorageKey(options.artifactRoot, outputDirectory, artifact);

        if (artifact.availability === "available") {
          const admission = veilEvidenceManifestSchema.safeParse(
            artifact.observation?.veilManifest,
          );
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

          uploadedStorageKeys.push(storageKey);
          artifact.sizeBytes = stored.sizeBytes;
          artifact.checksumSha256 = stored.checksumSha256;

          if (options.artifactStoreRemote) await rm(stagedPath, { force: true });
        } else if (
          artifact.availability === "quarantined" ||
          artifact.availability === "destroyed"
        ) {
          await options.artifactStore.quarantine(storageKey);
        }

        const provenance =
          artifactProvenance.get(artifact.id) ??
          (defaultProvenance
            ? {
                contextId: defaultProvenance.contextId,
                captureEpoch: defaultProvenance.epoch,
              }
            : undefined);

        await executions.recordArtifact({
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

      await executions.recordArtifactTimeline(attemptId, claimToken, artifactTimeline);
    });
  } catch (error) {
    const cleanupFailures: unknown[] = [];

    for (const storageKey of new Set(uploadedStorageKeys)) {
      try {
        await options.artifactStore.delete(storageKey);

        if (await options.artifactStore.exists(storageKey))
          throw new Error(`Artifact bytes remain after compensation: ${storageKey}`);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }

    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "ARTIFACT_COMMIT_COMPENSATION_FAILED");
    }

    throw error;
  }
}

function artifactStorageKey(artifactRoot: string, outputDirectory: string, artifact: Artifact) {
  const relativeRoot = path.relative(artifactRoot, outputDirectory);
  if (artifact.relativePath) return path.join(relativeRoot, artifact.relativePath);
  if (artifact.kind === "trace") return path.join(relativeRoot, "trace.zip");
  return path.join(relativeRoot, artifact.id);
}
