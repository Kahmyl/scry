import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { chromium, type Browser } from "playwright";
import {
  assertBrowserProcessOptions,
  type BrowserTerminationReceipt,
  type OwnedBrowserOptions,
} from "./owned-browser.js";
import type {
  RenewableAuthority,
  SupervisedCommand,
  SupervisionAcknowledgment,
} from "./supervision-authority.js";

export interface BrowserAuthoritySnapshot {
  owner: RenewableAuthority;
  command: SupervisedCommand;
}
export interface SupervisedBrowserOptions extends OwnedBrowserOptions {
  sampleAuthority(): BrowserAuthoritySnapshot;
  onUnconfirmedStop?: () => void;
}
const failure = () => new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function endpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "ws:" &&
      url.hostname === "127.0.0.1" &&
      !!url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function acknowledgment(value: unknown): value is SupervisionAcknowledgment {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 5 &&
    [input.challenge, input.commandSequence, input.ownerRevision].every(
      (v) => Number.isSafeInteger(v) && (v as number) >= 0,
    ) &&
    [input.phaseSequence, input.claimRevision].every(
      (v) => v === null || (Number.isSafeInteger(v) && (v as number) >= 0),
    )
  );
}
function matches(ack: SupervisionAcknowledgment, target: BrowserAuthoritySnapshot): boolean {
  return (
    ack.commandSequence === target.command.sequence &&
    ack.ownerRevision >= target.owner.revision &&
    (target.command.state === "idle"
      ? ack.phaseSequence === null && ack.claimRevision === null
      : ack.phaseSequence === target.command.phase.sequence &&
        ack.claimRevision !== null &&
        ack.claimRevision >= target.command.claim.revision)
  );
}

/** One exact helper ChildProcess per browser incarnation. A transport close is
 * never a native-exit receipt. Abnormal helper loss remains unconfirmed even on
 * platforms where debugging-pipe loss is observed to close Chromium. */
export class SupervisedBrowser {
  readonly #child: ChildProcess;
  readonly #ready = deferred<string>();
  readonly #receipt = deferred<BrowserTerminationReceipt>();
  readonly #exit = deferred<void>();
  readonly #setup = deferred<void>();
  #browser: Browser | undefined;
  #lastAcknowledgment: SupervisionAcknowledgment | undefined;
  #expectedAcknowledgment: SupervisionAcknowledgment | undefined;
  #lastChallenge = 0;
  #livenessDeadline = performance.now() + 5000;
  #livenessWatch: NodeJS.Timeout | undefined;
  #barrier:
    | {
        target: BrowserAuthoritySnapshot;
        completion: ReturnType<typeof deferred<void>>;
        timer: NodeJS.Timeout;
      }
    | undefined;
  #proofReceived = false;
  #readyReceived = false;
  #setupRequested = false;
  #transportFailed = false;
  #disposal: Promise<BrowserTerminationReceipt> | undefined;
  #state: "active" | "terminating" | "exited" | "unconfirmed" = "active";

  private constructor(private readonly options: SupervisedBrowserOptions) {
    // Explicit allowlist: never inherit DATABASE_URL, protection keys, NODE_OPTIONS,
    // inspector flags, shell credentials or arbitrary application environment.
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "TEMP",
      "LANG",
      "DISPLAY",
      "PLAYWRIGHT_BROWSERS_PATH",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    this.#child = fork(new URL("./browser-custodian.ts", import.meta.url), [], {
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx/esm")],
      env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.#child.on("message", (value) => this.message(value));
    this.#child.on("error", () => this.failTransport());
    this.#child.on("exit", () => {
      this.#exit.resolve();
      if (!this.#proofReceived) this.failTransport();
    });
    this.armLiveness();
    const {
      sampleAuthority: _sample,
      onUnconfirmedStop: _observer,
      handleSignals: _signals,
      ...launch
    } = options;
    this.send({ kind: "initialize", options: launch });
  }

  static async launch(options: SupervisedBrowserOptions): Promise<SupervisedBrowser> {
    assertBrowserProcessOptions(options);
    let owned: SupervisedBrowser;
    try {
      owned = new SupervisedBrowser(options);
    } catch {
      throw new Error("SCRY_BROWSER_PROCESS_LAUNCH_FAILED");
    }
    const timeout = setTimeout(
      () => owned.failTransport(),
      (options.launchTimeoutMs ?? 15000) + 3000,
    );
    try {
      const address = await owned.#ready.promise;
      owned.#browser = await chromium.connect(address, {
        timeout: options.connectTimeoutMs ?? 5000,
      });
      if (!owned.#browser.isConnected() || owned.#state !== "active") throw failure();
      owned.#browser.once("disconnected", () => {
        if (owned.#state === "active") void owned.terminate().catch(() => undefined);
      });
      return owned;
    } catch {
      await owned.terminate();
      throw new Error("SCRY_BROWSER_PROCESS_CONNECT_FAILED");
    } finally {
      clearTimeout(timeout);
    }
  }
  get browser(): Browser {
    if (!this.#browser) throw new Error("SCRY_BROWSER_PROCESS_CONNECT_FAILED");
    return this.#browser;
  }
  get exitConfirmed(): boolean {
    return this.#proofReceived;
  }
  get terminationState(): "active" | "terminating" | "exited" | "unconfirmed" {
    return this.#state;
  }

  private send(value: unknown): void {
    if (this.#transportFailed) return;
    try {
      if (
        !this.#child.connected ||
        Buffer.byteLength(JSON.stringify(value)) > 8192 ||
        !this.#child.send(value as object, (error) => {
          if (error) this.failTransport();
        })
      )
        this.failTransport();
    } catch {
      this.failTransport();
    }
  }
  private armLiveness(): void {
    clearTimeout(this.#livenessWatch);
    if (this.#state !== "active" || this.#transportFailed || this.#proofReceived) return;
    const remaining = this.#livenessDeadline - performance.now();
    if (remaining <= 0) {
      this.failTransport();
      return;
    }
    this.#livenessWatch = setTimeout(() => this.armLiveness(), Math.max(1, Math.ceil(remaining)));
    this.#livenessWatch.unref?.();
  }
  private checkLiveness(): void {
    if (this.#state === "active" && performance.now() >= this.#livenessDeadline)
      this.failTransport();
  }
  private failTransport(): void {
    if (this.#transportFailed || this.#state === "exited") return;
    clearTimeout(this.#livenessWatch);
    if (this.#proofReceived) {
      // A late IPC callback cannot invalidate an already received native-exit
      // fact. Join/stop the remaining exact helper instead of inventing failure.
      this.#child.kill("SIGKILL");
      return;
    }
    this.#transportFailed = true;
    this.#state = "unconfirmed";
    queueMicrotask(() => {
      try {
        this.options.onUnconfirmedStop?.();
      } catch {
        /* containment still fails closed */
      }
    });
    this.#ready.reject(failure());
    this.#setup.reject(failure());
    this.#receipt.reject(failure());
    this.rejectBarrier();
    // This is the actual owned helper capability, not a guessed native PID.
    // Its death is containment, not a fabricated native-exit confirmation.
    this.#child.kill("SIGKILL");
  }
  private rejectBarrier(reason: Error = failure()): void {
    if (!this.#barrier) return;
    clearTimeout(this.#barrier.timer);
    this.#barrier.completion.reject(reason);
    this.#barrier = undefined;
  }
  private message(value: unknown): void {
    if (this.#transportFailed) return;
    if (!value || typeof value !== "object") {
      this.failTransport();
      return;
    }
    const input = value as Record<string, unknown>;
    // An immutable native stop receipt can reduce authority after a controller
    // delay; a late heartbeat may never revive an expired control channel.
    if (input.kind !== "stopped") this.checkLiveness();
    if (this.#transportFailed) return;
    if (
      input.kind === "challenge" &&
      Number.isSafeInteger(input.challenge) &&
      (input.challenge as number) > 0
    ) {
      if (this.#expectedAcknowledgment || input.challenge !== this.#lastChallenge + 1) {
        this.failTransport();
        return;
      }
      this.#lastChallenge = input.challenge as number;
      try {
        const sample = this.options.sampleAuthority();
        this.#expectedAcknowledgment = {
          challenge: this.#lastChallenge,
          commandSequence: sample.command.sequence,
          ownerRevision: sample.owner.revision,
          phaseSequence: sample.command.state === "active" ? sample.command.phase.sequence : null,
          claimRevision: sample.command.state === "active" ? sample.command.claim.revision : null,
        };
        this.send({ kind: "authority", challenge: input.challenge, ...sample });
      } catch {
        void this.terminate().catch(() => undefined);
      }
    } else if (input.kind === "setup_completed" && this.#readyReceived) {
      this.#setup.resolve();
    } else if (input.kind === "accepted" && acknowledgment(input.acknowledgment)) {
      const ack = input.acknowledgment;
      const expected = this.#expectedAcknowledgment;
      if (
        !expected ||
        Object.keys(expected).some(
          (key) =>
            ack[key as keyof SupervisionAcknowledgment] !==
            expected[key as keyof SupervisionAcknowledgment],
        )
      ) {
        this.failTransport();
        return;
      }
      this.#expectedAcknowledgment = undefined;
      this.#livenessDeadline = performance.now() + 2000;
      this.armLiveness();
      this.#lastAcknowledgment = ack;
      if (this.#state === "active" && this.#barrier && matches(ack, this.#barrier.target)) {
        clearTimeout(this.#barrier.timer);
        this.#barrier.completion.resolve();
        this.#barrier = undefined;
      }
    } else if (
      input.kind === "ready" &&
      !this.#readyReceived &&
      endpoint(input.endpoint) &&
      this.#lastAcknowledgment
    ) {
      this.#readyReceived = true;
      this.#ready.resolve(input.endpoint);
    } else if (
      input.kind === "stopped" &&
      input.exitConfirmed === true &&
      typeof input.forced === "boolean" &&
      !this.#proofReceived
    ) {
      this.#proofReceived = true;
      clearTimeout(this.#livenessWatch);
      // Native exit closes dispatch immediately, including a client connection
      // still resolving before its asynchronous disconnect event is delivered.
      this.#state = "terminating";
      this.#receipt.resolve(Object.freeze({ exitConfirmed: true, forced: input.forced }));
      this.#ready.reject(new Error("SCRY_BROWSER_PROCESS_LAUNCH_FAILED"));
      this.#setup.reject(new Error("SCRY_BROWSER_PROCESS_LAUNCH_FAILED"));
      // The dispatch was refused, but custody is positively stopped. Do not
      // turn a pending phase barrier into a false host-recovery requirement.
      this.rejectBarrier(new Error("SCRY_BROWSER_OWNER_FENCED"));
      this.send({ kind: "receipt_acknowledged" });
    } else {
      this.failTransport();
    }
  }

  /** Dispatch barrier. Matching command AND phase facts must be acknowledged;
   * a send callback only proves transport progress, not custodian admission. */
  synchronize(): Promise<void> {
    this.checkLiveness();
    if (this.#state === "terminating")
      return this.close().then(() => {
        throw new Error("SCRY_BROWSER_OWNER_FENCED");
      });
    if (this.#state !== "active")
      return Promise.reject(
        this.#proofReceived ? new Error("SCRY_BROWSER_OWNER_FENCED") : failure(),
      );
    let target: BrowserAuthoritySnapshot;
    try {
      target = this.options.sampleAuthority();
    } catch {
      return this.terminate().then(() => {
        // A rejected terminate still propagates its unconfirmed failure. This
        // continuation runs only after positive native-exit/owned-helper proof.
        throw new Error("SCRY_BROWSER_OWNER_FENCED");
      });
    }
    if (this.#lastAcknowledgment && matches(this.#lastAcknowledgment, target))
      return Promise.resolve();
    if (this.#barrier) {
      if (
        this.#barrier.target.command.sequence === target.command.sequence &&
        this.#barrier.target.command.state === target.command.state
      ) {
        // Concurrent native suboperations share one bounded latest-state barrier.
        this.#barrier.target = target;
        this.send({ kind: "challenge_request" });
        return this.#barrier.completion.promise;
      }
      return Promise.reject(new Error("SCRY_BROWSER_COMMAND_CONCURRENT"));
    }
    const completion = deferred<void>();
    const timer = setTimeout(() => this.failTransport(), 5000);
    this.#barrier = { target, completion, timer };
    this.send({ kind: "challenge_request" });
    return completion.promise;
  }
  async completeSetup(): Promise<void> {
    if (this.#setupRequested) return this.#setup.promise;
    this.checkLiveness();
    if (this.#state !== "active") throw failure();
    this.#setupRequested = true;
    this.send({ kind: "setup_complete" });
    await this.#setup.promise;
  }
  private dispose(force: boolean): Promise<BrowserTerminationReceipt> {
    if (!this.#disposal) {
      clearTimeout(this.#livenessWatch);
      // Once admission is fenced, only the stop budget may classify missing
      // native proof. A former dispatch timer must not preempt that outcome.
      clearTimeout(this.#barrier?.timer);
      if (this.#state === "active") this.#state = "terminating";
      this.#disposal = (async () => {
        const timer = setTimeout(
          () => this.failTransport(),
          (this.options.launchTimeoutMs ?? 15000) +
            (this.options.gracefulCloseMs ?? 2000) +
            (this.options.killTimeoutMs ?? 5000) +
            2000,
        );
        try {
          if (!this.#proofReceived) this.send({ kind: "stop", force });
          const [receipt] = await Promise.all([this.#receipt.promise, this.#exit.promise]);
          if (this.#transportFailed) throw failure();
          this.#state = "exited";
          return receipt;
        } finally {
          clearTimeout(timer);
        }
      })();
      void this.#disposal.catch(() => undefined);
    } else if (force && !this.#proofReceived) this.send({ kind: "stop", force: true });
    return this.#disposal;
  }
  close(): Promise<BrowserTerminationReceipt> {
    return this.dispose(false);
  }
  terminate(): Promise<BrowserTerminationReceipt> {
    return this.dispose(true);
  }
}
