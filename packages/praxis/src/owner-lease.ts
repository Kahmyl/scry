import type {
  EvidenceWriteAdmission,
  PraxisEffectsPort,
  PraxisOwnerIdentity,
} from "@scry/contracts";

/** A local revocation is permanent for this browser instance. Database recovery
 * cannot accidentally re-admit buffered evidence from a discarded instance. */
export class PraxisOwnerLease implements EvidenceWriteAdmission {
  #state: "active" | "revoked" = "active";
  constructor(
    readonly identity: PraxisOwnerIdentity,
    private readonly effects: Pick<PraxisEffectsPort, "withOwner" | "heartbeatOwner">,
  ) {}

  assertActive(): void {
    if (this.#state !== "active") throw new Error("SCRY_BROWSER_OWNER_FENCED");
  }
  revoke(): void {
    this.#state = "revoked";
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertActive();
    try {
      return await this.effects.withOwner(this.identity, async () => {
        this.assertActive();
        return work();
      });
    } catch (error) {
      this.revoke();
      throw error;
    }
  }
  async heartbeat(leaseMs: number): Promise<void> {
    this.assertActive();
    try {
      await this.effects.heartbeatOwner(
        this.identity.sessionId,
        this.identity.generation,
        this.identity.leaseToken,
        leaseMs,
      );
    } catch (error) {
      this.revoke();
      throw error;
    }
  }
}
