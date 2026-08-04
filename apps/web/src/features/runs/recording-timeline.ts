import type { RecordingTimelineEntry, Report } from "../../infrastructure/api/client.js";

export type { RecordingTimelineEntry } from "../../infrastructure/api/client.js";

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
