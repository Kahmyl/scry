import type {
  EvidenceWriteAdmission,
  PraxisEffectsPort,
  PraxisOwnerIdentity,
  PraxisOwnerLeaseSample,
} from "@scry/contracts";
import { performance } from "node:perf_hooks";

/** A local revocation is permanent for this browser instance. Database recovery
 * cannot accidentally re-admit buffered evidence from a discarded instance. */
export class PraxisOwnerLease implements EvidenceWriteAdmission {
  #state: "active" | "revoked" = "active";
  readonly #controller = new AbortController();
  #deadline = Infinity;
  #watch: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #renewalBudget: number | undefined;
  #renewing: Promise<void> | undefined;
  constructor(
    readonly identity: PraxisOwnerIdentity,
    private readonly effects: Pick<PraxisEffectsPort, "withOwner" | "heartbeatOwner">,
    initial: PraxisOwnerLeaseSample,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.apply(initial);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  startHeartbeat(leaseMs: number): void {
    this.assertActive();
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1000 ||
      leaseMs > 300000 ||
      this.#renewalBudget !== undefined
    )
      throw new Error("SCRY_BROWSER_OWNER_LEASE_INVALID");
    this.#renewalBudget = leaseMs;
    this.armHeartbeat();
  }

  private armHeartbeat(): void {
    clearTimeout(this.#heartbeat);
    if (this.#state !== "active" || this.#renewing || this.#renewalBudget === undefined) return;
    const budget = this.#renewalBudget;
    // Recompute from current local authority, not the original sample or a
    // fixed interval. A delayed initial acknowledgement may have little time
    // left; a successful renewal must then restore the normal cadence.
    const delay = Math.max(1, Math.min(20000, Math.floor((this.#deadline - this.now()) / 3)));
    this.#heartbeat = setTimeout(() => {
      void this.heartbeat(budget).catch(() => undefined);
    }, delay);
    this.#heartbeat.unref?.();
  }

  private apply(sample: PraxisOwnerLeaseSample): void {
    const now = this.now();
    if (
      !sample ||
      !Number.isSafeInteger(sample.leaseRemainingMs) ||
      sample.leaseRemainingMs < 0 ||
      sample.leaseRemainingMs > 300000 ||
      !Number.isFinite(sample.sampleStartedAt) ||
      sample.sampleStartedAt > now
    ) {
      this.revoke();
      return;
    }
    this.#deadline = sample.sampleStartedAt + sample.leaseRemainingMs;
    this.armWatch();
  }

  private armWatch(): void {
    clearTimeout(this.#watch);
    if (this.#state !== "active") return;
    const now = this.now();
    if (now >= this.#deadline) {
      this.revoke();
      return;
    }
    this.#watch = setTimeout(
      () => {
        if (this.now() >= this.#deadline) this.revoke();
        else this.armWatch();
      },
      Math.max(1, Math.ceil(this.#deadline - now)),
    );
    this.#watch.unref?.();
  }

  assertActive(): void {
    if (this.now() >= this.#deadline) this.revoke();
    if (this.#state !== "active") throw new Error("SCRY_BROWSER_OWNER_FENCED");
  }
  revoke(): void {
    if (this.#state === "revoked") return;
    this.#state = "revoked";
    clearTimeout(this.#watch);
    clearTimeout(this.#heartbeat);
    this.#controller.abort(new Error("SCRY_BROWSER_OWNER_FENCED"));
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive();
    try {
      const result = await this.effects.withOwner(this.identity, async () => {
        this.assertActive();
        return work();
      });
      this.assertActive();
      return result;
    } catch (error) {
      this.revoke();
      throw error;
    }
  }
  async heartbeat(leaseMs: number): Promise<void> {
    this.assertActive();
    if (this.#renewing) return this.#renewing;
    const renewal = Promise.resolve()
      .then(async () => {
        this.assertActive();
        const sample = await this.effects.heartbeatOwner(
          this.identity.sessionId,
          this.identity.generation,
          this.identity.leaseToken,
          leaseMs,
        );
        this.assertActive();
        this.apply(sample);
        this.assertActive();
      })
      .catch((error) => {
        this.revoke();
        throw error;
      })
      .finally(() => {
        if (this.#renewing === renewal) this.#renewing = undefined;
        this.armHeartbeat();
      });
    this.#renewing = renewal;
    return renewal;
  }
}
