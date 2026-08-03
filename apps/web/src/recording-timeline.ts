import type { Report } from "./api.js";

export type RecordingTimelineEntry =
  | {
      type: "video_segment";
      id: string;
      sequence: number;
      pageId: string;
      startedAt: string;
      endedAt: string;
      reason: string;
      status: "available" | "quarantined" | "failed";
      privacyStatus: "verified_safe" | "quarantined";
      artifactId?: string;
      failureCode?: string;
    }
  | {
      type: "protected_gap";
      id: string;
      sequence: number;
      operationId: string;
      startedAt: string;
      endedAt: string;
      reason: string;
      privacyStatus: "capture_suppressed";
    }
  | {
      type: "unavailable_interval";
      id: string;
      sequence: number;
      startedAt: string;
      endedAt: string;
      failureCode: string;
    }
  | {
      type: "trace_segment";
      id: string;
      sequence: number;
      startedAt: string;
      endedAt: string;
      reason: string;
      status: "available" | "quarantined" | "failed";
      privacyStatus: "verified_safe" | "quarantined";
      artifactId?: string;
      failureCode?: string;
    }
  | {
      type: "quarantine_record";
      id: string;
      sequence: number;
      channel: string;
      occurredAt: string;
      reasonCode: string;
      artifactId?: string;
    }
  | {
      type: "capture_epoch";
      id: string;
      sequence: number;
      epoch: number;
      contextId: string;
      startedAt: string;
      endedAt: string;
      startReason: "run_started" | "checkpoint_restored";
      endReason: "run_completed" | "checkpoint_context_destroyed" | "sealed" | "browser_lost";
      status: "completed" | "sealed";
    }
  | {
      type: "checkpoint_boundary";
      id: string;
      sequence: number;
      checkpointId: string;
      boundary: "established" | "context_destroyed" | "restoring" | "verified" | "failed";
      occurredAt: string;
      captureEpoch: number;
      reasonCode?: string;
      continuedAtStepId?: string;
    };

export function deriveRecordingTimeline(report: Report): RecordingTimelineEntry[] {
  return [...report.artifactTimeline]
    .filter((entry) =>
      ["video_segment", "protected_gap", "unavailable_interval"].includes(entry.type),
    )
    .sort((left, right) => left.sequence - right.sequence);
}

export function deriveRecoveryTimeline(report: Report) {
  return [...report.artifactTimeline]
    .filter(
      (
        entry,
      ): entry is Extract<
        RecordingTimelineEntry,
        { type: "capture_epoch" | "checkpoint_boundary" }
      > => entry.type === "capture_epoch" || entry.type === "checkpoint_boundary",
    )
    .sort((left, right) => left.sequence - right.sequence);
}
