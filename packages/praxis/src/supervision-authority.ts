/** Private cross-process control. No session identifiers, credentials, URLs,
 * browser endpoints, database tokens or customer values belong in these messages.
 * Revisions come only from acknowledged authority, never controller liveness. */
export interface RenewableAuthority {
  revision: number;
  remainingMs: number;
}
export type SupervisedCommand =
  | { state: "idle"; sequence: number }
  | {
      state: "active";
      sequence: number;
      executionRemainingMs: number;
      claim: RenewableAuthority;
      phase: { sequence: number; remainingMs: number };
    };
export interface SupervisionAuthorityReply {
  kind: "authority";
  challenge: number;
  owner: RenewableAuthority;
  command: SupervisedCommand;
}
export interface SupervisionAcknowledgment {
  challenge: number;
  commandSequence: number;
  ownerRevision: number;
  phaseSequence: number | null;
  claimRevision: number | null;
}
export type SupervisionStopReason =
  | "controller_unavailable"
  | "owner_expired"
  | "command_expired"
  | "claim_expired"
  | "phase_expired"
  | "protocol_invalid"
  | "clock_invalid"
  | "transport_failed"
  | "explicit";

interface ActiveCommand {
  executionDeadline: number;
  claimDeadline: number;
  claimRevision: number;
  phaseDeadline: number;
  phaseSequence: number;
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
const ordinal = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const remaining = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
function renewable(value: unknown): value is RenewableAuthority {
  return (
    record(value, ["revision", "remainingMs"]) &&
    ordinal(value.revision) &&
    remaining(value.remainingMs, 300000)
  );
}
function command(value: unknown): value is SupervisedCommand {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (input.state === "idle")
    return record(input, ["state", "sequence"]) && ordinal(input.sequence);
  return (
    record(input, ["state", "sequence", "executionRemainingMs", "claim", "phase"]) &&
    input.state === "active" &&
    ordinal(input.sequence) &&
    remaining(input.executionRemainingMs, 900000) &&
    renewable(input.claim) &&
    record(input.phase, ["sequence", "remainingMs"]) &&
    ordinal(input.phase.sequence) &&
    remaining(input.phase.remainingMs, 900000)
  );
}
function reply(value: unknown): value is SupervisionAuthorityReply {
  return (
    record(value, ["kind", "challenge", "owner", "command"]) &&
    value.kind === "authority" &&
    ordinal(value.challenge) &&
    renewable(value.owner) &&
    command(value.command)
  );
}

/** Custodian-clock authority, independent of the application's event loop.
 * A response's remaining time is anchored at challenge SEND, not arrival. This
 * conservatively consumes transport without assuming two process clock origins
 * are comparable. One outstanding challenge bounds state and prevents reordering.
 * The caller must physically stop custody on failure; this class grants no exit
 * receipt and intentionally does not own browser launch or timers. */
export class SupervisionAuthority {
  #state: "awaiting" | "active" | "stopped" = "awaiting";
  #reason: SupervisionStopReason | undefined;
  #lastClock = -Infinity;
  #livenessDeadline: number;
  #ownerDeadline = Infinity;
  #ownerRevision = -1;
  #challenge = 0;
  #pending: { sequence: number; sentAt: number } | undefined;
  #commandSequence = 0;
  #command: ActiveCommand | undefined;

  constructor(
    private readonly now: () => number,
    private readonly controllerBudgetMs = 2000,
  ) {
    if (
      !Number.isSafeInteger(controllerBudgetMs) ||
      controllerBudgetMs < 100 ||
      controllerBudgetMs > 5000
    )
      throw new Error("SCRY_BROWSER_SUPERVISION_CONFIGURATION_INVALID");
    this.#livenessDeadline = this.clock() + controllerBudgetMs;
  }

  get state(): "awaiting" | "active" | "stopped" {
    return this.#state;
  }
  get reason(): SupervisionStopReason | undefined {
    return this.#reason;
  }
  get challengePending(): boolean {
    return this.#pending !== undefined;
  }
  get deadline(): number {
    return Math.min(
      this.#livenessDeadline,
      this.#ownerDeadline,
      this.#command?.executionDeadline ?? Infinity,
      this.#command?.claimDeadline ?? Infinity,
      this.#command?.phaseDeadline ?? Infinity,
    );
  }

  stop(reason: SupervisionStopReason): void {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#reason = reason;
    this.#pending = undefined;
    this.#command = undefined;
  }
  private fail(reason: SupervisionStopReason): never {
    this.stop(reason);
    throw this.failure();
  }
  private failure(): Error {
    return new Error(
      `SCRY_BROWSER_SUPERVISION_${this.#reason?.toUpperCase() ?? "PROTOCOL_INVALID"}`,
    );
  }
  private clock(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < this.#lastClock) this.fail("clock_invalid");
    this.#lastClock = now;
    return now;
  }

  assertCurrent(): void {
    if (this.#state === "stopped") throw this.failure();
    const now = this.clock();
    if (now >= this.#livenessDeadline) this.fail("controller_unavailable");
    if (now >= this.#ownerDeadline) this.fail("owner_expired");
    if (this.#command) {
      if (now >= this.#command.executionDeadline) this.fail("command_expired");
      if (now >= this.#command.claimDeadline) this.fail("claim_expired");
      if (now >= this.#command.phaseDeadline) this.fail("phase_expired");
    }
  }

  issueChallenge(): number {
    this.assertCurrent();
    if (this.#pending || this.#challenge === Number.MAX_SAFE_INTEGER) this.fail("protocol_invalid");
    const sequence = ++this.#challenge;
    this.#pending = { sequence, sentAt: this.clock() };
    return sequence;
  }

  accept(value: unknown): SupervisionAcknowledgment {
    this.assertCurrent(); // No late acknowledgment can resurrect old authority.
    const pending = this.#pending;
    if (!pending || !reply(value) || value.challenge !== pending.sequence)
      this.fail("protocol_invalid");
    this.#pending = undefined;
    const { owner, command: input } = value;
    if (owner.revision < this.#ownerRevision) this.fail("protocol_invalid");
    const ownerDeadline = pending.sentAt + owner.remainingMs;
    this.#ownerDeadline =
      owner.revision > this.#ownerRevision
        ? ownerDeadline
        : Math.min(this.#ownerDeadline, ownerDeadline);
    this.#ownerRevision = owner.revision;

    if (input.state === "idle") {
      if (
        this.#command
          ? input.sequence <= this.#commandSequence
          : input.sequence !== this.#commandSequence
      )
        this.fail("protocol_invalid");
      this.#command = undefined;
    } else {
      const previous = this.#command;
      if (
        previous
          ? input.sequence !== this.#commandSequence
          : input.sequence <= this.#commandSequence
      )
        this.fail("protocol_invalid");
      if (
        previous &&
        (input.claim.revision < previous.claimRevision ||
          input.phase.sequence < previous.phaseSequence)
      )
        this.fail("protocol_invalid");
      const claimDeadline = pending.sentAt + input.claim.remainingMs;
      const phaseDeadline = pending.sentAt + input.phase.remainingMs;
      this.#command = {
        executionDeadline: Math.min(
          previous?.executionDeadline ?? Infinity,
          pending.sentAt + input.executionRemainingMs,
        ),
        claimDeadline:
          previous && input.claim.revision === previous.claimRevision
            ? Math.min(previous.claimDeadline, claimDeadline)
            : claimDeadline,
        claimRevision: input.claim.revision,
        phaseDeadline:
          previous && input.phase.sequence === previous.phaseSequence
            ? Math.min(previous.phaseDeadline, phaseDeadline)
            : phaseDeadline,
        phaseSequence: input.phase.sequence,
      };
    }
    this.#commandSequence = input.sequence;
    this.#livenessDeadline = pending.sentAt + this.controllerBudgetMs;
    this.#state = "active";
    this.assertCurrent(); // Includes time spent in both directions of transport.
    return Object.freeze({
      challenge: pending.sequence,
      commandSequence: this.#commandSequence,
      ownerRevision: this.#ownerRevision,
      phaseSequence: this.#command?.phaseSequence ?? null,
      claimRevision: this.#command?.claimRevision ?? null,
    });
  }
}
