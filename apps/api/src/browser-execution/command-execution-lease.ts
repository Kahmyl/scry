import { performance } from "node:perf_hooks";
import type {
  BrowserCommandRepository,
  CommandClaimSample,
} from "./repositories/browser-command.repository.js";
type LeaseFailure =
  | "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED"
  | "SCRY_BROWSER_COMMAND_CLAIM_FENCED"
  | "SCRY_BROWSER_COMMAND_CLAIM_UNAVAILABLE";

/** One private process-local mirror of database authority. Execution can only
 * tighten; only an acknowledged heartbeat may extend the current claim lease.
 * Query/commit/transport elapsed time is deducted from its monotonic anchor. */
export class CommandExecutionLease {
  readonly #controller = new AbortController();
  #executionDeadline = Infinity;
  #claimDeadline = Infinity;
  #renewalSampleAt = -Infinity;
  #claimRevision = 0;
  #latestCheck: { at: number; deadline: number } | undefined;
  #failure: Error | undefined;
  #disposed = false;
  #renewing = false;
  #watch: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #heartbeatAt: number | undefined;
  constructor(
    private readonly commands: Pick<BrowserCommandRepository, "assertClaim" | "heartbeatClaim">,
    private readonly commandId: string,
    private readonly claimToken: string,
    sample: CommandClaimSample,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.apply(sample, "initial");
    this.armWatch();
    this.armHeartbeat();
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get failure(): Error | undefined {
    return this.#failure;
  }
  private abort(code: LeaseFailure): void {
    if (this.#failure || this.#disposed) return;
    this.#failure = new Error(code);
    clearTimeout(this.#watch);
    clearTimeout(this.#heartbeat);
    this.#controller.abort(this.#failure);
  }
  private expire(): void {
    if (this.#disposed || this.#failure) return;
    const now = this.now();
    if (now >= this.#executionDeadline) this.abort("SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED");
    else if (now >= this.#claimDeadline) this.abort("SCRY_BROWSER_COMMAND_CLAIM_FENCED");
  }
  assertActive(): void {
    this.expire();
    if (this.#failure) throw this.#failure;
    if (this.#disposed) throw new Error("SCRY_BROWSER_COMMAND_ATTEMPT_ENDED");
  }
  remainingMs(): number {
    this.assertActive();
    return Math.max(0, Math.floor(this.#executionDeadline - this.now()));
  }
  authoritySample(): {
    executionRemainingMs: number;
    claimRemainingMs: number;
    claimRevision: number;
  } {
    this.assertActive();
    const now = this.now();
    return {
      executionRemainingMs: Math.max(0, Math.floor(this.#executionDeadline - now)),
      claimRemainingMs: Math.max(0, Math.floor(this.#claimDeadline - now)),
      claimRevision: this.#claimRevision,
    };
  }
  private apply(sample: CommandClaimSample, mode: "initial" | "check" | "heartbeat"): void {
    const now = this.now();
    if (
      !sample ||
      !Number.isSafeInteger(sample.executionRemainingMs) ||
      sample.executionRemainingMs < 0 ||
      sample.executionRemainingMs > 900000 ||
      !Number.isSafeInteger(sample.claimRemainingMs) ||
      sample.claimRemainingMs < 0 ||
      sample.claimRemainingMs > 300000 ||
      !Number.isFinite(sample.sampleStartedAt) ||
      sample.sampleStartedAt > now
    ) {
      this.abort("SCRY_BROWSER_COMMAND_CLAIM_UNAVAILABLE");
      return;
    }
    const elapsed = now - sample.sampleStartedAt;
    this.#executionDeadline = Math.min(
      this.#executionDeadline,
      now + Math.max(0, sample.executionRemainingMs - elapsed),
    );
    const claimDeadline = now + Math.max(0, sample.claimRemainingMs - elapsed);
    if (mode === "check") {
      if (!this.#latestCheck || sample.sampleStartedAt >= this.#latestCheck.at)
        this.#latestCheck = { at: sample.sampleStartedAt, deadline: claimDeadline };
      // Database row-lock samples are ordered by their post-lock monotonic
      // anchors, not response delivery. A pre-renewal read cannot revoke a
      // subsequently acknowledged renewal merely by arriving late.
      if (sample.sampleStartedAt >= this.#renewalSampleAt)
        this.#claimDeadline = Math.min(this.#claimDeadline, claimDeadline);
    } else {
      this.#renewalSampleAt = sample.sampleStartedAt;
      this.#claimDeadline = claimDeadline;
      // A checkpoint sampled after this renewal still constrains it, even
      // when the renewal acknowledgement itself was delivered later.
      if (this.#latestCheck && this.#latestCheck.at >= sample.sampleStartedAt)
        this.#claimDeadline = Math.min(this.#claimDeadline, this.#latestCheck.deadline);
    }
    this.expire();
  }
  private armWatch(): void {
    clearTimeout(this.#watch);
    if (this.#disposed || this.#failure) return;
    const remaining = Math.min(this.#executionDeadline, this.#claimDeadline) - this.now();
    this.#watch = setTimeout(
      () => {
        this.expire();
        this.armWatch();
      },
      Math.max(1, Math.ceil(remaining)),
    );
  }
  private armHeartbeat(): void {
    if (this.#disposed || this.#failure || this.#renewing) return;
    const now = this.now();
    const delay = Math.max(1, Math.min(20000, Math.floor((this.#claimDeadline - now) / 3)));
    const target = now + delay;
    // Checks may bring a renewal forward, never postpone an already scheduled
    // one. Frequent actions must not starve the independent heartbeat.
    if (this.#heartbeat && this.#heartbeatAt !== undefined && this.#heartbeatAt <= target) return;
    clearTimeout(this.#heartbeat);
    this.#heartbeatAt = target;
    this.#heartbeat = setTimeout(() => {
      this.#heartbeat = undefined;
      this.#heartbeatAt = undefined;
      void this.renew();
    }, delay);
  }
  private admissionFailure(error: unknown): void {
    const code = error instanceof Error ? error.message : "";
    this.abort(
      code === "SCRY_BROWSER_COMMAND_CLAIM_FENCED" ||
        code === "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED"
        ? code
        : "SCRY_BROWSER_COMMAND_CLAIM_UNAVAILABLE",
    );
  }
  private async renew(): Promise<void> {
    if (this.#renewing || this.#disposed || this.#failure) return;
    this.#renewing = true;
    try {
      this.assertActive();
      const sample = await this.commands.heartbeatClaim(this.commandId, this.claimToken);
      if (this.#disposed || this.#failure) return;
      this.assertActive(); // A late response cannot resurrect an expired lease.
      this.apply(sample, "heartbeat");
      this.assertActive();
      this.#claimRevision += 1;
      this.armWatch();
    } catch (error) {
      this.admissionFailure(error);
    } finally {
      this.#renewing = false;
      this.armHeartbeat();
    }
  }
  async checkpoint(): Promise<void> {
    this.assertActive();
    try {
      const sample = await this.commands.assertClaim(this.commandId, this.claimToken);
      this.assertActive();
      this.apply(sample, "check");
      this.armWatch();
      this.armHeartbeat();
      this.assertActive();
    } catch (error) {
      if (this.#disposed) throw new Error("SCRY_BROWSER_COMMAND_ATTEMPT_ENDED");
      this.admissionFailure(error);
      throw this.#failure!;
    }
  }
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#watch);
    clearTimeout(this.#heartbeat);
  }
}
