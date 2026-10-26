import { performance } from "node:perf_hooks";

export interface CommandResource {
  /** Exact session-owned stop capability, registered before asynchronous startup.
   * Resolve only after physical ownership is stopped, not merely disconnected.
   * The awaited work and this cell retain ownership of any late acquisition. */
  stop(): Promise<void>;
}
export interface CommandAttemptOptions {
  remainingMs: number;
  signal?: AbortSignal;
  drainTimeoutMs?: number;
}
type AttemptState = "active" | "finishing" | "cancelling" | "completed" | "unconfirmed";
const failure = (code: string) => new Error(`SCRY_BROWSER_${code}`);

/** Owns command lifetime and drain, not browser acquisition. Praxis registers its
 * exact startup/session cell before awaiting work. Factories/background work are
 * deliberately not admitted by this scope: acquisition has one owner, Praxis. */
export class CommandAttempt {
  readonly #controller = new AbortController();
  readonly #deadline: number;
  readonly #resources = new Map<CommandResource, Promise<void> | undefined>();
  readonly #cancelled: Promise<never>;
  readonly #drainTimeoutMs: number;
  #rejectCancellation!: (reason: Error) => void;
  #state: AttemptState = "active";
  #reason: Error | undefined;
  #stopFailed = false;
  #started = false;
  #timer: NodeJS.Timeout | undefined;
  #externalSignal: AbortSignal | undefined;
  #externalAbort: (() => void) | undefined;

  constructor(options: CommandAttemptOptions) {
    if (
      !Number.isSafeInteger(options.remainingMs) ||
      options.remainingMs < 0 ||
      options.remainingMs > 900000
    )
      throw failure("COMMAND_BUDGET_INVALID");
    const drain = options.drainTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(drain) || drain < 1 || drain > 60000)
      throw failure("COMMAND_DRAIN_BUDGET_INVALID");
    this.#drainTimeoutMs = drain;
    this.#deadline = performance.now() + options.remainingMs;
    this.#cancelled = new Promise<never>((_resolve, reject) => {
      this.#rejectCancellation = reject;
    });
    void this.#cancelled.catch(() => undefined);
    this.#externalSignal = options.signal;
    this.#externalAbort = () => this.cancel("COMMAND_CANCELLED");
    options.signal?.addEventListener("abort", this.#externalAbort, { once: true });
    if (options.signal?.aborted) this.cancel("COMMAND_CANCELLED");
    else if (options.remainingMs === 0) this.cancel("COMMAND_DEADLINE_EXCEEDED");
    else
      this.#timer = setTimeout(() => this.cancel("COMMAND_DEADLINE_EXCEEDED"), options.remainingMs);
  }

  get state(): AttemptState {
    return this.#state;
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get drained(): boolean {
    return this.#state === "completed";
  }

  private checkDeadline(): void {
    if (
      (this.#state === "active" || this.#state === "finishing") &&
      performance.now() >= this.#deadline
    )
      this.cancel("COMMAND_DEADLINE_EXCEEDED");
  }
  assertActive(): void {
    this.checkDeadline();
    if (this.#reason) throw this.#reason;
    if (this.#state !== "active") throw failure("COMMAND_ATTEMPT_ENDED");
  }
  remainingMs(phaseLimitMs = 900000): number {
    if (!Number.isSafeInteger(phaseLimitMs) || phaseLimitMs < 1 || phaseLimitMs > 900000)
      throw failure("COMMAND_PHASE_BUDGET_INVALID");
    this.assertActive();
    return Math.max(1, Math.min(phaseLimitMs, Math.ceil(this.#deadline - performance.now())));
  }

  bind(resource: CommandResource): void {
    // Admission closes in the same continuation that observes work settlement,
    // before the final race continuation. No factory or late binding can enter.
    if (this.#state !== "active") {
      if (this.#reason) throw this.#reason;
      throw failure("COMMAND_ATTEMPT_ENDED");
    }
    if (!this.#resources.has(resource)) this.#resources.set(resource, undefined);
    // Register before checking elapsed time: detecting expiry here must also
    // physically stop this just-admitted exact cell, not merely throw.
    this.assertActive();
  }
  private stop(resource: CommandResource): void {
    if (this.#resources.get(resource)) return;
    const stopping = Promise.resolve()
      .then(() => resource.stop())
      .catch(() => {
        this.#stopFailed = true;
      });
    this.#resources.set(resource, stopping);
  }
  private cancel(code: "COMMAND_CANCELLED" | "COMMAND_DEADLINE_EXCEEDED"): void {
    if (this.#state !== "active" && this.#state !== "finishing") return;
    this.#state = "cancelling";
    this.#reason = failure(code);
    this.#controller.abort(this.#reason);
    for (const resource of this.#resources.keys()) this.stop(resource);
    this.#rejectCancellation(this.#reason);
  }
  private detach(): void {
    clearTimeout(this.#timer);
    if (this.#externalAbort)
      this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
    this.#externalAbort = undefined;
    this.#externalSignal = undefined;
  }

  async run<T>(work: (attempt: CommandAttempt) => Promise<T>): Promise<T> {
    if (this.#started) throw failure("COMMAND_ATTEMPT_ENDED");
    this.#started = true;
    const operation = Promise.resolve().then(async () => {
      this.assertActive();
      try {
        return await work(this);
      } finally {
        if (this.#state === "active") this.#state = "finishing";
      }
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await Promise.race([operation, this.#cancelled]);
    } finally {
      // This is the final synchronous decision boundary. A timer delayed by
      // queued microtasks cannot waive elapsed time on success OR failure.
      this.checkDeadline();
      if (this.#reason) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.all([settled, ...this.#resources.values()]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(failure("COMMAND_DRAIN_UNCONFIRMED")),
                this.#drainTimeoutMs,
              );
            }),
          ]);
          if (this.#stopFailed) throw failure("COMMAND_DRAIN_UNCONFIRMED");
        } catch {
          this.#state = "unconfirmed";
          this.detach();
          throw failure("COMMAND_DRAIN_UNCONFIRMED");
        } finally {
          clearTimeout(timer);
        }
      }
      this.#state = "completed";
      this.#resources.clear();
      this.detach();
      if (this.#reason) throw this.#reason;
    }
  }
}

/** One actor per session. An unconfirmed old attempt poisons this lane instead
 * of permitting a new browser/action to overlap it. Other lanes are independent. */
export class CommandLane {
  #active: CommandAttempt | undefined;
  get available(): boolean {
    return this.#active === undefined;
  }
  async run<T>(
    options: CommandAttemptOptions,
    work: (attempt: CommandAttempt) => Promise<T>,
  ): Promise<T> {
    if (this.#active)
      throw failure(
        this.#active.state === "unconfirmed" ? "COMMAND_DRAIN_UNCONFIRMED" : "COMMAND_CONCURRENT",
      );
    const attempt = new CommandAttempt(options);
    this.#active = attempt;
    try {
      return await attempt.run(work);
    } finally {
      if (attempt.drained && this.#active === attempt) this.#active = undefined;
    }
  }
}
