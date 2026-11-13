import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { createNativeAdapterProtector } from "../../veil/src/native-adapter-protection.js";
// @ts-expect-error Private worker JavaScript module.
import { installCaptureBinding } from "../src/mcp-native/capture-binding.mjs";
// @ts-expect-error Private worker JavaScript module.
import { createCaptureProducer } from "../src/mcp-native/capture-producer.mjs";
const epoch = {
    captureId: "00000000-0000-4000-8000-000000000123",
    originalWriterGeneration: 1,
    assessmentPolicyVersion: 2 as const,
  },
  challenge = "00000000-0000-4000-8000-000000000456";
const fact = (read: number, final = false) => ({
  version: 1,
  readId: read,
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
describe("private capture binding lifecycle", () => {
  it("registers a navigation-time gap before closure drains and preserves it after context destruction", async () => {
    const hold = gate(),
      session = new EventEmitter() as EventEmitter & { send: () => Promise<void> };
    session.send = async () => {};
    const protection = createNativeAdapterProtector({}, { captureEpoch: epoch }),
      events: any[] = [];
    let current = fact(1);
    const producer = createCaptureProducer({
      epoch,
      sample: () => ({
        ...current,
        ...(events.length ? { observedRequiredGap: "native_protection_geometry_unsupported" } : {}),
      }),
      send: (event: any) => {
        events.push(event);
        return hold.promise;
      },
    });
    await installCaptureBinding(session, protection, (reason: string) => producer.gap(reason));
    session.emit("Runtime.bindingCalled", {
      name: "__scryNativeGap",
      payload: JSON.stringify({
        version: 1,
        epoch,
        policyGeneration: 1,
        reason: "native_protection_geometry_unsupported",
      }),
    });
    expect(events).toHaveLength(1);
    session.emit("Runtime.executionContextDestroyed", { executionContextId: 7 });
    let measured = false;
    const closed = producer.close({ epoch, challenge }, async () => {
      measured = true;
      current = fact(2, true);
    });
    await Promise.resolve();
    expect(measured).toBe(false);
    hold.resolve();
    const result = await closed;
    expect(result.lastSequence).toBe(2);
    expect(result.finalSample.observedRequiredGap).toBe("native_protection_geometry_unsupported");
    expect(events[0].sequence).toBe(1);
    protection.dispose();
  });
  it("never treats another world binding or another capture epoch as an accepted fact", async () => {
    const session = new EventEmitter() as EventEmitter & { send: () => Promise<void> };
    session.send = async () => {};
    const protection = createNativeAdapterProtector({}, { captureEpoch: epoch }),
      received: string[] = [];
    const dispose = await installCaptureBinding(session, protection, (reason: string) =>
      received.push(reason),
    );
    session.emit("Runtime.bindingCalled", { name: "other", payload: "fictional-private-marker" });
    session.emit("Runtime.bindingCalled", {
      name: "__scryNativeGap",
      payload: JSON.stringify({
        version: 1,
        epoch: { ...epoch, captureId: "00000000-0000-4000-8000-000000000999" },
        policyGeneration: 1,
        reason: "native_protection_geometry_unsupported",
      }),
    });
    expect(received).toEqual([]);
    dispose();
    expect(session.listenerCount("Runtime.bindingCalled")).toBe(0);
    protection.dispose();
  });
  it("adds only the named isolated-world binding and registers its callback before setup awaits", async () => {
    const hold = gate(),
      session = new EventEmitter() as EventEmitter & {
        send: (name: string, params: unknown) => Promise<void>;
      },
      calls: any[] = [];
    session.send = (name, params) => {
      calls.push([name, params]);
      return name === "Runtime.enable" ? hold.promise : Promise.resolve();
    };
    const pending = installCaptureBinding(
      session,
      {
        acceptGap() {},
        drainGaps() {
          return [];
        },
      },
      () => {},
    );
    expect(session.listenerCount("Runtime.bindingCalled")).toBe(1);
    hold.resolve();
    await pending;
    expect(calls[1]).toEqual([
      "Runtime.addBinding",
      { name: "__scryNativeGap", executionContextName: "scry-native-protection" },
    ]);
  });
});
