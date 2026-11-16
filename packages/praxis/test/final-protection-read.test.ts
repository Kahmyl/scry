import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeCaptureSample, NativeImageEvidence } from "@scry/contracts";
import { readFinalCaptureProtection } from "../src/mcp-native/final-protection-read.mjs";
// @ts-expect-error Private native producer, shared by both recorder paths.
import { createCaptureProducer } from "../src/mcp-native/capture-producer.mjs";

const epoch = {
    captureId: "00000000-0000-4000-8000-000000000123",
    originalWriterGeneration: 1,
    assessmentPolicyVersion: 2 as const,
  },
  challenge = "00000000-0000-4000-8000-000000000456";
const available: NativeImageEvidence = {
  state: "available",
  assessment: "best_effort_known_candidates",
};
const recoverable: NativeImageEvidence = {
  state: "withheld",
  reason: "native_protection_refresh_incomplete",
  recovery: "read_only_once",
};
function fixture() {
  let current: NativeCaptureSample = {
    version: 1,
    readId: 5,
    policyGeneration: 1,
    text: "complete",
    image: available,
    knownRequirement: "present",
  };
  const tasks = new Set<Promise<unknown>>();
  const set = (change: Partial<NativeCaptureSample>) => (current = { ...current, ...change });
  const next = (nonce: string, image: NativeImageEvidence = available) =>
    set({ readId: current.readId + 1, finalReadChallenge: nonce, image });
  const read = vi.fn(async (nonce: string) => {
    next(nonce);
  });
  const assertActive = vi.fn();
  const controller = new AbortController();
  const options = {
    epoch,
    finalRead: { epoch, challenge },
    read,
    sample: () => current,
    pending: () => [...tasks],
    assertActive,
    signal: controller.signal,
  };
  return {
    options,
    read,
    set,
    next,
    tasks,
    controller,
    sample: () => current,
    replace: (value: NativeCaptureSample) => (current = value),
  };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("accepts an already available fresh final assessment without another read", async () => {
  const f = fixture();
  expect(await readFinalCaptureProtection(f.options)).toEqual({ retried: false });
  expect(f.read).toHaveBeenCalledExactlyOnceWith(challenge);
});

it("drains a late private paint reply then makes one new same-challenge read", async () => {
  const f = fixture();
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, recoverable);
    const pending = sleep(240).finally(() => f.tasks.delete(pending));
    f.tasks.add(pending);
    await sleep(200);
  });
  const work = readFinalCaptureProtection(f.options);
  await vi.advanceTimersByTimeAsync(240);
  expect(await work).toEqual({ retried: true });
  expect(f.read.mock.calls).toEqual([[challenge], [challenge]]);
  expect(f.sample()).toMatchObject({ readId: 7, finalReadChallenge: challenge, image: available });
});

it.each(["prior", "first", "drain"] as const)(
  "preserves a required gap observed during %s and does not retry it",
  async (when) => {
    const f = fixture();
    const gap = { observedRequiredGap: "native_protection_geometry_unsupported" as const };
    if (when === "prior") f.set(gap);
    f.read.mockImplementationOnce(async (nonce) => {
      f.next(nonce, recoverable);
      if (when === "first") f.set(gap);
      if (when === "drain") {
        const pending = sleep(50).then(() => {
          f.set(gap);
          f.tasks.delete(pending);
        });
        f.tasks.add(pending);
      }
    });
    const work = readFinalCaptureProtection(f.options);
    await vi.advanceTimersByTimeAsync(50);
    expect(await work).toEqual({ retried: false });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.sample().observedRequiredGap).toBe(gap.observedRequiredGap);
  },
);

it("does not reinterpret an unsupported image reason as recoverable", async () => {
  const f = fixture();
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, {
      state: "withheld",
      reason: "native_protection_geometry_unsupported",
      recovery: "read_only_once",
    } as unknown as NativeImageEvidence);
  });
  expect(await readFinalCaptureProtection(f.options)).toEqual({ retried: false });
  expect(f.read).toHaveBeenCalledOnce();
});

it("never launches a concurrent replacement for a permanently pending task", async () => {
  const f = fixture();
  f.tasks.add(new Promise(() => {}));
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, recoverable);
  });
  const work = readFinalCaptureProtection(f.options);
  await vi.advanceTimersByTimeAsync(200);
  expect(await work).toEqual({ retried: false });
  expect(f.read).toHaveBeenCalledOnce();
});

it.each(["first", "retry"])("bounds a never-returning %s read", async (which) => {
  const f = fixture();
  if (which === "retry")
    f.read.mockImplementationOnce(async (nonce) => {
      f.next(nonce, recoverable);
    });
  f.read.mockImplementationOnce(() => new Promise(() => {}));
  const failed = readFinalCaptureProtection(f.options).catch((e) => e);
  await vi.advanceTimersByTimeAsync(600);
  expect(await failed).toMatchObject({ message: "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED" });
  expect(f.read).toHaveBeenCalledTimes(which === "first" ? 1 : 2);
});

it("does not begin a read if its owner is already aborted", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(readFinalCaptureProtection(f.options)).rejects.toThrow(
    "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED",
  );
  expect(f.read).not.toHaveBeenCalled();
});

it("aborts during pending drain without starting a second read", async () => {
  const f = fixture();
  f.tasks.add(new Promise(() => {}));
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, recoverable);
  });
  const failed = readFinalCaptureProtection(f.options).catch((e) => e);
  await vi.advanceTimersByTimeAsync(1);
  f.controller.abort();
  expect(await failed).toMatchObject({ message: "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED" });
  expect(f.read).toHaveBeenCalledOnce();
});

it.each(["policy", "read", "challenge", "cleared-gap"])(
  "refuses an inconsistent %s final read",
  async (change) => {
    const f = fixture();
    if (change === "cleared-gap")
      f.set({ observedRequiredGap: "native_protection_refresh_incomplete" });
    f.read.mockImplementationOnce(async (nonce) => {
      if (change !== "read") f.next(nonce, recoverable);
      if (change === "policy") f.set({ policyGeneration: 2 });
      if (change === "challenge") f.set({ finalReadChallenge: epoch.captureId });
      if (change === "cleared-gap") {
        const { observedRequiredGap: _, ...rest } = f.sample();
        f.replace(rest);
      }
    });
    await expect(readFinalCaptureProtection(f.options)).rejects.toThrow(
      "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED",
    );
    expect(f.read).toHaveBeenCalledOnce();
  },
);

it("refuses a changed owner before a retry can begin", async () => {
  const f = fixture();
  let active = true;
  f.options.assertActive.mockImplementation(() => {
    if (!active) throw Error("OWNER_FENCED");
  });
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, recoverable);
    const task = sleep(50).then(() => {
      active = false;
      f.tasks.delete(task);
    });
    f.tasks.add(task);
  });
  const failed = readFinalCaptureProtection(f.options).catch((e) => e);
  await vi.advanceTimersByTimeAsync(50);
  expect(await failed).toMatchObject({ message: "OWNER_FENCED" });
  expect(f.read).toHaveBeenCalledOnce();
});

it("refuses an epoch mismatch before doing any read", async () => {
  const f = fixture();
  f.options.finalRead = {
    epoch: { ...epoch, originalWriterGeneration: 2 },
    challenge,
  };
  await expect(readFinalCaptureProtection(f.options)).rejects.toThrow(
    "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED",
  );
  expect(f.read).not.toHaveBeenCalled();
});

it("keeps the issued challenge even if the caller later mutates its receipt object", async () => {
  const f = fixture();
  const work = readFinalCaptureProtection(f.options);
  f.options.finalRead.challenge = epoch.captureId;
  expect(await work).toEqual({ retried: false });
  expect(f.read).toHaveBeenCalledExactlyOnceWith(challenge);
});

it("does not let an in-place policy mutation rewrite the initial fence", async () => {
  const f = fixture();
  const reused = f.sample() as { policyGeneration: number };
  f.read.mockImplementationOnce(async (nonce) => {
    reused.policyGeneration = 2;
    f.next(nonce, recoverable);
  });
  await expect(readFinalCaptureProtection(f.options)).rejects.toThrow(
    "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED",
  );
  expect(f.read).toHaveBeenCalledOnce();
});

it("does not let a late in-place read mutation rewrite the drain fence", async () => {
  const f = fixture();
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, recoverable);
    const reused = f.sample() as { readId: number };
    const task = sleep(50).then(() => {
      reused.readId++;
      f.tasks.delete(task);
    });
    f.tasks.add(task);
  });
  const failed = readFinalCaptureProtection(f.options).catch((e) => e);
  await vi.advanceTimersByTimeAsync(50);
  expect(await failed).toMatchObject({ message: "NATIVE_CAPTURE_FINAL_READ_UNCONFIRMED" });
  expect(f.read).toHaveBeenCalledOnce();
});

it("carries a gap arriving during retry in the actual producer's final sample", async () => {
  const f = fixture();
  const producer = createCaptureProducer({
    epoch,
    sample: f.sample,
    send: vi.fn(async () => {}),
  });
  expect(producer.sample()).toBe(true);
  f.read.mockImplementationOnce(async (nonce) => {
    f.next(nonce, recoverable);
  });
  f.read.mockImplementationOnce(async (nonce) => {
    // Producer sends are closed, so the protector's monotonic final fact is
    // essential for a gap emitted by a removed frame or late binding event.
    expect(producer.gap("native_protection_geometry_stale")).toBe(false);
    f.next(nonce);
    f.set({ observedRequiredGap: "native_protection_geometry_stale" });
  });
  const final = await producer.close({ epoch, challenge }, () =>
    readFinalCaptureProtection(f.options),
  );
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(final.finalSample).toMatchObject({
    finalReadChallenge: challenge,
    image: available,
    observedRequiredGap: "native_protection_geometry_stale",
  });
});
