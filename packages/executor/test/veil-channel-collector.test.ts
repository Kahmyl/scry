import { describe, expect, it } from "vitest";
import { VeilChannelCollector } from "../src/veil-channel-collector.js";

describe("VeilChannelCollector", () => {
  it("acknowledges only after the capture fence changes state", async () => {
    const collector = new VeilChannelCollector("network");
    expect(collector.isCaptureSuppressed()).toBe(false);
    await collector.arm("operation-1");
    expect(collector.state()).toMatchObject({ status: "prepared", operationId: "operation-1", revision: 1 });
    await collector.suspend();
    expect(collector.state()).toMatchObject({ status: "suspended", revision: 2 });
    await collector.isolate();
    expect(collector.state()).toMatchObject({ status: "isolated", revision: 3 });
    expect(collector.isCaptureSuppressed()).toBe(true);
    await collector.resume({ kind: "known_secret_registered", referenceType: "vault" });
    expect(collector.state()).toMatchObject({ status: "active", revision: 4 });
  });

  it("fails closed on invalid transitions and remains suppressed after sealing", async () => {
    const collector = new VeilChannelCollector("dom");
    await expect(collector.resume({ kind: "known_secret_registered", referenceType: "vault" })).rejects.toThrow("VEIL_COLLECTOR_NOT_ISOLATED");
    await collector.seal({ code: "VEIL_RUNTIME_LOST" });
    expect(collector.isCaptureSuppressed()).toBe(true);
  });
});
