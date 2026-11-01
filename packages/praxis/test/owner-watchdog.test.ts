import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PraxisOwnerLease } from "../src/owner-lease.js";
import type { PraxisEffectsPort } from "@scry/contracts";

beforeEach(() => {
  vi.useFakeTimers();
  const origin = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - origin);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const sample = (leaseRemainingMs = 60000, age = 0) => ({
  leaseRemainingMs,
  sampleStartedAt: performance.now() - age,
});
function fixture(initial = sample()) {
  const effects = {
    assertOwner: vi.fn(async (): Promise<void> => undefined),
    heartbeatOwner: vi.fn(async () => sample()),
  };
  const lease = new PraxisOwnerLease(
    { sessionId: "session", generation: 1, leaseToken: "token" },
    effects as unknown as PraxisEffectsPort,
    initial,
  );
  return { effects, lease };
}
describe("monotonic browser owner watchdog", () => {
  it("exports only relative remaining authority and acknowledged owner renewal revision", async () => {
    const { lease, effects } = fixture(sample(60000, 200));
    try {
      expect(lease.authoritySample()).toEqual({ revision: 0, remainingMs: 59800 });
      await lease.checkpoint();
      expect(lease.authoritySample().revision).toBe(0);
      let deliver!: (value: ReturnType<typeof sample>) => void;
      effects.heartbeatOwner.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      );
      const pending = lease.heartbeat(60000);
      await Promise.resolve();
      expect(lease.authoritySample().revision).toBe(0);
      deliver(sample());
      await pending;
      expect(lease.authoritySample().revision).toBe(1);
    } finally {
      lease.revoke();
    }
    expect(() => lease.authoritySample()).toThrow("OWNER_FENCED");
  });
  it("clears periodic renewal and expiry timers together on revocation", async () => {
    const { lease, effects } = fixture();
    lease.startHeartbeat(60000);
    lease.revoke();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(effects.heartbeatOwner).not.toHaveBeenCalled();
  });
  it("renews before a transport-shortened initial lease, then restores the normal cadence", async () => {
    const { lease, effects } = fixture(sample(1000, 700));
    try {
      lease.startHeartbeat(60000);
      await vi.advanceTimersByTimeAsync(100);
      expect(effects.heartbeatOwner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(19999);
      expect(effects.heartbeatOwner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(effects.heartbeatOwner).toHaveBeenCalledTimes(2);
    } finally {
      lease.revoke();
    }
  });
  it("uses monotonic authority rather than application wall-clock changes", () => {
    const { effects, lease: fixtureLease } = fixture();
    fixtureLease.revoke();
    let clock = 0;
    const lease = new PraxisOwnerLease(
      { sessionId: "clock", generation: 1, leaseToken: "token" },
      effects as unknown as PraxisEffectsPort,
      { leaseRemainingMs: 1000, sampleStartedAt: 0 },
      () => clock,
    );
    try {
      vi.setSystemTime(Date.now() + 86400000);
      lease.assertActive();
      vi.setSystemTime(Date.now() - 172800000);
      lease.assertActive();
      clock = 1000;
      expect(() => lease.assertActive()).toThrow("OWNER_FENCED");
    } finally {
      lease.revoke();
    }
  });
  it("expires without waiting for a database response", async () => {
    const { lease } = fixture(sample(1000));
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(lease.signal?.aborted).toBe(true);
      expect(() => lease.assertActive()).toThrow("OWNER_FENCED");
    } finally {
      lease.revoke();
    }
  });
  it("deducts query, commit and transport elapsed time", async () => {
    const { lease } = fixture(sample(1000, 300));
    try {
      await vi.advanceTimersByTimeAsync(699);
      lease.assertActive();
      await vi.advanceTimersByTimeAsync(1);
      expect(() => lease.assertActive()).toThrow("OWNER_FENCED");
    } finally {
      lease.revoke();
    }
  });
  it("coalesces hung renewals and cannot resurrect after expiry", async () => {
    const { lease, effects } = fixture(sample(1000));
    let deliver!: (value: ReturnType<typeof sample>) => void;
    effects.heartbeatOwner.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const first = lease.heartbeat(60000),
      second = lease.heartbeat(60000);
    const outcomes = Promise.allSettled([first, second]);
    try {
      await Promise.resolve();
      expect(effects.heartbeatOwner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(lease.signal?.aborted).toBe(true);
      deliver(sample());
      expect((await outcomes).every((outcome) => outcome.status === "rejected")).toBe(true);
      expect(() => lease.assertActive()).toThrow("OWNER_FENCED");
    } finally {
      deliver?.(sample());
      await outcomes;
      lease.revoke();
    }
  });
  it("extends local authority only after a live acknowledged renewal", async () => {
    const { lease, effects } = fixture(sample(1000));
    try {
      await vi.advanceTimersByTimeAsync(500);
      effects.heartbeatOwner.mockResolvedValueOnce(sample(2000));
      await lease.heartbeat(2000);
      await vi.advanceTimersByTimeAsync(1499);
      lease.assertActive();
      await vi.advanceTimersByTimeAsync(501);
      expect(lease.signal?.aborted).toBe(true);
    } finally {
      lease.revoke();
    }
  });
  it("cannot accept admission delayed until after local expiry", async () => {
    const { lease, effects } = fixture(sample(1000));
    let admit!: () => void;
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    effects.assertOwner.mockImplementationOnce(async () => {
      await gate;
    });
    const pending = lease.checkpoint();
    const settled = pending.catch((error) => error);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      admit();
      expect(await settled).toMatchObject({ message: "SCRY_BROWSER_OWNER_FENCED" });
    } finally {
      admit();
      await settled;
      lease.revoke();
    }
  });
  it("cannot return a valid checkpoint after local expiry during its admission", async () => {
    const { lease, effects } = fixture(sample(1000));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    effects.assertOwner.mockImplementationOnce(async () => {
      await gate;
    });
    const pending = lease.checkpoint();
    const settled = pending.catch((error) => error);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      finish();
      expect(await settled).toMatchObject({ message: "SCRY_BROWSER_OWNER_FENCED" });
    } finally {
      finish();
      await settled;
      lease.revoke();
    }
  });
  it("emits one permanent revocation and never renews a revoked owner", async () => {
    const { lease, effects } = fixture();
    const aborted = vi.fn();
    lease.signal?.addEventListener("abort", aborted);
    lease.revoke();
    lease.revoke();
    await expect(lease.heartbeat(60000)).rejects.toThrow("OWNER_FENCED");
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(effects.heartbeatOwner).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { leaseRemainingMs: NaN, sampleStartedAt: 0 },
    { leaseRemainingMs: -1, sampleStartedAt: 0 },
    { leaseRemainingMs: 300001, sampleStartedAt: 0 },
    { leaseRemainingMs: 1.5, sampleStartedAt: 0 },
    { leaseRemainingMs: 1000, sampleStartedAt: Infinity },
    { leaseRemainingMs: 1000, sampleStartedAt: 1 },
  ])("fails closed for an invalid acknowledged sample %#", (invalid) => {
    const { lease } = fixture(invalid);
    try {
      expect(() => lease.assertActive()).toThrow("OWNER_FENCED");
    } finally {
      lease.revoke();
    }
  });
});
