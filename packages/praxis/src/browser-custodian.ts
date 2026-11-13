import { performance } from "node:perf_hooks";
import {
  BrowserProcessCustody,
  assertBrowserProcessOptions,
  type OwnedBrowserOptions,
} from "./owned-browser.js";
import { SupervisionAuthority, type SupervisionStopReason } from "./supervision-authority.js";
import type { NativeRecorderStopReceipt } from "./supervised-browser.js";

// Private fork entry point. No database, Veil, Chronicle or customer tool API.
const authority = new SupervisionAuthority(() => performance.now());
let launch: Promise<BrowserProcessCustody> | undefined;
let custody: BrowserProcessCustody | undefined;
let configured = false,
  stopping: Promise<void> | undefined,
  forceRequested = false;
let poll: NodeJS.Timeout | undefined, receiptTimer: NodeJS.Timeout | undefined;
let refresh = false;
let setupDeadline: number | undefined;
let setupCompleted = false;
let receiptSent = false;
let capture:
  | {
      display: string;
      stopCapture(reason?: string): Promise<unknown>;
      close(reason?: string): Promise<unknown>;
    }
  | undefined;
let captureStartupFailure: unknown;
let browserLaunchAttempted = false;
let captureStop: Promise<NativeRecorderStopReceipt> | undefined;
function retirementConfirmed(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { physicalRetirement?: unknown }).physicalRetirement === "confirmed" &&
    (error as { mayOwnResources?: unknown }).mayOwnResources === false
  );
}
const unavailableCapture = (): NativeRecorderStopReceipt => ({
  coverage: "unavailable",
  reason: "capture_final_unconfirmed",
});
function finiteCapture(value: unknown): NativeRecorderStopReceipt {
  if (!value || typeof value !== "object") return unavailableCapture();
  const input = value as Record<string, unknown>;
  if (
    (input.coverage !== "complete" && input.coverage !== "partial") ||
    !Number.isSafeInteger(input.started) ||
    (input.started as number) < 0 ||
    !Number.isSafeInteger(input.ended) ||
    (input.ended as number) < (input.started as number) ||
    (input.timingOrigin !== "native_capture" && input.timingOrigin !== "recorder_start")
  )
    return unavailableCapture();
  return {
    coverage: input.coverage,
    started: input.started as number,
    ended: input.ended as number,
    timingOrigin: input.timingOrigin,
  };
}
function stopCapture(): Promise<NativeRecorderStopReceipt> {
  return (captureStop ??= (async () => {
    if (!capture) return unavailableCapture();
    try {
      return finiteCapture(await capture.stopCapture());
    } catch (error) {
      // A failed media fact is distinct from unresolved physical ownership.
      if (retirementConfirmed(error)) return unavailableCapture();
      throw error;
    }
  })());
}
const startup = setTimeout(() => {
  void stop("controller_unavailable", true);
}, 2000);
function send(value: object): boolean {
  try {
    if (!process.connected || Buffer.byteLength(JSON.stringify(value)) > 8192) return false;
    return process.send!(value, (error) => {
      if (error) void stop("transport_failed", true);
    });
  } catch {
    return false;
  }
}
function finish(): void {
  clearTimeout(receiptTimer);
  process.exit(0);
}
function stop(reason: SupervisionStopReason, force: boolean): Promise<void> {
  forceRequested ||= force;
  if (force && custody) void custody.terminate().catch(() => undefined);
  if (stopping) return stopping;
  authority.stop(reason);
  clearTimeout(poll);
  clearTimeout(startup);
  stopping = Promise.resolve().then(async () => {
    // A stop during launch retains the late acquisition and kills it. A launch
    // rejection is not invented into a positive native-process exit receipt.
    try {
      let acquired: BrowserProcessCustody | undefined;
      let unresolved = false;
      try {
        acquired = launch ? await launch : undefined;
      } catch {
        // A recorder constructor may reject after acquisition. Its positive
        // cleanup acknowledgment, not an absent object, proves no browser ran.
        unresolved = browserLaunchAttempted || !retirementConfirmed(captureStartupFailure);
      }
      let receipt = { forced: false, exitConfirmed: true as const };
      try {
        if (acquired) receipt = await (forceRequested ? acquired.terminate() : acquired.close());
      } catch {
        unresolved = true;
      } finally {
        // Browser failure must never skip encoder/display/probe retirement.
        try {
          await capture?.close(forceRequested ? "browser_interrupted" : "complete");
        } catch {
          unresolved = true;
        }
      }
      if (unresolved) throw new Error("RECORDER_RETIREMENT_UNCONFIRMED");
      receiptSent = true;
      if (!send({ kind: "stopped", ...receipt })) process.exit(1);
      // Parent acknowledges the receipt before normal helper exit. Unexpected
      // exit cannot race ahead of its proof and look like successful cleanup.
      receiptTimer = setTimeout(finish, 1000);
    } catch {
      process.exit(1);
    }
  });
  return stopping;
}
function tick(): void {
  clearTimeout(poll);
  if (stopping) return;
  try {
    authority.assertCurrent();
    if (setupDeadline !== undefined && performance.now() >= setupDeadline) {
      void stop("phase_expired", true);
      return;
    }
    if (
      !authority.challengePending &&
      !send({ kind: "challenge", challenge: authority.issueChallenge() })
    ) {
      void stop("transport_failed", true);
      return;
    }
    poll = setTimeout(
      tick,
      Math.max(
        1,
        Math.min(
          100,
          Math.ceil(Math.min(authority.deadline, setupDeadline ?? Infinity) - performance.now()),
        ),
      ),
    );
  } catch {
    void stop(authority.reason ?? "protocol_invalid", true);
  }
}
function configuration(value: unknown): value is OwnedBrowserOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    assertBrowserProcessOptions(value as OwnedBrowserOptions);
  } catch {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).every((key) =>
      [
        "headless",
        "channel",
        "executablePath",
        "launchTimeoutMs",
        "connectTimeoutMs",
        "gracefulCloseMs",
        "killTimeoutMs",
        "runtime",
        "display",
        "proxyServer",
        "captureDirectory",
      ].includes(key),
    ) &&
    (input.headless === undefined || typeof input.headless === "boolean") &&
    (input.channel === undefined ||
      (typeof input.channel === "string" && /^[a-z0-9-]{1,64}$/u.test(input.channel))) &&
    (input.executablePath === undefined ||
      (typeof input.executablePath === "string" && input.executablePath.length <= 4096)) &&
    ["launchTimeoutMs", "connectTimeoutMs", "gracefulCloseMs", "killTimeoutMs"].every(
      (key) => input[key] === undefined || Number.isSafeInteger(input[key]),
    )
  );
}
process.on("message", (value) => {
  if (!value || typeof value !== "object") {
    void stop("protocol_invalid", true);
    return;
  }
  const input = value as Record<string, unknown>;
  if (input.kind === "receipt_acknowledged") {
    if (receiptSent) finish();
    else void stop("protocol_invalid", true);
    return;
  }
  if (input.kind === "stop" && typeof input.force === "boolean") {
    void stop("explicit", input.force);
    return;
  }
  if (stopping) return;
  if (input.kind === "capture_stop" && input.requestId === 1 && custody) {
    try {
      authority.assertCurrent();
    } catch {
      void stop(authority.reason ?? "protocol_invalid", true);
      return;
    }
    void stopCapture().then(
      (receipt) => {
        if (!send({ kind: "capture_stopped", requestId: 1, receipt }))
          void stop("transport_failed", true);
      },
      () => void stop("transport_failed", true),
    );
    return;
  }
  if (input.kind === "initialize" && !configured && configuration(input.options)) {
    configured = true;
    clearTimeout(startup);
    const options = input.options;
    process.on("message", function startAfterAuthority(next) {
      if (
        !next ||
        typeof next !== "object" ||
        (next as Record<string, unknown>).kind !== "authority" ||
        launch ||
        stopping ||
        authority.state !== "active"
      )
        return;
      process.off("message", startAfterAuthority);
      launch = (async () => {
        if (options.runtime === "playwright_mcp" && options.captureDirectory) {
          // @ts-expect-error Private JavaScript recorder, characterized by native capture qualification.
          const { recording } = await import("./mcp-native/recording.mjs");
          try {
            capture = await recording(options.captureDirectory, { maxBytes: 120 * 1024 * 1024 });
          } catch (error) {
            captureStartupFailure = error;
            throw error;
          }
        }
        browserLaunchAttempted = true;
        return BrowserProcessCustody.launch({
          ...options,
          ...(capture ? { display: capture.display } : {}),
          handleSignals: false,
        });
      })();
      void launch
        .then((value) => {
          custody = value;
          if (stopping) return;
          authority.assertCurrent();
          setupDeadline = performance.now() + 15000;
          if (
            !send({
              kind: "ready",
              endpoint: value.endpoint(),
              ...(capture ? { display: capture.display } : {}),
            })
          )
            void stop("transport_failed", true);
        })
        .catch(() => {
          void stop("transport_failed", true);
        });
    });
    tick();
    return;
  }
  if (
    input.kind === "setup_complete" &&
    custody &&
    !setupCompleted &&
    setupDeadline !== undefined
  ) {
    try {
      authority.assertCurrent();
    } catch {
      void stop(authority.reason ?? "protocol_invalid", true);
      return;
    }
    if (performance.now() >= setupDeadline) {
      void stop("phase_expired", true);
      return;
    }
    setupCompleted = true;
    setupDeadline = undefined;
    if (!send({ kind: "setup_completed" })) void stop("transport_failed", true);
    return;
  }
  if (input.kind === "challenge_request" && configured) {
    refresh = true;
    if (!authority.challengePending) tick();
    return;
  }
  if (input.kind === "authority" && configured) {
    try {
      const acknowledgment = authority.accept(value);
      if (!send({ kind: "accepted", acknowledgment })) {
        void stop("transport_failed", true);
        return;
      }
      if (refresh) {
        refresh = false;
        tick();
      }
    } catch {
      void stop(authority.reason ?? "protocol_invalid", true);
    }
    return;
  }
  void stop("protocol_invalid", true);
});
process.on("disconnect", () => {
  void stop("transport_failed", true);
});
process.on("error", () => {
  void stop("transport_failed", true);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    void stop("explicit", true);
  });
