import { performance } from "node:perf_hooks";

export interface CommandResource {
  /** Resolve only after physical ownership is stopped. A rejected stop is not
   * permission to start another attempt. Never resolve merely on disconnect. */
  stop(): Promise<void>;
}
export interface CommandAttemptOptions {
  remainingMs: number;
  signal?: AbortSignal;
  drainTimeoutMs?: number;
}
type AttemptState = "active" | "cancelling" | "completed" | "unconfirmed";
const failure = (code: string) => new Error(`SCRY_BROWSER_${code}`);

/** One carried monotonic lifetime. This object, not a mutable session lookup,
 * owns each acquired resource and every late acquisition cleanup operation. */
export class CommandAttempt {
  readonly #controller = new AbortController();
  readonly #deadline: number;
  readonly #resources = new Map<CommandResource, Promise<void> | undefined>();
  readonly #acquired = new Set<CommandResource>();
  readonly #pending = new Set<Promise<unknown>>();
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
    // A signal may already be aborted before run installs its race observer.
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

  assertActive(): void {
    if (this.#state === "active" && performance.now() >= this.#deadline)
      this.cancel("COMMAND_DEADLINE_EXCEEDED");
    if (this.#reason) throw this.#reason;
    if (this.#state !== "active") throw failure("COMMAND_ATTEMPT_ENDED");
  }
  remainingMs(phaseLimitMs = 900000): number {
    if (!Number.isSafeInteger(phaseLimitMs) || phaseLimitMs < 1 || phaseLimitMs > 900000)
      throw failure("COMMAND_PHASE_BUDGET_INVALID");
    this.assertActive();
    // Driver timeout=0 disables its timeout. Never emit that sentinel.
    return Math.max(1, Math.min(phaseLimitMs, Math.ceil(this.#deadline - performance.now())));
  }

  /** Bind an already acquired exact resource, not a future resource by session ID.
   * Startup should use acquire so the lane also owns unresolved acquisition. */
  bind(resource: CommandResource): void {
    if (this.#state === "completed") throw failure("COMMAND_ATTEMPT_ENDED");
    if (!this.#resources.has(resource)) this.#resources.set(resource, undefined);
    if (this.#reason) void this.stop(resource);
    this.assertActive();
  }

  async acquire<T extends CommandResource>(factory: () => Promise<T>): Promise<T> {
    this.assertActive();
    const operation = Promise.resolve().then(async () => {
      this.assertActive();
      const resource = await factory();
      this.#resources.set(resource, this.#resources.get(resource));
      this.#acquired.add(resource);
      if (this.#reason) await this.stop(resource);
      this.assertActive();
      return resource;
    });
    this.track(operation);
    return operation;
  }

  private track(operation: Promise<unknown>): void {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#pending.add(settled);
    void settled.then(() => this.#pending.delete(settled));
  }
  private stop(resource: CommandResource): Promise<void> {
    let stopping = this.#resources.get(resource);
    if (!stopping) {
      stopping = Promise.resolve()
        .then(() => resource.stop())
        .catch(() => {
          this.#stopFailed = true;
        });
      this.#resources.set(resource, stopping);
      this.track(stopping);
    }
    return stopping;
  }
  private cancel(code: "COMMAND_CANCELLED" | "COMMAND_DEADLINE_EXCEEDED"): void {
    if (this.#state !== "active") return;
    this.#state = "cancelling";
    this.#reason = failure(code);
    this.#controller.abort(this.#reason);
    for (const resource of this.#resources.keys()) void this.stop(resource);
    this.#rejectCancellation(this.#reason);
  }
  private async pending(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
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
        const value = await work(this);
        await this.pending();
        this.assertActive();
        return value;
      } catch (error) {
        // Failed work cannot abandon an unresolved/new acquisition. Existing
        // bound session resources remain with their session on ordinary errors.
        await this.pending();
        for (const resource of this.#acquired) void this.stop(resource);
        await this.pending();
        throw error;
      }
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await Promise.race([operation, this.#cancelled]);
    } finally {
      if (this.#reason) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            settled.then(() => this.pending()),
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
      if (this.#stopFailed) {
        this.#state = "unconfirmed";
        this.detach();
        throw failure("COMMAND_DRAIN_UNCONFIRMED");
      }
      this.#state = "completed";
      this.#resources.clear();
      this.#acquired.clear();
      this.detach();
    }
  }
}

/** One actor per session. An unconfirmed old attempt poisons this lane instead
 * of permitting a new browser/action to overlap it. Other lanes are independent. */
export class CommandLane {
  #active: CommandAttempt | undefined;
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
