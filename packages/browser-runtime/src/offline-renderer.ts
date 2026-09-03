import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

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
  } catch {
    return [];
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
  events: Array<Record<string, unknown>>;
  ledgerPath: string;
  outputDirectory: string;
  executablePath?: string;
  framesPerSecond?: number;
  playbackRate?: number;
}): Promise<ReplayPublication> {
  if (options.events.length === 0) throw new Error("replay_events_required");
  const framesPerSecond = options.framesPerSecond ?? 4;
  const playbackRate = options.playbackRate ?? 8;
  if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 30)
    throw new Error("replay_frames_per_second_invalid");
  if (!Number.isFinite(playbackRate) || playbackRate < 1 || playbackRate > 32)
    throw new Error("replay_playback_rate_invalid");
  const parentDirectory = path.dirname(options.outputDirectory);
  const outputName = path.basename(options.outputDirectory);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const inputDigest = createHash("sha256")
    .update(
      JSON.stringify({ rendererVersion: 2, events: options.events, framesPerSecond, playbackRate }),
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
  } catch {
    // No complete matching publication exists.
  }
  for (const name of await readdir(parentDirectory)) {
    if (name.startsWith(`${outputName}.partial-`))
      await rm(path.join(parentDirectory, name), { recursive: true, force: true });
  }
  const staging = path.join(
    parentDirectory,
    `${outputName}.partial-${process.pid}-${randomUUID()}`,
  );
  const framesDirectory = path.join(staging, "frames");
  await mkdir(framesDirectory, { recursive: true, mode: 0o700 });
  const ledger = await readLedger(options.ledgerPath);
  const firstTimestamp =
    typeof options.events[0]?.timestamp === "number" ? options.events[0].timestamp : Date.now();
  const lastEvent = options.events.at(-1);
  const lastTimestamp =
    typeof lastEvent?.timestamp === "number" ? lastEvent.timestamp : firstTimestamp;
  const durationMs = Math.max(1_000, lastTimestamp - firstTimestamp + 500);
  const renderDurationMs = Math.max(500, Math.ceil(durationMs / playbackRate));
  const frameCount = Math.max(3, Math.ceil((renderDurationMs / 1_000) * framesPerSecond));
  const browser = await chromium.launch({
    headless: true,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1_280, height: 720 },
    serviceWorkers: "block",
    recordVideo: { dir: staging, size: { width: 1_280, height: 720 } },
  });
  let replayFailed = false;
  let networkRequests = 0;
  await context.route("**/*", async (route) => {
    networkRequests += 1;
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", () => {
    replayFailed = true;
  });
  page.on("crash", () => {
    replayFailed = true;
  });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#e5e7eb}
    #replay{position:absolute;inset:0 0 56px 0;background:#fff}
    #caption{position:absolute;left:0;right:0;bottom:0;height:56px;box-sizing:border-box;padding:10px 18px;background:#111827;color:#f9fafb;font:14px/18px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style><div id="replay"></div><div id="caption">Sanitized replay</div>`);
  const require = createRequire(import.meta.url);
  await page.addScriptTag({
    path: path.resolve(path.dirname(require.resolve("rrweb")), "../umd/rrweb.min.js"),
  });
  await page.evaluate(
    ({ recordedEvents, replaySpeed }) => {
      const host = globalThis as unknown as {
        rrweb: {
          Replayer: new (
            events: unknown[],
            options: Record<string, unknown>,
          ) => { play(offset: number): void };
        };
        __scryReplayer?: { play(offset: number): void };
      };
      host.__scryReplayer = new host.rrweb.Replayer(recordedEvents, {
        root: document.querySelector("#replay"),
        showWarning: false,
        showDebug: false,
        mouseTail: false,
        UNSAFE_replayCanvas: false,
        speed: replaySpeed,
      });
      host.__scryReplayer.play(0);
    },
    { recordedEvents: options.events, replaySpeed: playbackRate },
  );
  let elapsed = 0;
  let visibleFrameCount = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const renderOffset = Math.min(renderDurationMs, Math.floor((index * 1_000) / framesPerSecond));
    const sourceOffset = Math.min(durationMs, Math.floor(renderOffset * playbackRate));
    const active = ledger
      .filter(
        (entry) =>
          (entry.at ? Date.parse(entry.at) : firstTimestamp) - firstTimestamp <= sourceOffset,
      )
      .at(-1);
    await page.evaluate((caption) => {
      const element = document.querySelector("#caption");
      if (element) element.textContent = caption;
    }, captionFor(active));
    await page.waitForTimeout(Math.max(0, renderOffset - elapsed));
    elapsed = renderOffset;
    const hasVisibleDocument = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>("#replay iframe");
      const body = frame?.contentDocument?.body;
      return Boolean(body && (body.children.length > 0 || body.textContent?.trim()));
    });
    if (hasVisibleDocument) visibleFrameCount += 1;
    await page.screenshot({
      path: path.join(framesDirectory, `frame-${String(index).padStart(6, "0")}.png`),
    });
  }
  if (elapsed < renderDurationMs) await page.waitForTimeout(renderDurationMs - elapsed);
  const video = page.video();
  await context.close();
  await browser.close();
  if (visibleFrameCount < Math.ceil(frameCount / 2)) replayFailed = true;
  if (replayFailed) throw new Error("replay_execution_failed");
  if (networkRequests !== 0) throw new Error(`replay_network_attempts:${networkRequests}`);
  if (!video) throw new Error("replay_video_unavailable");
  await rename(await video.path(), path.join(staging, "sanitized-replay.webm"));
  const frameFiles = (await readdir(framesDirectory)).filter((name) => name.endsWith(".png"));
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
  await writeFile(path.join(staging, "publication.json"), JSON.stringify(publication, null, 2), {
    mode: 0o600,
  });
  await rm(options.outputDirectory, { recursive: true, force: true });
  await rename(staging, options.outputDirectory);
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
