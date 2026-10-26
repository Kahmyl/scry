import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChronicleReplayRendererPort, EvidenceWriteAdmission } from "@scry/contracts";
import {
  EvidenceArtifactFailure,
  isArtifactFilesystemFailure,
} from "./evidence-artifact-failure.js";

// Call only around the named filesystem operation, never renderer, ownership,
// cancellation or database capabilities. An errno on an arbitrary error is not
// enough to classify it as an artifact failure.
async function replayFile<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isArtifactFilesystemFailure(error)) throw new EvidenceArtifactFailure("video_unavailable");
    throw error;
  }
}

interface ActionLedgerEntry {
  at?: string;
  tool?: string;
  arguments?: { element?: string; fields?: Array<{ name?: string }>; url?: string };
  outcome?: string;
  durationMs?: number;
}

export interface ReplayPublication {
  videoPath: string;
  framesDirectory: string;
  frameCount: number;
  networkRequests: number;
  durationMs: number;
  renderDurationMs: number;
  playbackRate: number;
  visibleFrameCount: number;
  reusedPublication: boolean;
}

async function readLedger(ledgerPath: string): Promise<ActionLedgerEntry[]> {
  try {
    return (await readFile(ledgerPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ActionLedgerEntry);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    if (error instanceof SyntaxError || isArtifactFilesystemFailure(error))
      throw new EvidenceArtifactFailure("video_unavailable");
    throw error;
  }
}

function captionFor(entry: ActionLedgerEntry | undefined): string {
  if (!entry) return "Sanitized replay · no browser action yet";
  const detail =
    entry.arguments?.element ??
    entry.arguments?.fields
      ?.map((field) => field.name)
      .filter(Boolean)
      .join(", ") ??
    entry.arguments?.url ??
    "";
  return [
    entry.tool,
    detail,
    entry.outcome,
    entry.durationMs === undefined ? undefined : `${entry.durationMs} ms`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export async function renderSanitizedReplay(options: {
  renderer: ChronicleReplayRendererPort;
  admission: EvidenceWriteAdmission;
  events: Array<Record<string, unknown>>;
  ledgerPath: string;
  outputDirectory: string;
  executablePath?: string;
  framesPerSecond?: number;
  playbackRate?: number;
}): Promise<ReplayPublication> {
  const admission = options.admission;
  await admission.checkpoint();
  if (options.events.length === 0) throw new Error("replay_events_required");
  const framesPerSecond = options.framesPerSecond ?? 4;
  const playbackRate = options.playbackRate ?? 8;
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 30)
    throw new Error("replay_frames_per_second_invalid");
  if (!Number.isFinite(playbackRate) || playbackRate < 1 || playbackRate > 32)
    throw new Error("replay_playback_rate_invalid");
  const parentDirectory = path.dirname(options.outputDirectory);
  const outputName = path.basename(options.outputDirectory);
  await replayFile(() => mkdir(parentDirectory, { recursive: true, mode: 0o700 }));
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({ rendererFormat: 2, events: options.events, framesPerSecond, playbackRate }),
    )
    .digest("hex");
  try {
    const published = JSON.parse(
      await readFile(path.join(options.outputDirectory, "publication.json"), "utf8"),
    ) as {
      complete?: boolean;
      inputDigest?: string;
      frameCount: number;
      networkRequests: number;
      durationMs: number;
      renderDurationMs: number;
      playbackRate: number;
      visibleFrameCount: number;
    };
    if (published.complete && published.inputDigest === inputDigest) {
      return {
        videoPath: path.join(options.outputDirectory, "sanitized-replay.webm"),
        framesDirectory: path.join(options.outputDirectory, "frames"),
        frameCount: published.frameCount,
        networkRequests: published.networkRequests,
        durationMs: published.durationMs,
        renderDurationMs: published.renderDurationMs,
        playbackRate: published.playbackRate,
        visibleFrameCount: published.visibleFrameCount,
        reusedPublication: true,
      };
    }
  } catch (error) {
    const absent = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (isArtifactFilesystemFailure(error) && !absent)
      throw new EvidenceArtifactFailure("video_unavailable");
    if (!(error instanceof SyntaxError) && !absent) throw error;
    // An absent or incomplete cache does not authorize reuse. Other read errors
    // are unavailable artifacts, not a promise that a clean cache miss occurred.
  }
  // Never clean another owner's staging directory or replace a publication.
  // The controller supplies a unique generation-scoped destination.
  const staging = path.join(
    parentDirectory,
    `${outputName}.partial-${process.pid}-${randomUUID()}`,
  );
  const framesDirectory = path.join(staging, "frames");
  await replayFile(() => mkdir(framesDirectory, { recursive: true, mode: 0o700 }));
  const ledger = await readLedger(options.ledgerPath);
  const firstTimestamp =
    typeof options.events[0]?.timestamp === "number" ? options.events[0].timestamp : Date.now();
  const lastEvent = options.events.at(-1);
  const lastTimestamp =
    typeof lastEvent?.timestamp === "number" ? lastEvent.timestamp : firstTimestamp;
  const durationMs = Math.max(1_000, lastTimestamp - firstTimestamp + 500);
  const renderDurationMs = Math.max(500, Math.ceil(durationMs / playbackRate));
  const frameCount = Math.max(3, Math.ceil((renderDurationMs / 1_000) * framesPerSecond));
  const frames = Array.from({ length: frameCount }, (_, index) => {
    const renderOffset = Math.min(renderDurationMs, Math.floor((index * 1_000) / framesPerSecond));
    const sourceOffset = Math.min(durationMs, Math.floor(renderOffset * playbackRate));
    const active = ledger
      .filter(
        (entry) =>
          (entry.at ? Date.parse(entry.at) : firstTimestamp) - firstTimestamp <= sourceOffset,
      )
      .at(-1);
    return { renderOffset, caption: captionFor(active) };
  });
  const rendered = await options.renderer.render({
    events: options.events,
    stagingDirectory: staging,
    framesDirectory,
    frames,
    renderDurationMs,
    playbackRate,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  const { networkRequests, visibleFrameCount } = rendered;
  if (rendered.replayFailed || visibleFrameCount < Math.ceil(frameCount / 2))
    throw new EvidenceArtifactFailure("video_unavailable");
  if (networkRequests !== 0) throw new EvidenceArtifactFailure("video_unavailable");
  if (!rendered.videoPath) throw new EvidenceArtifactFailure("video_unavailable");
  const videoPath = rendered.videoPath;
  admission.assertActive();
  const frameFiles = await (async () => {
    await replayFile(() => rename(videoPath, path.join(staging, "sanitized-replay.webm")));
    const frameFiles = (await replayFile(() => readdir(framesDirectory))).filter((name) =>
      name.endsWith(".png"),
    );
    const publication = {
      complete: true,
      inputDigest,
      frameCount: frameFiles.length,
      networkRequests,
      durationMs,
      renderDurationMs,
      playbackRate,
      visibleFrameCount,
    };
    await replayFile(() =>
      writeFile(path.join(staging, "publication.json"), JSON.stringify(publication, null, 2), {
        mode: 0o600,
      }),
    );
    await replayFile(() => rename(staging, options.outputDirectory));
    return frameFiles;
  })();
  admission.assertActive();
  return {
    videoPath: path.join(options.outputDirectory, "sanitized-replay.webm"),
    framesDirectory: path.join(options.outputDirectory, "frames"),
    frameCount: frameFiles.length,
    networkRequests,
    durationMs,
    renderDurationMs,
    playbackRate,
    visibleFrameCount,
    reusedPublication: false,
  };
}
