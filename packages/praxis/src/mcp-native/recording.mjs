/* Private two-phase native capture. No public MCP tool or schema surface. */
import { spawn, fork, execFile } from "node:child_process";
import { mkdir, stat, writeFile, rename, readFile, access } from "node:fs/promises";
import { readFileSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayLayout } from "./display-layout.mjs";
import {
  createOwnedRetirement,
  createStartupEvidence,
  createStartupHelperBudget,
  createAcquisitionEvidence,
} from "./owned-retirement.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ended = (child) => child.exitCode !== null || child.signalCode !== null;
async function waitUntil(test, ms) {
  const deadline = Date.now() + ms;
  while (!(await test()) && Date.now() < deadline) await delay(20);
  return await test();
}
async function stop(child, signal = "SIGINT") {
  if (!child || ended(child)) return;
  child.kill(signal);
  if (!(await waitUntil(() => ended(child), 5000))) {
    child.kill("SIGKILL");
    if (!(await waitUntil(() => ended(child), 2000))) throw Error("OWNED_PROCESS_STOP_UNCONFIRMED");
  }
}
// Linux birth tokens are absence observations only; they NEVER authorize a signal.
function processIdentity(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
    return { pid, startTicks: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}
function childPids(pid, budget) {
  try {
    return budget.children(readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return [];
    throw error;
  }
}
// Fixed script, all values passed as separate argv entries. setpriv arms the
// kernel parent-death signal before this PPID check. If the recorder died before
// it was armed, PPID differs and no capture executable starts. Later parent loss
// kills this same resource process across exec, without numeric PID/PGID lookup.
export const ownerExecScript = '[ "$PPID" = "$1" ] || exit 125; shift; exec "$@"';
const ownerArgv = (executable, args) => [
  "--pdeathsig",
  "SIGKILL",
  "/bin/sh",
  "-c",
  ownerExecScript,
  "scry-owned",
  String(process.pid),
  executable,
  ...args,
];
let acquisitionSequence = 0;
const intentAcknowledgments = new Map();
const privateSend = (message) => {
  if (process.connected) process.send(message, () => {});
};
async function resourceIntent() {
  if (process.argv[2] !== "--child") return;
  const acquisitionId = ++acquisitionSequence;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      intentAcknowledgments.delete(acquisitionId);
      // The await did not succeed, so this invocation never called spawn.
      privateSend({ type: "resource_exit", acquisitionId });
      reject(Error("RECORDER_RESOURCE_INTENT_TIMEOUT"));
    }, 5000);
    intentAcknowledgments.set(acquisitionId, { resolve, timer });
    privateSend({ type: "resource_intent", acquisitionId });
  });
  return acquisitionId;
}
const registerOwnedResource = (child, acquisitionId) => {
  if (acquisitionId === undefined) return;
  const exited = () => privateSend({ type: "resource_exit", acquisitionId });
  child.once("exit", exited);
  child.once("close", exited);
  child.once("error", () => {}); // Keep a failed spawn owned until its close acknowledgment.
  const identity = child.pid === undefined ? null : processIdentity(child.pid);
  privateSend({ type: "owned_resource", acquisitionId, identity });
};
const ownedSpawn = async (executable, args, options) => {
  const acquisitionId = await resourceIntent();
  let child;
  try {
    child = spawn("/usr/bin/setpriv", ownerArgv(executable, args), options);
    registerOwnedResource(child, acquisitionId);
    if (child.pid === undefined) {
      await new Promise((resolve) => child.once("close", resolve));
      throw Error("RECORDER_RESOURCE_START_FAILED");
    }
    return child;
  } catch (error) {
    if (child?.pid !== undefined) await stop(child, "SIGTERM");
    else if (acquisitionId !== undefined) privateSend({ type: "resource_exit", acquisitionId });
    throw error;
  }
};
const ownedExec = async (executable, args, options) => {
  const acquisitionId = await resourceIntent();
  return new Promise((resolve, reject) => {
    let closedResolve;
    const closed = new Promise((done) => {
      closedResolve = done;
    });
    let registrationError;
    let child;
    try {
      child = execFile(
        "/usr/bin/setpriv",
        ownerArgv(executable, args),
        { ...options, killSignal: "SIGKILL" },
        async (error, stdout, stderr) => {
          await closed;
          if (registrationError) reject(registrationError);
          else if (error) reject(error);
          else resolve({ stdout, stderr });
        },
      );
    } catch (error) {
      if (acquisitionId !== undefined) privateSend({ type: "resource_exit", acquisitionId });
      reject(error);
      return;
    }
    child.once("close", closedResolve);
    try {
      registerOwnedResource(child, acquisitionId);
    } catch (error) {
      registrationError = error;
      void stop(child, "SIGTERM").catch(() => {});
    }
  });
};
async function verifyCaptureRuntime() {
  if (process.platform !== "linux") throw Error("RECORDER_LINUX_REQUIRED");
  for (const executable of [
    "/usr/bin/setpriv",
    "/usr/bin/Xvfb",
    "/usr/bin/ffmpeg",
    "/usr/bin/ffprobe",
  ]) {
    await access(executable, constants.X_OK);
    if ((await stat(executable)).mode & 0o6000)
      throw Error("RECORDER_PRIVILEGED_EXECUTABLE_FORBIDDEN");
  }
}
export async function inspectRecording(directory) {
  const file = path.join(directory, "recording.mp4");
  try {
    const { stdout } = await ownedExec(
      "/usr/bin/ffprobe",
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
    {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const resources = [];
  const startupEvidence = createStartupEvidence();
  const acquisitions = createAcquisitionEvidence();
  const retire = createOwnedRetirement({
    stopOwnedChild: () => stop(child, "SIGTERM"),
    childEnded: () => ended(child),
    waitUntil,
    startupConfirmed: startupEvidence.confirmed,
    acquisitionsConfirmed: acquisitions.confirmed,
    resourcesAbsent: () =>
      resources.every((resource) => {
        if (resource.absent) return true;
        const current = processIdentity(resource.pid);
        if (!current || current.startTicks !== resource.startTicks) resource.absent = true;
        return resource.absent === true;
      }),
  });
  let progress = { coverage: "recording" };
  child.on("message", (message) => {
    if (message.type === "resource_intent") {
      try {
        acquisitions.intent(message.acquisitionId);
        if (child.connected)
          child.send(
            { type: "resource_intent_ack", acquisitionId: message.acquisitionId },
            () => {},
          );
      } catch {
        /* The bounded evidence latch remains permanently unconfirmed. */
      }
      return;
    }
    if (message.type === "resource_exit") {
      try {
        acquisitions.closed(message.acquisitionId);
      } catch {
        /* Never invent acquisition proof. */
      }
      return;
    }
    if (message.type === "coverage")
      progress = { coverage: message.coverage, reason: message.reason };
    if (message.type === "owned_resource") {
      if (message.acquisitionId !== undefined)
        try {
          acquisitions.registered(message.acquisitionId, message.identity);
        } catch {
          /* Sticky unconfirmed acquisition. */
        }
      if (message.identity) resources.push({ ...message.identity, absent: false });
    }
    startupEvidence.accept(message.type);
  });
  const request = (type, reason, response, ms) =>
    new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", exit);
        child.off("error", error);
      };
      const message = (data) => {
        if (data.type === response) {
          cleanup();
          data.error ? reject(Error(data.error)) : resolve(data);
        }
      };
      const exit = () => {
        cleanup();
        reject(Error("RECORDER_LOST"));
      };
      const error = (cause) => {
        cleanup();
        reject(cause);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Error("RECORDER_REQUEST_TIMEOUT"));
      }, ms);
      child.on("message", message);
      child.once("exit", exit);
      child.once("error", error);
      if (type) {
        if (ended(child) || !child.connected) return exit();
        child.send({ type, reason }, (cause) => {
          if (cause) error(cause);
        });
      }
    });
  let ready;
  try {
    ready = await request(null, null, "ready", 15000);
  } catch (error) {
    try {
      await retire();
    } catch (retirementError) {
      retirementError.cause = error;
      throw retirementError;
    }
    throw Object.assign(error, { physicalRetirement: "confirmed", mayOwnResources: false });
  }
  let stopPromise, closePromise;
  const receipt = async () => {
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
  };
  const stopCapture = (reason = "complete") =>
    (stopPromise ??= (async () => {
      try {
        const result = await request("stop_capture", reason, "capture_stopped", 12000);
        return result.receipt;
      } catch (error) {
        // A failed capture barrier is terminal: no dangling display or late encoder.
        await retire();
        throw Object.assign(error, { physicalRetirement: "confirmed", mayOwnResources: false });
      }
    })());
  return {
    display: ready.display,
    pid: child.pid,
    get status() {
      return progress;
    },
    stopCapture,
    close(reason = "complete") {
      return (closePromise ??= (async () => {
        try {
          await stopCapture(reason);
        } catch {
          /* Capture failure is represented by the missing/partial receipt. */
        } finally {
          if (!ended(child) && child.connected) {
            child.send({ type: "close", reason }, () => {});
            await waitUntil(() => ended(child), 12000);
          }
          await retire();
        }
        return receipt();
      })());
    },
  };
}

if (process.argv[2] === "--child") {
  const [directory, maxBytes, maxMs, captureJSON] = process.argv.slice(3);
  const capture = JSON.parse(captureJSON);
  let xvfb,
    ffmpeg,
    monitor,
    captureStop,
    closing,
    captureRequested = false;
  let startupWatcher;
  const startupHelpers = new Map(),
    startupBudget = createStartupHelperBudget();
  let coverage = "complete",
    reason = "complete",
    started = Date.now(),
    timingOrigin = "recorder_start";
  const send = (message) => {
    if (process.connected) process.send(message, () => {});
  };
  const flushed = (message) =>
    new Promise((resolve, reject) => {
      if (!process.connected) return reject(Error("RECORDER_PARENT_LOST"));
      process.send(message, (error) => (error ? reject(error) : resolve()));
    });
  const observeStartupHelpers = () => {
    if (!xvfb) return;
    for (const first of childPids(xvfb.pid, startupBudget))
      for (const pid of [first, ...childPids(first, startupBudget)]) {
        const token = processIdentity(pid);
        if (token && startupBudget.register(token)) {
          startupHelpers.set(pid + ":" + token.startTicks, token);
          send({ type: "owned_resource", identity: token });
        }
      }
  };
  const startupHelpersAbsent = () => {
    startupBudget.children(""); // A capacity failure is sticky; never acknowledge a truncated history.
    return [...startupHelpers.values()].every(
      (token) => processIdentity(token.pid)?.startTicks !== token.startTicks,
    );
  };
  const mark = (why) => {
    if (why !== "complete" && reason === "complete") {
      coverage = "partial";
      reason = why;
    }
  };
  const stopVideo = (why) =>
    (captureStop ??= (async () => {
      captureRequested = true;
      clearInterval(monitor);
      mark(why);
      await stop(ffmpeg);
      const physicalEnd = Date.now();
      const receipt = {
        ...(await inspectRecording(directory)),
        coverage,
        reason,
        started,
        timingOrigin,
        ended: physicalEnd,
        timing: "native_realtime",
        masking: "best_effort",
        capture,
      };
      if (receipt.unavailable) receipt.coverage = "unavailable";
      const tmp = path.join(directory, "recording.json.tmp");
      await writeFile(tmp, JSON.stringify(receipt), { mode: 0o600 });
      await rename(tmp, path.join(directory, "recording.json"));
      send({ type: "coverage", coverage: receipt.coverage, reason: receipt.reason });
      return receipt;
    })());
  let startup;
  const close = (why) =>
    (closing ??= (async () => {
      await startup.catch(() => {});
      try {
        await stopVideo(why);
      } finally {
        clearInterval(monitor);
        await stop(xvfb, "SIGTERM");
        clearInterval(startupWatcher);
        if (!(await waitUntil(startupHelpersAbsent, 2000)))
          throw Error("RECORDER_STARTUP_HELPER_UNCONFIRMED");
        if (process.connected) await flushed({ type: "resources_closed" });
      }
    })().then(
      () => process.exit(0),
      () => process.exit(1),
    ));
  process.on("disconnect", () => void close("parent_lost"));
  process.on("SIGTERM", () => void close("recorder_terminated"));
  process.on("message", (message) => {
    if (message.type === "resource_intent_ack") {
      const pending = intentAcknowledgments.get(message.acquisitionId);
      if (pending) {
        clearTimeout(pending.timer);
        intentAcknowledgments.delete(message.acquisitionId);
        pending.resolve();
      }
      return;
    }
    if (message.type === "close") void close(message.reason);
    if (message.type === "stop_capture")
      void stopVideo(message.reason).then(
        (receipt) => send({ type: "capture_stopped", receipt }),
        () => send({ type: "capture_stopped", error: "CAPTURE_FINALIZATION_FAILED" }),
      );
  });
  startup = (async () => {
    await verifyCaptureRuntime();
    await flushed({ type: "capture_starting" });
    xvfb = await ownedSpawn(
      "/usr/bin/Xvfb",
      ["-displayfd", "3", "-screen", "0", capture.screen, "-nolisten", "tcp"],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    startupWatcher = setInterval(observeStartupHelpers, 2);
    const display = await new Promise((resolve, reject) => {
      let text = "";
      xvfb.once("error", reject);
      xvfb.once("exit", () => reject(Error("XVFB_FAILED")));
      xvfb.stdio[3].on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve(":" + text.trim());
      });
    });
    observeStartupHelpers();
    if (
      !(await waitUntil(() => {
        observeStartupHelpers();
        return childPids(xvfb.pid, startupBudget).length === 0 && startupHelpersAbsent();
      }, 2000))
    )
      throw Error("XVFB_STARTUP_HELPERS_UNCONFIRMED");
    clearInterval(startupWatcher);
    await flushed({ type: "startup_drained" });
    ffmpeg = await ownedSpawn(
      "/usr/bin/ffmpeg",
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
    let header = "";
    ffmpeg.stderr.on("data", (chunk) => {
      if (timingOrigin === "native_capture") return;
      header = (header + chunk.toString("utf8")).slice(-32768);
      const match = header.match(/start:\s*(\d+\.\d+)/);
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
    ffmpeg.on("exit", () => {
      if (!captureRequested) void stopVideo("encoder_exit").catch(() => {});
    });
    xvfb.on("exit", () => {
      if (!closing && !captureRequested) void stopVideo("display_exit").catch(() => {});
    });
    await delay(350);
    if (ended(ffmpeg)) throw Error("ENCODER_FAILED");
    monitor = setInterval(
      () =>
        void (async () => {
          if (captureRequested || ended(ffmpeg)) return;
          const bytes = (
            await stat(path.join(directory, "recording.mp4")).catch(() => ({ size: 0 }))
          ).size;
          if (bytes > Number(maxBytes) || Date.now() - started > Number(maxMs))
            await stopVideo(bytes > Number(maxBytes) ? "recording_capacity" : "recording_duration");
        })().catch(() => void close("recorder_monitor_failed")),
      500,
    );
    send({ type: "ready", display });
  })();
  startup.catch(() => void close("recorder_start_failed"));
}
