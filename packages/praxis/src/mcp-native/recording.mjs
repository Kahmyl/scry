import { spawn, fork, execFile } from "node:child_process";
import { mkdir, stat, writeFile, rename, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayLayout } from "./display-layout.mjs";
const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ended = (child) => child.exitCode !== null || child.signalCode !== null;
async function stop(child, signal = "SIGINT") {
  if (!child || ended(child)) return;
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal);
  await Promise.race([exit, delay(5000)]);
  if (!ended(child)) {
    child.kill("SIGKILL");
    await exit;
  }
}
export async function inspectRecording(directory) {
  const file = path.join(directory, "recording.mp4");
  try {
    const { stdout } = await exec(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", file],
      { timeout: 10000 },
    );
    return { ...JSON.parse(stdout).format, file };
  } catch {
    return { file, unavailable: true };
  }
}
export async function recording(
  directory,
  { maxBytes = 256 * 1024 * 1024, maxMs = Infinity, capture = displayLayout.capture } = {},
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--child", directory, String(maxBytes), String(maxMs), JSON.stringify(capture)],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (b) => {
    diagnostics = (diagnostics + b).slice(-1000);
  });
  let progress = { coverage: "recording" };
  child.on("message", (m) => {
    if (m.type === "coverage") progress = { coverage: m.coverage, reason: m.reason };
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RECORDER_START_TIMEOUT")), 15000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("RECORDER_START_FAILED")));
    child.on("message", (m) => {
      if (m.type === "ready") {
        clearTimeout(timer);
        resolve(m);
      }
    });
  }).catch(async (error) => {
    await stop(child);
    throw error;
  });
  let closePromise;
  return {
    display: ready.display,
    pid: child.pid,
    get status() {
      return progress;
    },
    async close(reason = "complete") {
      return (closePromise ??= (async () => {
        if (!ended(child)) {
          const exit = new Promise((resolve) => child.once("exit", resolve));
          child.send({ type: "close", reason });
          await Promise.race([exit, delay(10000)]);
          if (!ended(child)) await stop(child, "SIGTERM");
        }
        try {
          return JSON.parse(await readFile(path.join(directory, "recording.json"), "utf8"));
        } catch {
          return {
            ...(await inspectRecording(directory)),
            coverage: "partial",
            reason: "recorder_lost",
            diagnostic: "Recorder ended without a final receipt",
          };
        }
      })());
    },
  };
}

if (process.argv[2] === "--child") {
  const [directory, maxBytes, maxMs] = process.argv.slice(3);
  const capture = JSON.parse(process.argv[6]);
  let display,
    ffmpeg,
    xvfb,
    stopping,
    coverage = "complete",
    reason = "complete";
  let started = Date.now(),
    timingOrigin = "recorder_start";
  const manifest = async () => {
    const receipt = {
      ...(await inspectRecording(directory)),
      coverage,
      reason,
      started,
      timingOrigin,
      ended: Date.now(),
      timing: "native_realtime",
      masking: "best_effort",
      capture,
    };
    if (receipt.unavailable) receipt.coverage = "unavailable";
    const tmp = path.join(directory, "recording.json.tmp");
    await writeFile(tmp, JSON.stringify(receipt), { mode: 0o600 });
    await rename(tmp, path.join(directory, "recording.json"));
    return receipt;
  };
  async function stopVideo(why) {
    if (why !== "complete") {
      coverage = "partial";
      reason = why;
    }
    await stop(ffmpeg);
    await manifest();
  }
  const close = (why) =>
    (stopping ??= (async () => {
      clearInterval(monitor);
      await stopVideo(why);
      await stop(xvfb, "SIGTERM");
      process.exit(0);
    })());
  let monitor;
  process.on("disconnect", () => void close("parent_lost"));
  process.on("message", (m) => {
    if (m.type === "close") void close(m.reason);
  });
  process.on("SIGTERM", () => void close("recorder_terminated"));
  try {
    xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", capture.screen, "-nolisten", "tcp"], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    display = await new Promise((resolve, reject) => {
      let text = "";
      xvfb.once("error", reject);
      xvfb.once("exit", () => reject(new Error("XVFB_FAILED")));
      xvfb.stdio[3].on("data", (b) => {
        text += b;
        if (text.includes("\n")) resolve(":" + text.trim());
      });
    });
    ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostats",
        "-f",
        "x11grab",
        "-draw_mouse",
        "1",
        "-framerate",
        "20",
        "-video_size",
        capture.size,
        "-i",
        display + "+" + capture.x + "," + capture.y,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "40",
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "1000000",
        "-y",
        path.join(directory, "recording.mp4"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let captureHeader = "";
    ffmpeg.stderr.on("data", (chunk) => {
      if (timingOrigin === "native_capture") return;
      captureHeader = (captureHeader + chunk.toString("utf8")).slice(-32768);
      const match = captureHeader.match(/start:\s*(\d+\.\d+)/);
      if (match) {
        const epoch = Math.round(Number(match[1]) * 1000);
        if (Number.isSafeInteger(epoch) && Math.abs(Date.now() - epoch) < 30000) {
          started = epoch;
          timingOrigin = "native_capture";
        }
      }
    });
    ffmpeg.on("error", () => {
      coverage = "unavailable";
      reason = "encoder_start_failed";
    });
    await delay(350);
    if (ended(ffmpeg)) throw new Error("ENCODER_FAILED");
    monitor = setInterval(async () => {
      if (ended(ffmpeg)) return;
      const bytes = (await stat(path.join(directory, "recording.mp4")).catch(() => ({ size: 0 })))
        .size;
      if (bytes > Number(maxBytes) || Date.now() - started > Number(maxMs)) {
        clearInterval(monitor);
        await stopVideo(bytes > Number(maxBytes) ? "recording_capacity" : "recording_duration");
        process.send?.({ type: "coverage", coverage, reason });
      }
    }, 500);
    process.send({ type: "ready", display });
  } catch {
    await stop(ffmpeg);
    await stop(xvfb, "SIGTERM");
    process.exit(1);
  }
}
