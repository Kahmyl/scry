import { describe, expect, it } from "vitest";
import {
  SupervisionAuthority,
  type SupervisedCommand,
  type SupervisionAuthorityReply,
} from "../src/supervision-authority.js";

function fixture() {
  let clock = 7000000;
  const authority = new SupervisionAuthority(() => clock);
  const respond = (
    command: SupervisedCommand = { state: "idle", sequence: 0 },
    owner = { revision: 0, remainingMs: 60000 },
  ) =>
    authority.accept({ kind: "authority", challenge: authority.issueChallenge(), owner, command });
  return {
    authority,
    respond,
    advance: (ms: number) => (clock += ms),
    set: (ms: number) => (clock = ms),
  };
}
const active = (
  input: Partial<Extract<SupervisedCommand, { state: "active" }>> = {},
): SupervisedCommand => ({
  state: "active",
  sequence: 1,
  executionRemainingMs: 1000,
  claim: { revision: 0, remainingMs: 1000 },
  phase: { sequence: 0, remainingMs: 1000 },
  ...input,
});

describe("custodian-clock supervision authority", () => {
  it("requires initial acknowledged authority and returns exact immutable barrier facts", () => {
    const { authority, respond } = fixture();
    expect(authority.state).toBe("awaiting");
    const acknowledgment = respond(active());
    expect(acknowledgment).toEqual({
      challenge: 1,
      commandSequence: 1,
      ownerRevision: 0,
      phaseSequence: 0,
      claimRevision: 0,
    });
    expect(Object.isFrozen(acknowledgment)).toBe(true);
    expect(authority.state).toBe("active");
    expect(authority.challengePending).toBe(false);
    expect(authority.deadline).toBe(7001000);
  });
  it("bounds startup without any reply", () => {
    const { authority, advance } = fixture();
    authority.issueChallenge();
    advance(2000);
    expect(() => authority.assertCurrent()).toThrow("CONTROLLER_UNAVAILABLE");
    expect(authority.state).toBe("stopped");
  });
  it("anchors a reply before both transport legs, not at arrival", () => {
    const { authority, advance } = fixture();
    const challenge = authority.issueChallenge();
    advance(300);
    authority.accept({
      kind: "authority",
      challenge,
      owner: { revision: 0, remainingMs: 500 },
      command: { state: "idle", sequence: 0 },
    });
    advance(199);
    authority.assertCurrent();
    advance(1);
    expect(() => authority.assertCurrent()).toThrow("OWNER_EXPIRED");
  });
  it("refuses already expired initial authority before browser launch could be authorized", () => {
    const { authority, advance } = fixture();
    const challenge = authority.issueChallenge();
    advance(300);
    expect(() =>
      authority.accept({
        kind: "authority",
        challenge,
        owner: { revision: 0, remainingMs: 200 },
        command: { state: "idle", sequence: 0 },
      }),
    ).toThrow("OWNER_EXPIRED");
    expect(authority.state).toBe("stopped");
  });
  it("does not renew owner authority merely because the controller responds", () => {
    const { authority, respond, advance } = fixture();
    respond(undefined, { revision: 0, remainingMs: 500 });
    advance(300);
    respond(undefined, { revision: 0, remainingMs: 1000 });
    advance(200);
    expect(() => authority.assertCurrent()).toThrow("OWNER_EXPIRED");
  });
  it("allows an acknowledged newer owner renewal while old authority is still valid", () => {
    const { authority, respond, advance } = fixture();
    respond(undefined, { revision: 0, remainingMs: 500 });
    advance(300);
    respond(undefined, { revision: 1, remainingMs: 1000 });
    advance(300);
    authority.assertCurrent();
    advance(700);
    expect(() => authority.assertCurrent()).toThrow("OWNER_EXPIRED");
  });
  it("does not resurrect an expired owner with a newer revision or an idle end", () => {
    const { authority, respond, advance } = fixture();
    respond(active(), { revision: 0, remainingMs: 100 });
    const challenge = authority.issueChallenge();
    advance(100);
    expect(() =>
      authority.accept({
        kind: "authority",
        challenge,
        owner: { revision: 1, remainingMs: 1000 },
        command: { state: "idle", sequence: 2 },
      }),
    ).toThrow("OWNER_EXPIRED");
  });
  it("never extends the absolute execution deadline through owner, claim or phase renewal", () => {
    const { authority, respond, advance } = fixture();
    respond(active());
    advance(100);
    respond(
      active({
        executionRemainingMs: 5000,
        claim: { revision: 1, remainingMs: 5000 },
        phase: { sequence: 1, remainingMs: 5000 },
      }),
      { revision: 1, remainingMs: 60000 },
    );
    advance(900);
    expect(() => authority.assertCurrent()).toThrow("COMMAND_EXPIRED");
  });
  it("can tighten execution, claim and phase deadlines", () => {
    const { authority, respond, advance } = fixture();
    respond(active());
    advance(100);
    respond(
      active({
        executionRemainingMs: 100,
        claim: { revision: 0, remainingMs: 200 },
        phase: { sequence: 0, remainingMs: 300 },
      }),
    );
    advance(100);
    expect(() => authority.assertCurrent()).toThrow("COMMAND_EXPIRED");
  });
  it("keeps a claim deadline on repeated revision even if its advertised budget grows", () => {
    const { authority, respond, advance } = fixture();
    respond(active({ claim: { revision: 0, remainingMs: 300 } }));
    advance(100);
    respond(active({ claim: { revision: 0, remainingMs: 1000 } }));
    advance(200);
    expect(() => authority.assertCurrent()).toThrow("CLAIM_EXPIRED");
  });
  it("accepts an acknowledged claim renewal without changing the execution limit", () => {
    const { authority, respond, advance } = fixture();
    respond(active({ claim: { revision: 0, remainingMs: 300 } }));
    advance(100);
    respond(active({ claim: { revision: 1, remainingMs: 700 } }));
    advance(400);
    authority.assertCurrent();
    advance(300);
    expect(() => authority.assertCurrent()).toThrow("CLAIM_EXPIRED");
  });
  it("expires a shorter phase independently of the whole command", () => {
    const { authority, respond, advance } = fixture();
    respond(active({ phase: { sequence: 0, remainingMs: 200 } }));
    advance(100);
    respond(active({ phase: { sequence: 0, remainingMs: 1000 } }));
    advance(100);
    expect(() => authority.assertCurrent()).toThrow("PHASE_EXPIRED");
  });
  it("permits a new phase before the prior phase expires", () => {
    const { authority, respond, advance } = fixture();
    respond(active({ phase: { sequence: 0, remainingMs: 200 } }));
    advance(100);
    const receipt = respond(active({ phase: { sequence: 1, remainingMs: 500 } }));
    expect(receipt.phaseSequence).toBe(1);
    advance(300);
    authority.assertCurrent();
    advance(200);
    expect(() => authority.assertCurrent()).toThrow("PHASE_EXPIRED");
  });
  it.each(["execution", "claim", "phase"])(
    "checks expired %s authority before an end message",
    (kind) => {
      const { authority, respond, advance } = fixture();
      respond(
        active({
          ...(kind === "execution"
            ? { executionRemainingMs: 100 }
            : kind === "claim"
              ? { claim: { revision: 0, remainingMs: 100 } }
              : { phase: { sequence: 0, remainingMs: 100 } }),
        }),
      );
      const challenge = authority.issueChallenge();
      advance(100);
      expect(() =>
        authority.accept({
          kind: "authority",
          challenge,
          owner: { revision: 1, remainingMs: 60000 },
          command: { state: "idle", sequence: 2 },
        }),
      ).toThrow(
        kind === "execution"
          ? "COMMAND_EXPIRED"
          : kind === "claim"
            ? "CLAIM_EXPIRED"
            : "PHASE_EXPIRED",
      );
    },
  );
  it("bounds liveness independently even when database budgets are large", () => {
    const { authority, respond, advance } = fixture();
    respond(
      active({
        executionRemainingMs: 900000,
        claim: { revision: 0, remainingMs: 300000 },
        phase: { sequence: 0, remainingMs: 900000 },
      }),
    );
    authority.issueChallenge();
    advance(2000);
    expect(() => authority.assertCurrent()).toThrow("CONTROLLER_UNAVAILABLE");
  });
  it("permits sequential commands only after an exact newer idle transition", () => {
    const { authority, respond } = fixture();
    respond(active());
    expect(respond({ state: "idle", sequence: 2 }).phaseSequence).toBeNull();
    expect(respond(active({ sequence: 3 })).commandSequence).toBe(3);
    authority.assertCurrent();
  });
  it.each([0, 1, 2])("cannot revive an ended command at sequence %i", (sequence) => {
    const { authority, respond } = fixture();
    respond(active());
    respond({ state: "idle", sequence: 2 });
    expect(() => respond(active({ sequence }))).toThrow("PROTOCOL_INVALID");
  });
  it("refuses overlapping replacement instead of forgetting the running command", () => {
    const { authority, respond } = fixture();
    respond(active());
    expect(() => respond(active({ sequence: 3 }))).toThrow("PROTOCOL_INVALID");
    expect(authority.state).toBe("stopped");
  });
  it.each([0, 1])("refuses a stale idle transition at sequence %i", (sequence) => {
    const { respond } = fixture();
    respond(active());
    expect(() => respond({ state: "idle", sequence })).toThrow("PROTOCOL_INVALID");
  });
  it("refuses an idle sequence jump without an active command", () => {
    const { respond } = fixture();
    respond();
    expect(() => respond({ state: "idle", sequence: 2 })).toThrow("PROTOCOL_INVALID");
  });
  it.each(["owner", "claim", "phase"])("refuses an older %s revision", (kind) => {
    const { respond } = fixture();
    respond(
      active({
        claim: { revision: 2, remainingMs: 1000 },
        phase: { sequence: 2, remainingMs: 1000 },
      }),
      { revision: 2, remainingMs: 60000 },
    );
    expect(() =>
      respond(
        active({
          claim: { revision: kind === "claim" ? 1 : 2, remainingMs: 1000 },
          phase: { sequence: kind === "phase" ? 1 : 2, remainingMs: 1000 },
        }),
        { revision: kind === "owner" ? 1 : 2, remainingMs: 60000 },
      ),
    ).toThrow("PROTOCOL_INVALID");
  });
  it("allows only one pending challenge and never replaces its earlier anchor", () => {
    const { authority } = fixture();
    authority.issueChallenge();
    expect(() => authority.issueChallenge()).toThrow("PROTOCOL_INVALID");
    expect(authority.challengePending).toBe(false);
  });
  it.each(["unsolicited", "wrong", "duplicate"])("refuses %s replies permanently", (kind) => {
    const { authority, respond } = fixture();
    let challenge = 1;
    if (kind === "duplicate") respond();
    if (kind === "wrong") challenge = authority.issueChallenge() + 1;
    expect(() =>
      authority.accept({
        kind: "authority",
        challenge,
        owner: { revision: 0, remainingMs: 60000 },
        command: { state: "idle", sequence: 0 },
      }),
    ).toThrow("PROTOCOL_INVALID");
    expect(() => respond()).toThrow("PROTOCOL_INVALID");
  });
  it.each([
    null,
    [],
    {},
    { kind: "unknown" },
    { owner: { revision: -1, remainingMs: 1000 } },
    { owner: { revision: Number.MAX_SAFE_INTEGER + 1, remainingMs: 1000 } },
    { owner: { revision: 0, remainingMs: 0 } },
    { owner: { revision: 0, remainingMs: 300001 } },
    { owner: { revision: 0, remainingMs: NaN } },
    { owner: { revision: 0, remainingMs: 1.5 } },
    { command: { state: "idle", sequence: -1 } },
    { command: { state: "active", sequence: 1 } },
    { command: active({ executionRemainingMs: 900001 }) },
    { command: active({ claim: { revision: 0, remainingMs: Infinity } }) },
    { command: active({ phase: { sequence: 0, remainingMs: 0 } }) },
    { privateValue: "fixture-secret-never-in-error" },
  ])("refuses malformed messages without disclosing their contents: %j", (change) => {
    const { authority } = fixture();
    const challenge = authority.issueChallenge();
    const valid: SupervisionAuthorityReply = {
      kind: "authority",
      challenge,
      owner: { revision: 0, remainingMs: 60000 },
      command: { state: "idle", sequence: 0 },
    };
    const input = change === null || Array.isArray(change) ? change : { ...valid, ...change };
    // Empty object is also a valid empty override; submit it as malformed itself.
    expect(() =>
      authority.accept(change && Object.keys(change).length === 0 ? change : input),
    ).toThrow(/^SCRY_BROWSER_SUPERVISION_PROTOCOL_INVALID$/u);
    expect(authority.state).toBe("stopped");
  });
  it.each([NaN, Infinity, -1])("fails closed on an invalid clock %s", (clock) => {
    const { authority, set } = fixture();
    set(clock);
    expect(() => authority.assertCurrent()).toThrow("CLOCK_INVALID");
  });
  it("permanently stops after transport loss without an invented native-exit receipt", () => {
    const { authority, respond } = fixture();
    respond();
    authority.stop("transport_failed");
    authority.stop("explicit");
    expect(authority.reason).toBe("transport_failed");
    expect(() => respond()).toThrow("TRANSPORT_FAILED");
    expect("exitConfirmed" in authority).toBe(false);
  });
  it("keeps constant-size authority state over ten thousand complete commands", () => {
    const { authority, respond } = fixture();
    respond();
    for (let sequence = 1; sequence < 20000; sequence += 2) {
      respond(active({ sequence }));
      respond({ state: "idle", sequence: sequence + 1 });
    }
    expect(authority.state).toBe("active");
    expect(authority.challengePending).toBe(false);
  });
  it.each([0, 99, 5001, NaN, 100.5])("refuses an invalid controller budget %s", (budget) => {
    expect(() => new SupervisionAuthority(() => 0, budget)).toThrow("CONFIGURATION_INVALID");
  });
});
