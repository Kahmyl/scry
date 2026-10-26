import { describe, expect, it } from "vitest";
import { CommandAttempt } from "../src/command-lane.js";
import { ExecutionSupervision } from "../src/execution-supervision.js";

function active(control: ExecutionSupervision) {
  const sample = control.sample();
  if (sample.state !== "active") throw new Error("fixture has no active attempt");
  return sample;
}
describe("exact-attempt native phase inventory", () => {
  it("does not acquire phase ownership for an already cancelled attempt", () => {
    const control = new ExecutionSupervision();
    const attempt = new CommandAttempt({ remainingMs: 0 });
    expect(() => control.begin(attempt)).toThrow("DEADLINE_EXCEEDED");
    expect(control.sample()).toEqual({ state: "idle", sequence: 0 });
  });
  it("retains the shortest unfinished native phase when a sibling phase starts", async () => {
    let now = 0;
    const control = new ExecutionSupervision(() => now);
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt);
      const first = control.enterPhase(200);
      const second = control.enterPhase(500);
      now = 100;
      expect(active(control).phase.remainingMs).toBe(100);
      const before = active(control).phase.sequence;
      control.leavePhase(first);
      expect(active(control).phase.sequence).toBeGreaterThan(before);
      expect(active(control).phase.remainingMs).toBe(400);
      control.leavePhase(second);
      control.finish();
    });
    expect(control.sample()).toEqual({ state: "idle", sequence: 2 });
  });
  it("does not forget another still-running phase when one sibling settles", async () => {
    const control = new ExecutionSupervision(() => 0);
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt);
      const first = control.enterPhase(200);
      const second = control.enterPhase(500);
      control.leavePhase(second);
      expect(active(control).phase.remainingMs).toBe(200);
      expect(() => control.finish()).toThrow("DRAIN_UNCONFIRMED");
      control.leavePhase(first);
      control.finish();
    });
  });
  it("requires physical retirement after a phase completes past its deadline", async () => {
    let now = 0;
    const control = new ExecutionSupervision(() => now);
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt);
      const token = control.enterPhase(100);
      now = 100;
      expect(() => control.leavePhase(token)).toThrow("PHASE_EXPIRED");
      expect(() => control.sample()).toThrow("DRAIN_UNCONFIRMED");
      expect(() => control.finish()).toThrow("DRAIN_UNCONFIRMED");
      control.finish(true);
    });
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      expect(() => control.begin(attempt)).toThrow("COMMAND_CONCURRENT");
    });
  });
  it("cannot waive a live sibling phase by claiming physical retirement", async () => {
    const control = new ExecutionSupervision(() => 0);
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt);
      const token = control.enterPhase(100);
      expect(() => control.finish(true)).toThrow("DRAIN_UNCONFIRMED");
      control.leavePhase(token);
      control.finish();
    });
  });
  it("mirrors acknowledged claim authority without tokens or an independent renewal source", async () => {
    const control = new ExecutionSupervision();
    let revision = 2,
      remaining = 400;
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt, () => ({
        executionRemainingMs: 800,
        claimRemainingMs: remaining,
        claimRevision: revision,
      }));
      expect(active(control).executionRemainingMs).toBe(800);
      expect(active(control).claim).toEqual({ revision: 2, remainingMs: 400 });
      revision = 3;
      remaining = 600;
      expect(active(control).claim).toEqual({ revision: 3, remainingMs: 600 });
      control.finish();
    });
  });
  it("bounds fallback claim authority separately from a long closure execution budget", async () => {
    const control = new ExecutionSupervision();
    await new CommandAttempt({ remainingMs: 900000 }).run(async (attempt) => {
      control.begin(attempt);
      expect(active(control).claim.remainingMs).toBe(300000);
      control.finish();
    });
  });
  it("bounds the inventory and refuses invalid phase budgets without registering work", async () => {
    const control = new ExecutionSupervision();
    await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
      control.begin(attempt);
      expect(() => control.enterPhase(0)).toThrow("PHASE_BUDGET_INVALID");
      const tokens = Array.from({ length: 16 }, () => control.enterPhase(1000));
      expect(() => control.enterPhase(1000)).toThrow("DRAIN_UNCONFIRMED");
      tokens.forEach((token) => control.leavePhase(token));
      control.finish();
    });
  });
  it("uses monotonic command sequences across complete attempts and refuses overlap", async () => {
    const control = new ExecutionSupervision();
    for (let index = 0; index < 2; index++)
      await new CommandAttempt({ remainingMs: 5000 }).run(async (attempt) => {
        control.begin(attempt);
        expect(active(control).sequence).toBe(index * 2 + 1);
        expect(() => control.begin(attempt)).toThrow("COMMAND_CONCURRENT");
        control.finish();
      });
    expect(control.sample()).toEqual({ state: "idle", sequence: 4 });
  });
});
