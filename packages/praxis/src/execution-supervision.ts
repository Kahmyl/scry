import { performance } from "node:perf_hooks";
import type { PraxisCommandOptions } from "@scry/contracts";
import type { CommandAttempt } from "./command-lane.js";
import type { SupervisedCommand } from "./supervision-authority.js";

/** Parent-side phase inventory, not a second command authority. Budgets come
 * from the exact active attempt and acknowledged application claim. Concurrent
 * native suboperations retain separate deadlines; starting a new phase cannot
 * accidentally extend an earlier still-running operation. */
export class ExecutionSupervision {
  #sequence = 0;
  #phaseSequence = 0;
  #token = 0;
  #phases = new Map<number, number>();
  #attempt: CommandAttempt | undefined;
  #sample: PraxisCommandOptions["sampleAuthority"];
  #failed = false;
  constructor(private readonly now: () => number = () => performance.now()) {}

  begin(attempt: CommandAttempt, sample?: PraxisCommandOptions["sampleAuthority"]): void {
    if (this.#attempt || this.#failed || this.#sequence >= Number.MAX_SAFE_INTEGER - 1)
      throw new Error("SCRY_BROWSER_COMMAND_CONCURRENT");
    attempt.assertActive();
    this.#attempt = attempt;
    this.#sample = sample;
    this.#sequence += 1;
    this.#phaseSequence = 0;
  }
  sample(): SupervisedCommand {
    if (this.#failed) throw new Error("SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED");
    const attempt = this.#attempt;
    if (!attempt) return { state: "idle", sequence: this.#sequence };
    const executionRemainingMs = attempt.remainingMs();
    const claim = this.#sample?.() ?? {
      executionRemainingMs,
      claimRemainingMs: Math.min(300000, executionRemainingMs),
      claimRevision: 0,
    };
    const phase = this.#phases.size
      ? Math.max(0, Math.floor(Math.min(...this.#phases.values()) - this.now()))
      : executionRemainingMs;
    return {
      state: "active",
      sequence: this.#sequence,
      executionRemainingMs: Math.min(executionRemainingMs, claim.executionRemainingMs),
      claim: { revision: claim.claimRevision, remainingMs: claim.claimRemainingMs },
      phase: { sequence: this.#phaseSequence, remainingMs: phase },
    };
  }
  enterPhase(limitMs: number): number {
    if (
      !this.#attempt ||
      this.#failed ||
      this.#phases.size >= 16 ||
      this.#phaseSequence >= Number.MAX_SAFE_INTEGER - 1 ||
      this.#token === Number.MAX_SAFE_INTEGER
    )
      throw new Error("SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED");
    const remaining = this.#attempt.remainingMs(limitMs);
    const token = ++this.#token;
    this.#phases.set(token, this.now() + remaining);
    this.#phaseSequence += 1;
    return token;
  }
  leavePhase(token: number): void {
    const deadline = this.#phases.get(token);
    this.#phases.delete(token);
    this.#phaseSequence += 1;
    if (deadline === undefined || this.now() >= deadline) {
      this.#failed = true;
      throw new Error("SCRY_BROWSER_COMMAND_PHASE_EXPIRED");
    }
  }
  finish(physicallyRetired = false): void {
    if (!this.#attempt) return;
    if (this.#phases.size || (this.#failed && !physicallyRetired))
      throw new Error("SCRY_BROWSER_COMMAND_DRAIN_UNCONFIRMED");
    this.#attempt = undefined;
    this.#sample = undefined;
    this.#sequence += 1;
  }
}
