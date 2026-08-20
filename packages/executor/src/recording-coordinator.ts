import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  recordingTimelineSchema,
  type Artifact,
  type RecordingTimelineEntry,
} from "@scry/contracts";
import type { Page } from "playwright";
import {
  observeAndMaskPraxisVisualRegions,
  startPraxisScreencast,
  stopPraxisScreencast,
} from "@scry/praxis";
import type { VeilVideoSegmentFinalization, VeilVideoSegmentPermit } from "@scry/contracts";

import { availableArtifact } from "./artifacts.js";
import type {
  VeilVisualMaskObservation,
  VeilVideoSegmentAuthority,
  VeilVideoSegmentBinding,
} from "@scry/veil";

type SegmentReason = "run_started" | "safe_resume" | "page_switch" | "document_resume";
type StopReason =
  | "protected_operation"
  | "page_switch"
  | "document_transition"
  | "run_completed"
  | "run_failed"
  | "browser_closed";
type RecordingEvent =
  | "recording.segment_started"
  | "recording.segment_stopped"
  | "recording.gap_started"
  | "recording.gap_ended"
  | "recording.sealed";

const defaultTransitionTimeoutMs = 5_000;

type ActiveSegment = {
  id: string;
  sequence: number;
  page: Page;
  pageId: string;
  reason: SegmentReason;
  startedAt: string;
  filePath: string;
  relativePath: string;
  veilPermit?: VeilVideoSegmentPermit;
  veilBinding?: VeilVideoSegmentBinding;
  veilPoll?: ReturnType<typeof setInterval>;
  veilCheckpoint?: Promise<void> | undefined;
  veilFailure?: unknown;
};

type OpenGap = {
  id: string;
  sequence: number;
  operationId: string;
  reason: string;
  startedAt: string;
};

type OpenDocumentTransition = {
  id: string;
  sequence: number;
  operationId: string;
  startedAt: string;
};

export type RecordingCoordinatorOptions = {
  outputDirectory: string;
  emit?: (type: RecordingEvent, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
  createId?: () => string;
  videoAuthority?: VeilVideoSegmentAuthority;
  videoBinding?: () => VeilVideoSegmentBinding;
  observeVisualMask?: (page: Page) => Promise<VeilVisualMaskObservation>;
  transitionTimeoutMs?: number;
  abortCapture?: () => Promise<void>;
};

export class RecordingCoordinator {
  private readonly timelineEntries: RecordingTimelineEntry[] = [];
  private readonly recordedArtifacts: Artifact[] = [];
  private readonly pageIds = new WeakMap<Page, string>();
  private transition = Promise.resolve();
  private activePage: Page | undefined;
  private activeSegment: ActiveSegment | undefined;
  private openGap: OpenGap | undefined;
  private openDocumentTransition: OpenDocumentTransition | undefined;
  private sealed = false;
  private finalized = false;

  constructor(private readonly options: RecordingCoordinatorOptions) {}

  hasActiveSegment() {
    return Boolean(this.activeSegment);
  }

  startSegment(input: { page?: Page; reason: SegmentReason }) {
    return this.serial(async () => {
      this.requireOpen();
      const page = input.page ?? this.activePage;
      if (!page || page.isClosed()) {
        const startedAt = this.now();
        this.timelineEntries.push(this.unavailable(startedAt, "ACTIVE_PAGE_UNAVAILABLE"));
        return this.sealUnsafe("ACTIVE_PAGE_UNAVAILABLE");
      }
      if (this.activeSegment) throw new Error("A screencast segment is already active");
      await this.closeGap();
      this.activePage = page;
      const id = this.options.createId?.() ?? randomUUID();
      const sequence = this.timelineEntries.length;
      const relativePath = path.posix.join(
        "video",
        `segment-${String(sequence).padStart(4, "0")}-${id}.webm`,
      );
      const filePath = path.join(this.options.outputDirectory, ...relativePath.split("/"));
      await mkdir(path.dirname(filePath), { recursive: true });
      const segment: ActiveSegment = {
        id,
        sequence,
        page,
        pageId: this.pageId(page),
        reason: input.reason,
        startedAt: this.now(),
        filePath,
        relativePath,
      };
      try {
        await this.armVideoVeil(segment);
        // Tracing and recording share Playwright's Chromium screencast. Let the
        // active screencast negotiate its own dimensions so the WebM canvas
        // always matches the incoming frames. Forcing the run viewport here
        // makes Playwright pad smaller shared frames with gray pixels.
        await this.bounded(startPraxisScreencast(page, filePath), "SCREENCAST_START_TIMEOUT");
      } catch (error) {
        this.timelineEntries.push(this.unavailable(segment.startedAt, "SCREENCAST_START_FAILED"));
        await this.sealUnsafe("SCREENCAST_START_FAILED");
        return;
      }
      this.activeSegment = segment;
      await this.emit("recording.segment_started", {
        id,
        sequence,
        pageId: segment.pageId,
        reason: input.reason,
      });
    });
  }

  stopSegment(input: { reason: StopReason }) {
    return this.serial(() => this.stopActive(input.reason, false));
  }

  createProtectedGap(input: { operationId: string; reason: string }) {
    return this.serial(async () => {
      this.requireOpen();
      if (this.openGap) throw new Error("A protected recording gap is already open");
      await this.stopActive("protected_operation", false);
      if (this.sealed) return;
      this.openGap = {
        id: this.options.createId?.() ?? randomUUID(),
        sequence: this.timelineEntries.length,
        operationId: input.operationId,
        reason: input.reason,
        startedAt: this.now(),
      };
      await this.emit("recording.gap_started", { ...this.openGap });
    });
  }

  beginDocumentTransition(input: { operationId: string }) {
    return this.serial(async () => {
      this.requireOpen();
      if (this.openGap) {
        throw new Error("DOCUMENT_TRANSITION_DURING_PROTECTED_GAP");
      }
      if (this.openDocumentTransition) {
        throw new Error("DOCUMENT_TRANSITION_ALREADY_OPEN");
      }

      // The final Veil checkpoint for the old document must happen before
      // browser navigation can destroy its execution context.
      await this.stopActive("document_transition", false);

      if (this.sealed) {
        throw new Error("DOCUMENT_TRANSITION_RECORDING_STOP_FAILED");
      }

      this.openDocumentTransition = {
        id: this.options.createId?.() ?? randomUUID(),
        sequence: this.timelineEntries.length,
        operationId: input.operationId,
        startedAt: this.now(),
      };

      await this.emit("recording.gap_started", {
        type: "document_transition_gap",
        ...this.openDocumentTransition,
        reason: "navigation_boundary",
      });
    });
  }

  completeDocumentTransition(page: Page) {
    return this.serial(async () => {
      this.requireOpen();

      if (!this.openDocumentTransition) {
        throw new Error("DOCUMENT_TRANSITION_NOT_OPEN");
      }

      if (page.isClosed()) {
        const transition = this.openDocumentTransition;
        this.openDocumentTransition = undefined;
        this.timelineEntries.push(
          this.unavailable(
            transition.startedAt,
            "DOCUMENT_TRANSITION_PAGE_UNAVAILABLE",
          ),
        );
        await this.sealUnsafe("DOCUMENT_TRANSITION_PAGE_UNAVAILABLE");
        throw new Error("DOCUMENT_TRANSITION_PAGE_UNAVAILABLE");
      }

      // The caller must independently qualify the new document through
      // Praxis/Veil before invoking this method.
      this.activePage = page;
      await this.closeDocumentTransitionGap();

      if (!this.sealed) {
        await this.startInternal(page, "document_resume");
      }

      if (this.sealed) {
        throw new Error("DOCUMENT_TRANSITION_RECORDING_RESUME_FAILED");
      }
    });
  }

  failDocumentTransition(failureCode: string) {
    return this.serial(async () => {
      const transition = this.openDocumentTransition;
      if (transition) {
        this.openDocumentTransition = undefined;
        const entry = this.unavailable(transition.startedAt, failureCode);
        this.timelineEntries.push(entry);
        await this.emit("recording.gap_ended", {
          type: "document_transition_gap",
          failureCode,
          entry,
        });
      }

      await this.sealUnsafe(failureCode);
    });
  }

  switchActivePage(page: Page) {
    return this.serial(async () => {
      this.requireOpen();
      if (page.isClosed()) {
        const startedAt = this.now();
        this.timelineEntries.push(this.unavailable(startedAt, "ACTIVE_PAGE_UNAVAILABLE"));
        return this.sealUnsafe("ACTIVE_PAGE_UNAVAILABLE");
      }
      if (this.activeSegment) await this.stopActive("page_switch", false);
      this.activePage = page;
      if (!this.sealed) await this.startInternal(page, "page_switch");
    });
  }

  seal(reason: string) {
    return this.serial(async () => {
      if (this.finalized) return;
      await this.sealUnsafe(reason);
    });
  }

  finalize() {
    return this.serial(async () => {
      if (this.finalized) return;
      if (this.activeSegment) await this.stopActive("run_completed", this.sealed);

      if (this.openDocumentTransition) {
        const transition = this.openDocumentTransition;
        this.openDocumentTransition = undefined;
        this.timelineEntries.push(
          this.unavailable(
            transition.startedAt,
            "DOCUMENT_TRANSITION_INCOMPLETE",
          ),
        );
        await this.sealUnsafe("DOCUMENT_TRANSITION_INCOMPLETE");
      }

      await this.closeGap();
      this.finalized = true;
    });
  }

  timeline() {
    return recordingTimelineSchema.parse(structuredClone(this.timelineEntries));
  }

  artifacts() {
    return structuredClone(this.recordedArtifacts);
  }

  isSealed() {
    return this.sealed;
  }

  isFinalized() {
    return this.finalized;
  }

  private async startInternal(page: Page, reason: SegmentReason) {
    await this.closeGap();
    const id = this.options.createId?.() ?? randomUUID();
    const sequence = this.timelineEntries.length;
    const relativePath = path.posix.join(
      "video",
      `segment-${String(sequence).padStart(4, "0")}-${id}.webm`,
    );
    const filePath = path.join(this.options.outputDirectory, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    const segment: ActiveSegment = {
      id,
      sequence,
      page,
      pageId: this.pageId(page),
      reason,
      startedAt: this.now(),
      filePath,
      relativePath,
    };
    try {
      await this.armVideoVeil(segment);
      await this.bounded(startPraxisScreencast(page, filePath), "SCREENCAST_START_TIMEOUT");
      this.activeSegment = segment;
      await this.emit("recording.segment_started", {
        id,
        sequence,
        pageId: segment.pageId,
        reason,
      });
    } catch {
      this.timelineEntries.push(this.unavailable(segment.startedAt, "SCREENCAST_START_FAILED"));
      await this.sealUnsafe("SCREENCAST_START_FAILED");
    }
  }

  private async stopActive(reason: StopReason, quarantined: boolean) {
    const segment = this.activeSegment;
    if (!segment) return;
    this.activeSegment = undefined;
    if (segment.veilPoll) clearInterval(segment.veilPoll);
    await segment.veilCheckpoint?.catch(() => undefined);
    let stopFailed = false;
    try {
      await this.bounded(stopPraxisScreencast(segment.page), "SCREENCAST_STOP_TIMEOUT");
    } catch {
      stopFailed = true;
    }
    const endedAt = this.now();
    if (stopFailed) {
      await rm(segment.filePath, { force: true }).catch(() => undefined);
      this.timelineEntries.push({
        type: "video_segment",
        id: segment.id,
        sequence: segment.sequence,
        pageId: segment.pageId,
        startedAt: segment.startedAt,
        endedAt,
        reason: segment.reason,
        status: "failed",
        privacyStatus: "quarantined",
        failureCode: "SCREENCAST_STOP_FAILED",
      });
      await this.emit("recording.segment_stopped", { entry: this.timelineEntries.at(-1) });
      await this.sealUnsafe("SCREENCAST_STOP_FAILED");
      return;
    }
    try {
      await stat(segment.filePath).catch(() => {
        throw new Error("SEGMENT_FILE_MISSING");
      });
      if (segment.veilFailure) throw segment.veilFailure;
      let videoFinalization: VeilVideoSegmentFinalization | undefined;
      if (segment.veilPermit && segment.veilBinding && this.options.videoAuthority) {
        await this.checkpointVideoVeil(segment).catch(() => {
          throw new Error("VEIL_VIDEO_FINALIZATION_FAILED");
        });
        videoFinalization = this.options.videoAuthority.finalize(
          segment.veilPermit,
          segment.veilBinding,
        );
      }
      const artifact = await availableArtifact(
        "video",
        "video/webm",
        segment.filePath,
        segment.relativePath,
        {
          classification: "public",
          ...(videoFinalization ? { videoFinalization } : {}),
        },
      );
      if (quarantined || this.sealed) {
        await rm(segment.filePath, { force: true }).catch(() => undefined);
        artifact.availability = "destroyed";
        artifact.privacyClassification = "uncertain";
        artifact.failureProvenance = "privacy";
        artifact.reasonCode = "RECORDING_SEALED";
        artifact.observation = { quarantined: true, reasonCode: "RECORDING_SEALED" };
      }
      this.recordedArtifacts.push(artifact);
      const entry: RecordingTimelineEntry = {
        type: "video_segment",
        id: segment.id,
        sequence: segment.sequence,
        pageId: segment.pageId,
        startedAt: segment.startedAt,
        endedAt,
        reason: segment.reason,
        status: quarantined || this.sealed ? "quarantined" : "available",
        privacyStatus: quarantined || this.sealed ? "quarantined" : "verified_safe",
        artifactId: artifact.id,
      };
      artifact.observation = { ...artifact.observation, timelineEntry: entry };
      this.timelineEntries.push(entry);
      await this.emit("recording.segment_stopped", { reason, entry });
    } catch (error) {
      await rm(segment.filePath, { force: true }).catch(() => undefined);
      if (error instanceof Error && error.message.includes("VEIL_VIDEO_CAPTURE_PERMIT_REQUIRED")) {
        const artifact: Artifact = {
          id: randomUUID(),
          kind: "video",
          availability: "destroyed",
          privacyClassification: "uncertain",
          failureProvenance: "privacy",
          reasonCode: "VEIL_VIDEO_CAPTURE_PERMIT_REQUIRED",
          contentType: "video/webm",
          relativePath: segment.relativePath,
          observation: { bytesDestroyed: true, reasonCode: "VEIL_VIDEO_CAPTURE_PERMIT_REQUIRED" },
        };
        this.recordedArtifacts.push(artifact);
        this.timelineEntries.push({
          type: "video_segment",
          id: segment.id,
          sequence: segment.sequence,
          pageId: segment.pageId,
          startedAt: segment.startedAt,
          endedAt,
          reason: segment.reason,
          status: "quarantined",
          privacyStatus: "quarantined",
          artifactId: artifact.id,
        });
        await this.emit("recording.segment_stopped", {
          reason,
          entry: this.timelineEntries.at(-1),
        });
        return;
      }
      const failureCode = segmentFailureCode(error);
      this.timelineEntries.push({
        type: "video_segment",
        id: segment.id,
        sequence: segment.sequence,
        pageId: segment.pageId,
        startedAt: segment.startedAt,
        endedAt,
        reason: segment.reason,
        status: "failed",
        privacyStatus: "quarantined",
        failureCode,
      });
      await this.emit("recording.segment_stopped", { entry: this.timelineEntries.at(-1) });
      await this.sealUnsafe(failureCode);
    }
  }

  private async armVideoVeil(segment: ActiveSegment) {
    if (!this.options.videoAuthority || !this.options.videoBinding)
      throw new Error("VEIL_VIDEO_AUTHORITY_REQUIRED");
    const binding = this.options.videoBinding();
    const permit = this.options.videoAuthority.issue(segment.id, binding);
    segment.veilBinding = binding;
    segment.veilPermit = permit;
    await this.checkpointVideoVeil(segment);
    segment.veilPoll = setInterval(() => {
      if (segment.veilCheckpoint || segment.veilFailure) return;
      segment.veilCheckpoint = this.checkpointVideoVeil(segment)
        .then(() => undefined)
        .catch((error) => {
          segment.veilFailure = error;
          void stopPraxisScreencast(segment.page).catch(() => undefined);
        })
        .finally(() => {
          segment.veilCheckpoint = undefined;
        });
    }, 100);
  }

  private async checkpointVideoVeil(segment: ActiveSegment) {
    if (!this.options.videoAuthority || !segment.veilPermit || !segment.veilBinding)
      throw new Error("VEIL_VIDEO_AUTHORITY_REQUIRED");
    const observation = await (this.options.observeVisualMask ?? observeAndMaskPraxisVisualRegions)(
      segment.page,
    );
    return this.options.videoAuthority.checkpoint(
      observation,
      segment.veilPermit,
      segment.veilBinding,
    );
  }

  private async closeDocumentTransitionGap() {
    const gap = this.openDocumentTransition;
    if (!gap) return;

    this.openDocumentTransition = undefined;

    const entry: RecordingTimelineEntry = {
      type: "document_transition_gap",
      ...gap,
      endedAt: this.now(),
      reason: "navigation_boundary",
      captureStatus: "intentionally_suppressed",
    };

    this.timelineEntries.push(entry);
    await this.emit("recording.gap_ended", { entry });
  }

  private async closeGap() {
    const gap = this.openGap;
    if (!gap) return;
    this.openGap = undefined;
    const entry: RecordingTimelineEntry = {
      type: "protected_gap",
      ...gap,
      endedAt: this.now(),
      privacyStatus: "capture_suppressed",
    };
    this.timelineEntries.push(entry);
    await this.emit("recording.gap_ended", { entry });
  }

  private async sealUnsafe(reason: string) {
    if (this.sealed) return;
    this.sealed = true;
    await this.emit("recording.sealed", { reason });
    if (this.activeSegment) await this.stopActive("run_failed", true);
  }

  private unavailable(startedAt: string, failureCode: string): RecordingTimelineEntry {
    return {
      type: "unavailable_interval",
      id: this.options.createId?.() ?? randomUUID(),
      sequence: this.timelineEntries.length,
      startedAt,
      endedAt: this.now(),
      failureCode,
    };
  }

  private pageId(page: Page) {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = this.options.createId?.() ?? randomUUID();
    this.pageIds.set(page, id);
    return id;
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private emit(type: RecordingEvent, payload: Record<string, unknown>) {
    return this.options.emit?.(type, payload) ?? Promise.resolve();
  }

  private requireOpen() {
    if (this.finalized) throw new Error("Recording coordinator is finalized");
    if (this.sealed) throw new Error("Recording coordinator is sealed");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async bounded<T>(operation: Promise<T>, code: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(async () => {
            await this.options.abortCapture?.().catch(() => undefined);
            reject(new Error(code));
          }, this.options.transitionTimeoutMs ?? defaultTransitionTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function segmentFailureCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "SEGMENT_FILE_MISSING") return error.message;
    if (error.message === "VEIL_VIDEO_FINALIZATION_FAILED") return error.message;
    if (error.message.includes("Execution context was destroyed")) {
      return "VEIL_VIDEO_DOCUMENT_CONTEXT_LOST";
    }
    if (error.message.includes("VEIL_VIDEO")) return "VEIL_VIDEO_ADMISSION_FAILED";
  }
  return "SEGMENT_MEDIA_VALIDATION_FAILED";
}
