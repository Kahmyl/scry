import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AdapterWorker, PraxisMcpBrowserEngine } from "../src/mcp-browser-engine.js";
import { PraxisOwnerLease } from "../src/owner-lease.js";

const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: mock.fork }));
class Child extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  respond: (message: any) => unknown = () => undefined;
  send = vi.fn((message: any, callback?: (error: Error | null) => void) => {
    callback?.(null);
    const data = this.respond(message);
    if (data !== undefined) this.emit("message", { id: message.id, ok: true, data });
    return true;
  });
  kill = vi.fn(() => {
    this.connected = false;
    this.signalCode = "SIGTERM";
    this.emit("exit", 0, "SIGTERM");
    return true;
  });
}
const epoch = {
  captureId: "00000000-0000-4000-8000-000000000701",
  originalWriterGeneration: 1,
  assessmentPolicyVersion: 2,
} as const;
const image = { state: "available", assessment: "best_effort_known_candidates" } as const;
const sample = (readId: number) => ({
  version: 1,
  readId,
  policyGeneration: 1,
  text: "complete",
  image,
  knownRequirement: "absent_in_supported_snapshot",
});
const assessed = { state: "best_effort_assessed", warning: "automatic_redaction_best_effort" };
const withheld = {
  state: "withheld",
  reason: "native_capture_final_assessment_missing",
  warning: "automatic_redaction_best_effort",
};
async function fixture() {
  const order: string[] = [];
  let closed = false;
  const capture = {
    epoch,
    directory: "/private/reservation",
    filename: "recording.mp4",
    graphSample: vi.fn(async (input: any) => {
      order.push("sample:" + input.sequence);
    }),
    graphGap: vi.fn(async () => {}),
    policyTransition: vi.fn(async () => {
      order.push("policy-transition");
    }),
    physicalStopped: vi.fn(async () => {
      order.push("physical-ack");
      return { epoch, challenge: "00000000-0000-4000-8000-000000000702" };
    }),
    graphClosed: vi.fn(async () => {
      closed = true;
      order.push("graph-close");
    }),
    seal: vi.fn(async () => {
      order.push("capture-seal");
      return closed
        ? {
            ...assessed,
            epoch,
            policy: { first: 1, last: 1, transitions: 0 },
            observedRequiredGap: false,
            latestSampledAssessment: image,
          }
        : {
            ...withheld,
            epoch,
            policy: { first: 1, last: 1, transitions: 0 },
            observedRequiredGap: false,
          };
    }),
  };
  const child = new Child();
  mock.fork.mockReturnValue(child);
  child.respond = (message) => {
    if (message.type === "init") return [{ name: "browser_take_screenshot" }];
    if (message.type === "close_capture_producer") {
      order.push("new-final-read");
      return { epoch, lastSequence: 2, finalSample: sample(2) };
    }
    if (message.type === "call")
      return {
        content: [{ type: "text", text: "Ordinary application view" }],
        observationAvailable: true,
      };
    return {};
  };
  const onLost = vi.fn();
  const worker = new AdapterWorker(
    "/private",
    "file:///private/unused.mjs",
    () => {},
    onLost,
    (event) =>
      event.type === "capture_sample"
        ? capture.graphSample({ sequence: event.sequence, sample: event.sample })
        : capture.graphGap(),
  );
  await worker.call({ type: "init" });
  const session = {
    recoverNativeCaptures: vi.fn(async () => ({
      admitted: closed ? 1 : 0,
      recordingAssessment: closed ? assessed : withheld,
    })),
    stopCapture: vi.fn(async () => {
      order.push("evidence-stop");
    }),
    seal: vi.fn(async () => ({
      state: closed ? "complete" : "incomplete",
      recordingAssessment: closed ? assessed : withheld,
    })),
  };
  const effects = {
    assertOwner: vi.fn(async () => {}),
    completeEvidence: vi.fn(async () => {}),
    retireOwner: vi.fn(async () => {
      order.push("owner-release");
    }),
  };
  const commands = {
    evidenceStatus: vi.fn(async () => ({ captureStopped: false })),
    protectedValuesForSession: vi.fn(async () => ({})),
  };
  const unconfirmed = vi.fn();
  const engine = new PraxisMcpBrowserEngine(
    commands as any,
    effects as any,
    {} as any,
    {} as any,
    "unused",
    { onUnconfirmedRuntime: unconfirmed },
  );
  const c = (engine as any).cell("capture-session");
  c.scope = { baseOrigin: "https://app.test", runId: "run" };
  c.lease = new PraxisOwnerLease(
    { sessionId: c.id, generation: 1, leaseToken: "private" },
    effects as any,
    { sampleStartedAt: performance.now(), leaseRemainingMs: 60000 },
  );
  c.opening = Promise.resolve();
  c.capture = capture;
  c.worker = worker;
  c.evidence = session;
  c.native = { directory: "/private", admitStill: vi.fn(async () => {}) };
  c.policyDigest = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
  c.custody = {
    synchronize: vi.fn(async () => {}),
    terminationState: "active",
    exitConfirmed: false,
    stopCapture: vi.fn(async () => {
      order.push("encoder-end");
      return { coverage: "complete", started: 1, ended: 2, timingOrigin: "native_capture" };
    }),
    close: vi.fn(async () => {
      order.push("browser-display-gone");
      return { exitConfirmed: true };
    }),
    terminate: vi.fn(async () => {
      order.push("browser-display-gone");
      return { exitConfirmed: true };
    }),
  };
  c.launch = Promise.resolve(c.custody);
  return {
    engine,
    c,
    capture,
    worker,
    child,
    order,
    session,
    effects,
    unconfirmed,
    onLost,
    commands,
  };
}
describe("capture owner finalization", () => {
  it("joins one retirement promise across repeated force requests and graceful escalation", async () => {
    const f = await fixture();
    let release!: (value: unknown) => void;
    const exit = new Promise((resolve) => {
      release = resolve;
    });
    f.c.custody.close.mockReturnValue(exit);
    f.c.custody.terminate.mockReturnValue(exit);
    const stopping = (f.engine as any).stop(f.c, false);
    await vi.waitFor(() => expect(f.c.custody.close).toHaveBeenCalledTimes(1));
    const forced = (f.engine as any).stop(f.c, true);
    expect(forced).toBe(stopping);
    expect((f.engine as any).stop(f.c, true)).toBe(stopping);
    await vi.waitFor(() => expect(f.c.custody.terminate).toHaveBeenCalledTimes(1));
    release({ exitConfirmed: true });
    await stopping;
    await (f.engine as any).stop(f.c, true);
    expect(f.c.custody.close).toHaveBeenCalledTimes(1);
    expect(f.c.custody.terminate).toHaveBeenCalledTimes(1);
    f.c.lease.revoke();
  });
  it("does not claim worker retirement when even the owned-handle kill has no exit confirmation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    f.child.kill.mockImplementation(() => true);
    const stopping = f.worker.stop();
    void stopping.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(5001);
      await expect(stopping).rejects.toThrow("ADAPTER_STOP_UNCONFIRMED");
    } finally {
      f.c.lease.revoke();
      f.child.connected = false;
      f.child.emit("exit");
      vi.useRealTimers();
    }
  });
  it("registers callback work before awaiting, then drains it before final sample/close/seal/release", async () => {
    const f = await fixture();
    let release!: () => void;
    f.capture.graphSample.mockImplementationOnce(async () => {
      f.order.push("prior-registered");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      f.order.push("prior-durable");
    });
    f.child.emit("message", { type: "capture_sample", epoch, sequence: 1, sample: sample(1) });
    expect(f.capture.graphSample).toHaveBeenCalledTimes(1);
    const closing = f.engine.execute(f.c.id, { kind: "close" });
    await vi.waitFor(() => expect(f.order).toContain("new-final-read"));
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(f.c.custody.close).not.toHaveBeenCalled();
    release();
    const result = await closing;
    expect(result.recordingAssessment).toEqual(assessed);
    expect(f.order.indexOf("encoder-end")).toBeLessThan(f.order.indexOf("physical-ack"));
    expect(f.order.indexOf("physical-ack")).toBeLessThan(f.order.indexOf("new-final-read"));
    expect(f.order.indexOf("prior-durable")).toBeLessThan(f.order.indexOf("sample:2"));
    expect(f.order.indexOf("capture-seal")).toBeLessThan(f.order.indexOf("browser-display-gone"));
    expect(f.order.indexOf("browser-display-gone")).toBeLessThan(f.order.indexOf("owner-release"));
    expect(f.onLost).not.toHaveBeenCalled();
  });
  it("withholds a failed callback while preserving confirmed resource release", async () => {
    const f = await fixture();
    f.capture.graphSample.mockRejectedValueOnce(undefined);
    f.child.emit("message", { type: "capture_sample", epoch, sequence: 1, sample: sample(1) });
    const result = await f.engine.execute(f.c.id, { kind: "close" });
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(result.recordingAssessment).toEqual(withheld);
    expect(f.effects.retireOwner).toHaveBeenCalledTimes(1);
    expect(f.unconfirmed).not.toHaveBeenCalled();
  });
  it("withholds an unavailable physical fact without inventing physical uncertainty", async () => {
    const f = await fixture();
    f.c.custody.stopCapture.mockResolvedValue({
      coverage: "unavailable",
      reason: "capture_final_unconfirmed",
    });
    const result = await f.engine.execute(f.c.id, { kind: "close" });
    expect(f.capture.physicalStopped).not.toHaveBeenCalled();
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(result.recordingAssessment).toEqual(withheld);
    expect(f.effects.retireOwner).toHaveBeenCalled();
    expect(f.unconfirmed).not.toHaveBeenCalled();
  });
  it("does not release the owner when a late resource acquisition remains unresolved", async () => {
    const f = await fixture();
    const uncertain = Object.assign(Error("RECORDER_RESOURCE_ACQUISITION_UNCONFIRMED"), {
      physicalRetirement: "unconfirmed",
      mayOwnResources: true,
    });
    f.c.custody.stopCapture.mockRejectedValue(uncertain);
    f.c.custody.close.mockRejectedValue(uncertain);
    await expect(f.engine.execute(f.c.id, { kind: "close" })).rejects.toMatchObject({
      mayOwnResources: true,
    });
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(f.effects.retireOwner).not.toHaveBeenCalled();
    expect(f.unconfirmed).toHaveBeenCalled();
    f.c.lease.revoke();
  });
  it("does not mistake an undefined cleanup rejection for a successful physical stop", async () => {
    const f = await fixture();
    f.c.custody.close.mockRejectedValue(undefined);
    await expect(f.engine.execute(f.c.id, { kind: "close" })).rejects.toMatchObject({
      mayOwnResources: true,
    });
    expect(f.effects.retireOwner).not.toHaveBeenCalled();
    expect(f.unconfirmed).toHaveBeenCalled();
    f.c.lease.revoke();
  });
  it("does not invent a final sample during forced retirement", async () => {
    const f = await fixture();
    const custody = f.c.custody;
    await (f.engine as any).stop(f.c, true);
    expect(custody.stopCapture).not.toHaveBeenCalled();
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(f.order).not.toContain("new-final-read");
    expect(f.c.recordingAssessment).toEqual(withheld);
    f.c.lease.revoke();
  });
  it("does not accept a final reply for another capture epoch", async () => {
    const f = await fixture();
    const respond = f.child.respond;
    f.child.respond = (m) =>
      m.type === "close_capture_producer"
        ? {
            epoch: { ...epoch, originalWriterGeneration: 2 },
            lastSequence: 2,
            finalSample: sample(2),
          }
        : respond(m);
    const result = await f.engine.execute(f.c.id, { kind: "close" });
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(result.recordingAssessment).toEqual(withheld);
  });
  it.each([true, false])(
    "keeps constructor cleanup confidence after no custody handle was returned (confirmed=%s)",
    async (confirmed) => {
      const f = await fixture();
      delete f.c.custody;
      f.c.launch = Promise.reject(
        Object.assign(Error("constructor failed"), {
          physicalRetirement: confirmed ? "confirmed" : "unconfirmed",
          mayOwnResources: !confirmed,
        }),
      );
      if (confirmed) {
        await expect(f.engine.execute(f.c.id, { kind: "close" })).resolves.toMatchObject({
          closed: true,
        });
        expect(f.effects.retireOwner).toHaveBeenCalled();
        expect(f.unconfirmed).not.toHaveBeenCalled();
      } else {
        await expect(f.engine.execute(f.c.id, { kind: "close" })).rejects.toMatchObject({
          mayOwnResources: true,
        });
        expect(f.effects.retireOwner).not.toHaveBeenCalled();
        expect(f.unconfirmed).toHaveBeenCalled();
        f.c.lease.revoke();
      }
    },
  );
  it("advertises real registered image inspection only after the lane and checkpoints settle", async () => {
    const f = await fixture();
    const checkpoints: any[] = [];
    const result = await f.engine.execute(
      f.c.id,
      { kind: "browser_tool", tool: "browser_snapshot", args: {} },
      {
        remainingMs: 60000,
        persistAction: async (value) => {
          expect(f.c.lane.available).toBe(false);
          checkpoints.push(value);
        },
      },
    );
    expect(checkpoints.every((c) => c.readOnlyImageInspectionSupported === false)).toBe(true);
    expect(result.readOnlyImageInspectionSupported).toBe(true);
    expect(f.c.lane.available).toBe(true);
    f.c.lease.revoke();
    await f.worker.stop();
  });
  it("does not infer an image capability from the tool catalog after lease revocation", async () => {
    const f = await fixture();
    const result = await f.engine.execute(
      f.c.id,
      { kind: "browser_tool", tool: "browser_snapshot", args: {} },
      {
        remainingMs: 60000,
        persistAction: async (value) => {
          if (value.execution === "completed") f.c.lease.revoke();
        },
      },
    );
    expect(result.readOnlyImageInspectionSupported).toBe(false);
    await f.worker.stop();
  });
  it("orders prior callbacks, authenticated policy transition, and worker policy acknowledgment", async () => {
    const f = await fixture();
    f.commands.protectedValuesForSession.mockResolvedValue({
      fixture: "fictional-policy-value",
    } as any);
    f.capture.graphGap.mockImplementation(async () => {
      f.order.push("prior-policy-gap");
    });
    const respond = f.child.respond;
    f.child.respond = (message) => {
      if (message.type === "policy") {
        f.child.emit("message", {
          type: "capture_gap",
          epoch,
          sequence: 1,
          reason: "native_protection_refresh_incomplete",
        });
        return { policyGeneration: 2, policyAckRequired: true };
      }
      if (message.type === "policy_ack") {
        f.order.push("policy-ack");
        return {};
      }
      if (message.type === "call") {
        expect(f.order).toContain("policy-ack");
      }
      return respond(message);
    };
    await f.engine.execute(f.c.id, { kind: "browser_tool", tool: "browser_snapshot", args: {} });
    expect(f.capture.policyTransition).toHaveBeenCalledWith({ from: 1, to: 2, acknowledged: true });
    expect(f.order.indexOf("prior-policy-gap")).toBeLessThan(f.order.indexOf("policy-transition"));
    expect(f.order.indexOf("policy-transition")).toBeLessThan(f.order.indexOf("policy-ack"));
    expect(f.c.capturePolicyGeneration).toBe(2);
    f.c.lease.revoke();
    await f.worker.stop();
  });
  it("withholds capture and cleans up when worker policy acknowledgment fails", async () => {
    const f = await fixture();
    f.commands.protectedValuesForSession.mockResolvedValue({
      fixture: "fictional-policy-value",
    } as any);
    const respond = f.child.respond;
    f.child.respond = (message) => {
      if (message.type === "policy") return { policyGeneration: 2, policyAckRequired: true };
      if (message.type === "policy_ack") throw Error("policy acknowledgment lost");
      return respond(message);
    };
    await expect(
      f.engine.execute(f.c.id, { kind: "browser_tool", tool: "browser_snapshot", args: {} }),
    ).rejects.toThrow("policy acknowledgment lost");
    expect(f.capture.graphClosed).not.toHaveBeenCalled();
    expect(f.c.recordingAssessment).toEqual(withheld);
    expect(f.c.retired).toBe(true);
    expect(f.unconfirmed).not.toHaveBeenCalled();
    f.c.lease.revoke();
  });
  it.each([true, false])(
    "admits a still only with an available finite image fact (available=%s)",
    async (available) => {
      const f = await fixture();
      const directory = await mkdtemp(path.join(tmpdir(), "capture-still-"));
      f.c.native.directory = directory;
      const respond = f.child.respond;
      f.child.respond = (message) =>
        message.type === "call"
          ? {
              content: [
                {
                  type: "image",
                  data: Buffer.from("public fixture bytes").toString("base64"),
                  mimeType: "image/png",
                },
              ],
              imageEvidence: available
                ? image
                : {
                    state: "withheld",
                    reason: "native_protection_geometry_unsupported",
                    recovery: "preserve_gap",
                  },
            }
          : respond(message);
      try {
        const result = await f.engine.execute(f.c.id, {
          kind: "browser_tool",
          tool: "browser_take_screenshot",
          args: {},
        });
        if (available) {
          expect(f.c.native.admitStill).toHaveBeenCalledWith(
            expect.objectContaining({ imageEvidence: image }),
          );
          expect(result.media).toHaveLength(1);
        } else {
          expect(f.c.native.admitStill).not.toHaveBeenCalled();
          expect(result.media).toBeUndefined();
          expect(result.imageEvidence).toMatchObject({ state: "withheld" });
        }
      } finally {
        f.c.lease.revoke();
        await f.worker.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("withholds an image carrier with unrecognized extra fields", async () => {
    const f = await fixture();
    const respond = f.child.respond;
    f.child.respond = (message) =>
      message.type === "call"
        ? {
            content: [{ type: "image", data: "cHVibGlj", mimeType: "image/png" }],
            imageEvidence: { ...image, unrecognized: "extra" },
          }
        : respond(message);
    const result = await f.engine.execute(f.c.id, {
      kind: "browser_tool",
      tool: "browser_take_screenshot",
      args: {},
    });
    expect(f.c.native.admitStill).not.toHaveBeenCalled();
    expect(result.imageEvidence).toMatchObject({
      state: "withheld",
      reason: "native_protection_attestation_invalid",
    });
    f.c.lease.revoke();
    await f.worker.stop();
  });
});
