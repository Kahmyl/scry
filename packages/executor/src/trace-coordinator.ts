import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  Artifact,
  PrivacyFailure,
  RecordingTimelineEntry,
  SafeResumeBoundary,
} from "@scry/contracts";
import type { BrowserContext } from "playwright";

import { availableArtifact } from "./artifacts.js";
import type { PrivacyCollector } from "@scry/veil";

export class TraceCoordinator implements PrivacyCollector {
  readonly name = "trace";
  private active:
    | {
        id: string;
        startedAt: string;
        reason: "run_started" | "safe_resume";
        path: string;
        relativePath: string;
      }
    | undefined;
  private readonly traceArtifacts: Artifact[] = [];
  private readonly entries: RecordingTimelineEntry[] = [];
  private sealed = false;
  private finalized = false;
  private transition = Promise.resolve();
  private veilState: ReturnType<PrivacyCollector["state"]>["status"] = "active";

  constructor(
    private readonly options: {
      context: BrowserContext;
      outputDirectory: string;
      sanitize: (path: string) => Promise<void>;
      /** Only a pre-admission verifier with complete classification may opt in. */
      admitSanitized?: (path: string) => Promise<boolean>;
      now?: () => Date;
    },
  ) {}

  start(reason: "run_started" | "safe_resume") {
    return this.serial(async () => {
      if (this.sealed || this.finalized) throw new Error("Trace coordinator is closed");
      if (this.active) throw new Error("Trace segment is already active");
      const id = randomUUID();
      const relativePath = path.posix.join(
        "trace",
        `segment-${String(this.entries.length).padStart(4, "0")}-${id}.zip`,
      );
      const target = path.join(this.options.outputDirectory, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await bounded(
        this.options.context.tracing.start({ screenshots: true, snapshots: true, sources: false }),
      );
      this.active = { id, startedAt: this.now(), reason, path: target, relativePath };
    });
  }

  async arm(_operationId: string) {
    if (this.veilState !== "active") throw new Error("TRACE_NOT_ACTIVE");
    this.veilState = "prepared";
  }
  async suspend() {
    if (this.veilState !== "prepared") throw new Error("TRACE_NOT_PREPARED");
    await this.stop(false);
    this.veilState = "suspended";
  }
  async isolate() {
    if (this.veilState !== "suspended" || this.active) throw new Error("TRACE_NOT_SUSPENDED");
    this.veilState = "isolated";
  }
  async resume(_boundary: SafeResumeBoundary) {
    if (this.veilState !== "isolated") throw new Error("TRACE_NOT_ISOLATED");
    await this.start("safe_resume");
    this.veilState = "active";
  }
  async seal(_reason: PrivacyFailure) {
    await this.stop(true);
    this.sealed = true;
    this.veilState = "sealed";
  }
  async finalize() {
    if (this.finalized) return;
    await this.stop(this.sealed);
    this.finalized = true;
    this.veilState = "finalized";
  }
  state() {
    return { status: this.veilState };
  }

  artifacts() {
    return structuredClone(this.traceArtifacts);
  }
  timeline() {
    return structuredClone(this.entries);
  }

  private stop(quarantine: boolean) {
    return this.serial(async () => {
      const active = this.active;
      if (!active) return;
      this.active = undefined;
      const endedAt = this.now();
      try {
        await bounded(this.options.context.tracing.stop({ path: active.path }));
        if (quarantine || this.sealed) {
          await rm(active.path, { force: true });
          const artifact: Artifact = {
            id: randomUUID(),
            kind: "trace",
            availability: "destroyed",
            privacyClassification: "uncertain",
            failureProvenance: "privacy",
            reasonCode: "PRIVACY_SEALED",
            contentType: "application/zip",
            observation: { reasonCode: "PRIVACY_SEALED", bytesDestroyed: true },
          };
          const entry: RecordingTimelineEntry = {
            type: "trace_segment",
            id: active.id,
            sequence: this.entries.length,
            startedAt: active.startedAt,
            endedAt,
            reason: active.reason,
            status: "quarantined",
            privacyStatus: "quarantined",
            artifactId: artifact.id,
          };
          artifact.observation = { ...artifact.observation, timelineEntry: entry };
          this.traceArtifacts.push(artifact);
          this.entries.push(entry);
          return;
        }
        await this.options.sanitize(active.path);
        if (!this.options.admitSanitized || !(await this.options.admitSanitized(active.path))) {
          await rm(active.path, { force: true });
          const artifact: Artifact = {
            id: randomUUID(),
            kind: "trace",
            availability: "destroyed",
            privacyClassification: "uncertain",
            failureProvenance: "privacy",
            reasonCode: "TRACE_CLASSIFICATION_UNPROVEN",
            contentType: "application/zip",
            observation: { reasonCode: "TRACE_CLASSIFICATION_UNPROVEN", bytesDestroyed: true },
          };
          const entry: RecordingTimelineEntry = {
            type: "trace_segment",
            id: active.id,
            sequence: this.entries.length,
            startedAt: active.startedAt,
            endedAt,
            reason: active.reason,
            status: "quarantined",
            privacyStatus: "quarantined",
            artifactId: artifact.id,
          };
          artifact.observation = { ...artifact.observation, timelineEntry: entry };
          this.traceArtifacts.push(artifact);
          this.entries.push(entry);
          return;
        }
        const artifact = await availableArtifact(
          "trace",
          "application/zip",
          active.path,
          active.relativePath,
          {
            classification: "public",
            sanitation: {
              stage: "post_capture",
              method: "sanitizeTraceArchive",
              attestedAt: endedAt,
            },
          },
        );
        const entry: RecordingTimelineEntry = {
          type: "trace_segment",
          id: active.id,
          sequence: this.entries.length,
          startedAt: active.startedAt,
          endedAt,
          reason: active.reason,
          status: "available",
          privacyStatus: "verified_safe",
          artifactId: artifact.id,
        };
        artifact.observation = { ...artifact.observation, timelineEntry: entry };
        this.traceArtifacts.push(artifact);
        this.entries.push(entry);
      } catch {
        await rm(active.path, { force: true }).catch(() => undefined);
        this.sealed = true;
        this.entries.push({
          type: "trace_segment",
          id: active.id,
          sequence: this.entries.length,
          startedAt: active.startedAt,
          endedAt,
          reason: active.reason,
          status: "failed",
          privacyStatus: "quarantined",
          failureCode: "TRACE_STOP_FAILED",
        });
        throw new Error("TRACE_STOP_FAILED");
      }
    });
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.transition.then(work, work);
    this.transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function bounded<T>(work: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("TRACE_TRANSITION_TIMEOUT")), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
