import { describe, expect, it } from "vitest";
import {
  createOwnedRetirement,
  createStartupEvidence,
  createStartupHelperBudget,
  createAcquisitionEvidence,
} from "../src/mcp-native/owned-retirement.mjs";

const immediate = async (test) => test();
describe("native recording physical ownership", () => {
  it("does not turn a successful send callback into permission to spawn when intent acknowledgment is lost", () => {
    const acquisitions = createAcquisitionEvidence();
    let spawned = false;
    acquisitions.intent(1);
    // Transport send/flushed callback succeeded, but the recorder got no ACK.
    const acknowledgmentDelivered = false;
    if (acknowledgmentDelivered) spawned = true;
    expect(spawned).toBe(false);
    expect(acquisitions.confirmed()).toBe(false);
    acquisitions.closed(1); // Positive no-spawn acknowledgment after the await failed.
    expect(acquisitions.confirmed()).toBe(true);
  });
  it("retains a lost/null registration after startup proof until original-handle exit proof", async () => {
    const acquisitions = createAcquisitionEvidence();
    acquisitions.intent(1);
    acquisitions.registered(1, null);
    const retire = createOwnedRetirement({
      stopOwnedChild: async () => {},
      childEnded: () => true,
      resourcesAbsent: () => true,
      startupConfirmed: () => true,
      acquisitionsConfirmed: acquisitions.confirmed,
      waitUntil: immediate,
    });
    await expect(retire()).rejects.toMatchObject({
      code: "RECORDER_RESOURCE_ACQUISITION_UNCONFIRMED",
      mayOwnResources: true,
    });
    acquisitions.closed(1);
    expect(acquisitions.confirmed()).toBe(true);
    await expect(retire()).rejects.toMatchObject({ mayOwnResources: true });
  });
  it("counts a registered stopped pre-arm utility as an owned resource even with no live encoder/display", async () => {
    const acquisitions = createAcquisitionEvidence();
    acquisitions.intent(1);
    acquisitions.registered(1, { pid: 10, startTicks: "1" });
    const retire = createOwnedRetirement({
      stopOwnedChild: async () => {},
      childEnded: () => true,
      resourcesAbsent: () => false,
      startupConfirmed: () => true,
      acquisitionsConfirmed: acquisitions.confirmed,
      waitUntil: immediate,
    });
    await expect(retire()).rejects.toMatchObject({
      code: "RECORDER_RESOURCES_UNCONFIRMED",
      mayOwnResources: true,
    });
  });
  it("handles fast exit/no spawn and a normal late ffprobe through positive evidence", async () => {
    const acquisitions = createAcquisitionEvidence();
    acquisitions.intent(1);
    acquisitions.closed(1);
    acquisitions.intent(2);
    acquisitions.registered(2, { pid: 11, startTicks: "2" });
    acquisitions.closed(2);
    const retire = createOwnedRetirement({
      stopOwnedChild: async () => {},
      childEnded: () => true,
      resourcesAbsent: () => true,
      startupConfirmed: () => true,
      acquisitionsConfirmed: acquisitions.confirmed,
      waitUntil: immediate,
    });
    await expect(retire()).resolves.toBeUndefined();
  });
  it.each(["pending", "history"])("fails closed at the bounded acquisition %s limit", (mode) => {
    const evidence = createAcquisitionEvidence({
      maxPending: 1,
      maxHistory: mode === "history" ? 1 : 2,
    });
    evidence.intent(1);
    if (mode === "history") evidence.closed(1);
    expect(() => evidence.intent(2)).toThrow("RECORDER_RESOURCE_ACQUISITION_UNCONFIRMED");
    expect(evidence.confirmed()).toBe(false);
  });
  it.each([null, undefined, "primitive", new Error("stop failure")])(
    "preserves uncertain custody after arbitrary rejection %#",
    async (cause) => {
      const retire = createOwnedRetirement({
        stopOwnedChild: async () => {
          throw cause;
        },
        childEnded: () => true,
        resourcesAbsent: () => true,
        waitUntil: immediate,
      });
      await expect(retire()).rejects.toMatchObject({
        code: "RECORDER_RETIREMENT_UNCONFIRMED",
        physicalRetirement: "unconfirmed",
        mayOwnResources: true,
        cause,
      });
    },
  );
  it("permanently joins retirement instead of resignal after a reused identifier", async () => {
    let calls = 0;
    const retire = createOwnedRetirement({
      stopOwnedChild: async () => {
        calls++;
      },
      childEnded: () => true,
      resourcesAbsent: () => true,
      waitUntil: immediate,
    });
    const first = retire();
    expect(retire()).toBe(first);
    await first;
    await retire();
    expect(calls).toBe(1);
  });
  it("requires positive setup proof even when exit precedes intent IPC delivery", async () => {
    const evidence = createStartupEvidence();
    const retire = createOwnedRetirement({
      stopOwnedChild: async () => {},
      childEnded: () => true,
      resourcesAbsent: () => true,
      startupConfirmed: evidence.confirmed,
      waitUntil: immediate,
    });
    await expect(retire()).rejects.toMatchObject({
      physicalRetirement: "unconfirmed",
      mayOwnResources: true,
    });
    evidence.accept("capture_starting");
    expect(evidence.confirmed()).toBe(false);
    evidence.accept("startup_drained");
    expect(evidence.confirmed()).toBe(true);
    // Evidence arriving later cannot reopen this instance's failed retirement.
    await expect(retire()).rejects.toMatchObject({ mayOwnResources: true });
  });
  it.each(["width", "history", "bytes"])(
    "fails closed without truncating the startup %s budget",
    (mode) => {
      const budget = createStartupHelperBudget({
        maxCount: 2,
        maxBytes: mode === "bytes" ? 8 : 1000,
      });
      const exceed = () => {
        if (mode === "width") budget.children("1 2 3");
        else if (mode === "bytes") budget.children("1 2 3 4 5");
        else for (const pid of [1, 2, 3]) budget.register({ pid, startTicks: "1" });
      };
      expect(exceed).toThrow("RECORDER_STARTUP_HELPER_CAPACITY");
      expect(() => budget.children("")).toThrow("RECORDER_STARTUP_HELPER_CAPACITY");
      try {
        budget.children("");
      } catch (error) {
        expect(error).toMatchObject({ physicalRetirement: "unconfirmed", mayOwnResources: true });
      }
    },
  );
});
