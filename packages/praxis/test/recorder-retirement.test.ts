import { describe, it, expect, vi } from "vitest";
import { SanitizedBrowserRecorder } from "../src/recorder.js";
import { createNativeAdapterProtector } from "../../veil/src/native-adapter-protection.js";
import type { NativeCapturePort, NativeCaptureAssessment } from "@scry/contracts";
import type { BrowserContext } from "playwright";
const epoch = {
    captureId: "00000000-0000-4000-8000-000000000123",
    originalWriterGeneration: 1,
    assessmentPolicyVersion: 2 as const,
  },
  challenge = "00000000-0000-4000-8000-000000000456";
function sessionFixture(unsafe = false) {
  let nonce: string | undefined;
  return {
    on: vi.fn(),
    off: vi.fn(),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method !== "Runtime.evaluate") return {};
      const expression = String(params.expression),
        id = Number(/\.(?:read|paint)\((\d+)/.exec(expression)?.[1]);
      if (expression.includes(".read("))
        nonce = expression.includes(challenge) ? challenge : undefined;
      return {
        result: {
          value: {
            version: 1,
            readId: id,
            policyGeneration: 1,
            ...(nonce ? { finalReadChallenge: nonce } : {}),
            text: "complete",
            image: unsafe
              ? {
                  state: "withheld",
                  reason: "native_protection_geometry_unsupported",
                  recovery: "preserve_gap",
                }
              : { state: "available", assessment: "best_effort_known_candidates" },
            knownRequirement: unsafe ? "present" : "absent_in_supported_snapshot",
            values: [],
            coveredBoundIndices: [],
            textCandidateScope: { readId: id, policyGeneration: 1 },
            textCandidateRefs: [],
            imageCandidateRefs: [],
            count: {
              roots: 1,
              nodes: 1,
              textNodes: 0,
              controls: 0,
              presentations: 0,
              pseudoReads: 0,
              rectangles: 0,
            },
          },
        },
      };
    }),
  };
}
function fixture() {
  let physical = false;
  const capture = {
    epoch,
    directory: "/unused-fixture/capture",
    filename: "recording.webm" as const,
    graphSample: vi.fn<NativeCapturePort["graphSample"]>(async () => {}),
    graphGap: vi.fn(async () => {}),
    physicalStopped: vi.fn(async () => {
      physical = true;
      return { epoch, challenge };
    }),
    graphClosed: vi.fn(async () => {}),
    policyTransition: vi.fn(async () => {}),
    seal: vi.fn(async (): Promise<Exclude<NativeCaptureAssessment, { state: "pending" }>> =>
      physical
        ? {
            state: "best_effort_assessed",
            epoch,
            policy: { first: 1, last: 1, transitions: 0 },
            observedRequiredGap: false,
            latestSampledAssessment: {
              state: "available",
              assessment: "best_effort_known_candidates",
            },
            warning: "automatic_redaction_best_effort",
          }
        : {
            state: "withheld",
            epoch,
            policy: { first: 1, last: 1, transitions: 0 },
            observedRequiredGap: false,
            reason: "native_capture_physical_receipt_missing",
          },
    ),
  };
  const recording = {
    directory: "/unused-fixture",
    maskingUnavailable: vi.fn(),
    reserveCaptureV2: vi.fn(async () => capture),
    admitStill: vi.fn(async () => {}),
    recordError: vi.fn(),
    flush: vi.fn(async () => ({ receivedEvents: 0, errors: [], diagnostics: [] })),
    abort: vi.fn(async () => {}),
  };
  const recoverCaptures = vi.fn(async () => ({ admitted: physical ? 1 : 0 }));
  return {
    capture,
    recording,
    recoverCaptures,
    recorder: new SanitizedBrowserRecorder({
      native: recording,
      protection: createNativeAdapterProtector({}),
      recoverCaptures,
    }),
  };
}
function pageFixture(context: any) {
  return {
    on: vi.fn(),
    context: () => context,
    isClosed: () => false,
    viewportSize: () => ({ width: 800, height: 600 }),
    screenshot: vi.fn(async () => {}),
    screencast: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  };
}
describe("capture detach and recording quiescence", () => {
  it("does not attach a context after abandonment wins initial setup", async () => {
    const { recorder } = fixture(),
      context = { on: vi.fn(), pages: () => [] };
    const starting = recorder.start(context as unknown as BrowserContext).catch((e) => e);
    await recorder.abort();
    expect(await starting).toMatchObject({ message: "SCRY_BROWSER_RECORDER_CLOSED" });
    expect(context.on).not.toHaveBeenCalled();
  });
  it("does not acknowledge abort before Chronicle settles and never flushes new evidence", async () => {
    const { recording, recorder } = fixture();
    let finish!: () => void;
    recording.abort.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    let settled = false;
    const work = recorder.abort().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(recording.abort).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish();
    await work;
    expect(recording.flush).not.toHaveBeenCalled();
  });
  it("normally closes and recovers sealed captures without abandoning evidence", async () => {
    const { recording, recorder, recoverCaptures } = fixture();
    await recorder.close();
    expect(recoverCaptures).toHaveBeenCalledOnce();
    expect(recording.flush).toHaveBeenCalledOnce();
    expect(recording.abort).not.toHaveBeenCalled();
  });
  it("drains accepted popup setup and finalizes physical capture before fresh graph close", async () => {
    const { recorder, recording, capture, recoverCaptures } = fixture();
    let accept!: (page: unknown) => void, release!: (session: unknown) => void;
    const cdp = new Promise((r) => {
        release = r;
      }),
      context = {
        on: vi.fn((_e: string, handler: (p: unknown) => void) => {
          accept = handler;
        }),
        off: vi.fn(),
        pages: () => [],
        newCDPSession: vi.fn(() => cdp),
      },
      page = pageFixture(context),
      session = sessionFixture();
    await recorder.start(context as unknown as BrowserContext);
    accept(page);
    let done = false;
    const closing = recorder.close().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release(session);
    await closing;
    expect(page.screencast.start).toHaveBeenCalledOnce();
    expect(page.screencast.stop).toHaveBeenCalledOnce();
    expect(capture.physicalStopped).toHaveBeenCalledOnce();
    expect(capture.graphClosed).toHaveBeenCalledOnce();
    expect(capture.seal).toHaveBeenCalledOnce();
    expect(capture.graphSample.mock.calls.at(-1)?.[0]).toMatchObject({
      sample: { finalReadChallenge: challenge },
    });
    expect(page.screencast.stop.mock.invocationCallOrder[0]).toBeLessThan(
      capture.physicalStopped.mock.invocationCallOrder[0]!,
    );
    expect(capture.physicalStopped.mock.invocationCallOrder[0]).toBeLessThan(
      capture.graphClosed.mock.invocationCallOrder[0]!,
    );
    expect(recoverCaptures).toHaveBeenCalledOnce();
    expect(recording.recordError).not.toHaveBeenCalled();
    expect(session.detach).toHaveBeenCalledOnce();
  });
  it("retains failed-popup diagnostics and seals a gap instead of inventing physical video", async () => {
    const { recorder, recording, capture } = fixture();
    let accept!: (page: unknown) => void;
    const context = {
        on: vi.fn((_e: string, handler: (p: unknown) => void) => {
          accept = handler;
        }),
        off: vi.fn(),
        pages: () => [],
        newCDPSession: async () => sessionFixture(),
      },
      page = { ...pageFixture(context), isClosed: () => true };
    page.screencast.start.mockRejectedValueOnce(
      Error("Target page, context or browser has been closed"),
    );
    await recorder.start(context as unknown as BrowserContext);
    accept(page);
    await recorder.close();
    expect(recording.recordError).toHaveBeenCalledWith("recorder_attach_failed", expect.any(Error));
    expect(capture.physicalStopped).not.toHaveBeenCalled();
    expect(capture.graphClosed).not.toHaveBeenCalled();
    expect(capture.seal).toHaveBeenCalledOnce();
    expect(recording.admitStill).not.toHaveBeenCalled();
  });
  it("withholds known unsafe screenshots while preserving cleanup and capture terminalization", async () => {
    const { recorder, recording, capture } = fixture(),
      session = sessionFixture(true),
      context: any = {
        on: vi.fn(),
        off: vi.fn(),
        pages: () => [page],
        newCDPSession: async () => session,
      },
      page = pageFixture(context);
    await recorder.start(context);
    await recorder.checkpoint();
    expect(recording.maskingUnavailable).toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(recording.admitStill).not.toHaveBeenCalled();
    expect(capture.graphSample).toHaveBeenCalledWith(
      expect.objectContaining({
        sample: expect.objectContaining({ image: expect.objectContaining({ state: "withheld" }) }),
      }),
    );
    await recorder.abort();
    expect(session.detach).toHaveBeenCalledOnce();
  });
});
