// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Report } from "./api.js";
import { apiBlob } from "./api.js";
import { RecordingPlaylist } from "./App.js";
import {
  deriveRecordingTimeline,
  deriveRecoveryTimeline,
  type RecordingTimelineEntry,
} from "./recording-timeline.js";

vi.mock("./api.js", async (load) => ({
  ...(await load<typeof import("./api.js")>()),
  apiBlob: vi.fn().mockResolvedValue(new Blob(["webm"])),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const segment: RecordingTimelineEntry = {
  type: "video_segment",
  id: "11111111-1111-4111-8111-111111111111",
  sequence: 0,
  pageId: "page-1",
  startedAt: "2026-08-01T00:00:00.000Z",
  endedAt: "2026-08-01T00:00:01.000Z",
  reason: "run_started",
  status: "available",
  privacyStatus: "verified_safe",
  artifactId: "22222222-2222-4222-8222-222222222222",
};

const artifact = {
  id: "22222222-2222-4222-8222-222222222222",
  attemptId: "attempt-1",
  kind: "video",
  availability: "available" as const,
  privacyClassification: "safe" as const,
  contentType: "video/webm",
};

describe("recording timeline", () => {
  it("derives ordered entries for the current attempt", () => {
    const gap = {
      type: "protected_gap",
      id: "gap",
      sequence: 1,
      operationId: "op",
      startedAt: "2026-08-01T00:00:01.000Z",
      endedAt: "2026-08-01T00:00:02.000Z",
      reason: "test",
      privacyStatus: "capture_suppressed",
    };
    const report = {
      attempts: [{ id: "attempt-1" }],
      artifactTimeline: [gap, segment],
      events: [],
      artifacts: [artifact],
    } as unknown as Report;
    expect(deriveRecordingTimeline(report).map((entry) => entry.sequence)).toEqual([0, 1]);
  });

  it("projects recovery controls separately from playable recording entries", () => {
    const epoch: RecordingTimelineEntry = {
      type: "capture_epoch",
      id: "epoch",
      sequence: 0,
      epoch: 1,
      contextId: "context",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:01.000Z",
      startReason: "run_started",
      endReason: "run_completed",
      status: "completed",
    };
    const boundary: RecordingTimelineEntry = {
      type: "checkpoint_boundary",
      id: "boundary",
      sequence: 1,
      checkpointId: "checkpoint",
      boundary: "verified",
      occurredAt: "2026-08-01T00:00:01.000Z",
      captureEpoch: 1,
    };
    const report = {
      artifactTimeline: [epoch, boundary, { ...segment, sequence: 2 }],
      attempts: [],
      events: [],
      artifacts: [artifact],
    } as unknown as Report;
    expect(deriveRecoveryTimeline(report)).toEqual([epoch, boundary]);
    expect(deriveRecordingTimeline(report)).toEqual([{ ...segment, sequence: 2 }]);
  });

  it("revokes the current segment object URL on unmount", async () => {
    const createObjectURL = vi.fn(() => "blob:segment");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const view = render(<RecordingPlaylist entries={[segment]} artifacts={[artifact]} />);
    await waitFor(() => expect(screen.getByText("Segment 1 of 1")).toBeTruthy());
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:segment");
  });

  it("does not reload a segment when its parent supplies equivalent timeline objects", async () => {
    const createObjectURL = vi.fn(() => "blob:stable-segment");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const view = render(
      <RecordingPlaylist entries={[{ ...segment }]} artifacts={[{ ...artifact }]} />,
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    view.rerender(<RecordingPlaylist entries={[{ ...segment }]} artifacts={[{ ...artifact }]} />);

    await waitFor(() => expect(screen.getByText("Segment 1 of 1")).toBeTruthy());
    expect(vi.mocked(apiBlob)).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("never autoplays or advances a completed recording segment", async () => {
    const createObjectURL = vi.fn(() => "blob:manual-segment");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    render(
      <RecordingPlaylist
        entries={[segment, { ...segment, id: "55555555-5555-4555-8555-555555555555", sequence: 1 }]}
        artifacts={[artifact]}
      />,
    );

    const video = await screen.findByText("Your browser does not support WebM video.");
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect((video as HTMLVideoElement).autoplay).toBe(false);
    fireEvent.ended(video);
    expect(screen.getByText("Segment 1 of 2")).toBeTruthy();
  });

  it("shows a centered play action while paused and hides it while playing", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:playable-segment"),
      revokeObjectURL: vi.fn(),
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    render(<RecordingPlaylist entries={[segment]} artifacts={[artifact]} />);

    const video = await screen.findByText("Your browser does not support WebM video.");
    const overlay = screen.getByRole("button", { name: "Play recording segment 1" });
    fireEvent.click(overlay);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.play(video);
    expect(screen.queryByRole("button", { name: "Play recording segment 1" })).toBeNull();
    fireEvent.pause(video);
    expect(screen.getByRole("button", { name: "Play recording segment 1" })).toBeTruthy();
  });

  it("places prominent previous and next actions in the recording header", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:navigation-segment"),
      revokeObjectURL: vi.fn(),
    });
    render(
      <RecordingPlaylist
        entries={[segment, { ...segment, id: "77777777-7777-4777-8777-777777777777", sequence: 1 }]}
        artifacts={[artifact]}
      />,
    );
    await screen.findByText("Your browser does not support WebM video.");

    const header = screen.getByText("Run recording").closest(".run-recording-head");
    expect(header?.querySelector(".recording-segment-nav")).toBeTruthy();
    expect(header?.querySelectorAll("button")).toHaveLength(2);
  });

  it("does not automatically advance protected or unavailable intervals", () => {
    vi.useFakeTimers();
    const gap: RecordingTimelineEntry = {
      type: "protected_gap",
      id: "66666666-6666-4666-8666-666666666666",
      sequence: 0,
      operationId: "operation",
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:01.000Z",
      reason: "protected transaction",
      privacyStatus: "capture_suppressed",
    };
    render(
      <RecordingPlaylist entries={[gap, { ...segment, sequence: 1 }]} artifacts={[artifact]} />,
    );

    vi.advanceTimersByTime(5_000);
    expect(screen.getByText("Segment 1 of 2")).toBeTruthy();
    expect(screen.getByText("Protected operation")).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows a failed middle segment and lets playback continue", () => {
    const { artifactId: _artifactId, ...segmentWithoutArtifact } = segment as Extract<
      RecordingTimelineEntry,
      { type: "video_segment" }
    >;
    const failed: RecordingTimelineEntry = {
      ...segmentWithoutArtifact,
      id: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      status: "failed",
      privacyStatus: "quarantined",
      failureCode: "SCREENCAST_STOP_FAILED",
    };
    render(
      <RecordingPlaylist
        entries={[
          segment,
          failed,
          { ...segment, id: "44444444-4444-4444-8444-444444444444", sequence: 2 },
        ]}
        artifacts={[artifact]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("Recording interval unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("Segment 3 of 3")).toBeTruthy();
  });
});
