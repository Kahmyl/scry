import { randomUUID } from "node:crypto";

import type { Artifact, RecordingTimelineEntry } from "@scry/contracts";

import type { ExecutionReport } from "./types.js";

export class ExecutionState {
  terminalState: ExecutionReport["state"] = "infrastructure_error";
  timedOut = false;
  cancelled = false;
  activeStepId: string | undefined;
  fatalError: string | undefined;
  privacySealed = false;
  calibrationBoundaryReached = false;
  readonly establishedCheckpoints = new Set<string>();
  readonly retiredArtifacts: Artifact[] = [];
  readonly retiredTimeline: RecordingTimelineEntry[] = [];
  readonly lifecycleTimeline: RecordingTimelineEntry[] = [];
  captureEpoch = 0;
  private activeCaptureEpoch:
    Extract<RecordingTimelineEntry, { type: "capture_epoch" }> | undefined;

  startCaptureEpoch(
    startReason: "run_started" | "checkpoint_restored",
    contextId: string = randomUUID(),
  ) {
    this.captureEpoch += 1;
    this.activeCaptureEpoch = {
      type: "capture_epoch",
      id: randomUUID(),
      sequence: 0,
      epoch: this.captureEpoch,
      contextId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      startReason,
      endReason: "run_completed",
      status: "completed",
    };
    this.lifecycleTimeline.push(this.activeCaptureEpoch);
  }

  endCaptureEpoch(
    endReason: Extract<RecordingTimelineEntry, { type: "capture_epoch" }>["endReason"],
    status: "completed" | "sealed" = "completed",
  ) {
    if (!this.activeCaptureEpoch) return;
    this.activeCaptureEpoch.endedAt = new Date().toISOString();
    this.activeCaptureEpoch.endReason = endReason;
    this.activeCaptureEpoch.status = status;
    this.activeCaptureEpoch = undefined;
  }

  recordCheckpointBoundary(
    checkpointId: string,
    boundary: Extract<RecordingTimelineEntry, { type: "checkpoint_boundary" }>["boundary"],
    details: { reasonCode?: string; continuedAtStepId?: string } = {},
  ) {
    this.lifecycleTimeline.push({
      type: "checkpoint_boundary",
      id: randomUUID(),
      sequence: 0,
      checkpointId,
      boundary,
      occurredAt: new Date().toISOString(),
      captureEpoch: Math.max(this.captureEpoch, 1),
      ...details,
    });
  }
}
