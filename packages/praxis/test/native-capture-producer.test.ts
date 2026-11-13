import { describe, it, expect } from "vitest";
// @ts-expect-error Private JavaScript worker transport.
import { createCaptureProducer } from "../src/mcp-native/capture-producer.mjs";
const epoch = {
  captureId: "00000000-0000-4000-8000-000000000123",
  originalWriterGeneration: 1,
  assessmentPolicyVersion: 2,
};
const challenge = "00000000-0000-4000-8000-000000000456";
const fact = (id: number, final = false) => ({
  version: 1,
  readId: id,
  policyGeneration: 1,
  text: "complete",
  knownRequirement: "present",
  image: { state: "available", assessment: "best_effort_known_candidates" },
  ...(final ? { finalReadChallenge: challenge } : {}),
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("native capture worker producer", () => {
  it("drains accepted sends before final measurement and reserves a reply-only final sequence", async () => {
    const hold = gate(),
      events: any[] = [];
    let current = fact(1),
      measured = false;
    const p = createCaptureProducer({
      epoch,
      sample: () => current,
      send: (event: any) => {
        events.push(event);
        return hold.promise;
      },
    });
    expect(p.sample()).toBe(true);
    const close = p.close({ epoch, challenge }, async () => {
      measured = true;
      current = fact(2, true);
    });
    expect(p.gap("native_protection_geometry_unsupported")).toBe(false);
    await Promise.resolve();
    expect(measured).toBe(false);
    hold.resolve();
    const result = await close;
    expect(measured).toBe(true);
    expect(events).toHaveLength(1);
    expect(result.lastSequence).toBe(2);
    expect(result.finalSample.readId).toBe(2);
  });
  it("keeps policy-paused gaps ordered while suppressing only samples", async () => {
    const events: any[] = [];
    let current = fact(1);
    const p = createCaptureProducer({
      epoch,
      sample: () => current,
      send: async (e: any) => {
        events.push(e);
      },
    });
    p.pauseSamples();
    expect(p.sample()).toBe(false);
    expect(p.gap("native_protection_geometry_unsupported")).toBe(true);
    p.resumeSamples();
    expect(p.sample()).toBe(true);
    const result = await p.close({ epoch, challenge }, async () => {
      current = fact(2, true);
    });
    expect(events.map((e) => [e.type, e.sequence])).toEqual([
      ["capture_gap", 1],
      ["capture_sample", 2],
    ]);
    expect(result.lastSequence).toBe(3);
  });
  it("fences late final work after abandonment", async () => {
    const hold = gate();
    let current = fact(1);
    const p = createCaptureProducer({ epoch, sample: () => current, send: async () => {} });
    const closing = p.close({ epoch, challenge }, async () => {
      await hold.promise;
      current = fact(2, true);
    });
    await Promise.resolve();
    p.abandon();
    hold.resolve();
    await expect(closing).rejects.toThrow("NATIVE_CAPTURE_PRODUCER_UNCONFIRMED");
  });
  it("rebuilds the finite message and never sends private graph siblings", async () => {
    const events: any[] = [];
    const current = {
      ...fact(1),
      values: ["fictional-private-marker"],
      coveredBoundIndices: [0],
      image: { ...fact(1).image, private: "fictional-private-marker" },
    };
    const p = createCaptureProducer({
      epoch,
      sample: () => current,
      send: async (e: any) => {
        events.push(e);
      },
    });
    expect(p.sample()).toBe(true);
    await Promise.resolve();
    expect(JSON.stringify(events)).not.toContain("fictional-private-marker");
    expect(Object.keys(events[0].sample)).not.toContain("values");
  });
  it("does not certify a final receipt after an accepted send fails", async () => {
    let current = fact(1);
    const p = createCaptureProducer({
      epoch,
      sample: () => current,
      send: async () => {
        throw Error("raw transport detail");
      },
    });
    p.sample();
    await expect(
      p.close({ epoch, challenge }, async () => {
        current = fact(2, true);
      }),
    ).rejects.toThrow("NATIVE_CAPTURE_PRODUCER_UNCONFIRMED");
  });
});
