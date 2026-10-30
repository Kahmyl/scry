import { describe, expect, it, vi } from "vitest";
import { SanitizedBrowserRecorder } from "../src/recorder.js";
import type { BrowserContext } from "playwright";
const fixture = () => {
  const recording = {
    directory: "/unused-fixture",
    maskingUnavailable: vi.fn(),
    admit: vi.fn(async () => undefined),
    receive: vi.fn(),
    recordError: vi.fn(),
    flush: vi.fn(async () => ({ receivedEvents: 0, errors: [], diagnostics: [] })),
    abort: vi.fn(async (): Promise<void> => undefined),
  };
  return {
    recording,
    recorder: new SanitizedBrowserRecorder({ native: recording, protectionScript: "" }),
  };
};
describe("capture detach and recording quiescence", () => {
  it("does not attach a context when source loading completes after abandonment", async () => {
    const { recorder } = fixture(),
      context = { on: vi.fn(), once: vi.fn(), pages: () => [] };
    const starting = recorder.start(context as unknown as BrowserContext);
    const outcome = starting.catch((error) => error);
    await recorder.abort();
    expect(await outcome).toMatchObject({ message: "SCRY_BROWSER_RECORDER_CLOSED" });
    expect(context.on).not.toHaveBeenCalled();
  });
  it("does not claim aborted capture is drained before Chronicle settles", async () => {
    const { recording, recorder } = fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    recording.abort.mockImplementationOnce(() => gate);
    let settled = false;
    const aborted = recorder.abort().then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(recording.abort).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      finish();
      await aborted;
    }
    expect(recording.flush).not.toHaveBeenCalled();
  });
  it("normally closes by detaching and flushing without abandoning evidence", async () => {
    const { recording, recorder } = fixture();
    await recorder.close();
    expect(recording.flush).toHaveBeenCalledTimes(1);
    expect(recording.abort).not.toHaveBeenCalled();
  });
  it("drains an already accepted popup attachment during normal close", async () => {
    const { recording, recorder } = fixture();
    let accept!: (page: unknown) => void, release!: (session: unknown) => void;
    const session = {
      send: vi.fn(async (method: string) =>
        method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "frame" } } }
          : method === "Page.createIsolatedWorld"
            ? { executionContextId: 1 }
            : { result: {} },
      ),
      detach: vi.fn(async () => undefined),
    };
    const cdp = new Promise((resolve) => {
      release = resolve;
    });
    const context = {
      on: vi.fn((_event: string, handler: (page: unknown) => void) => {
        accept = handler;
      }),
      off: vi.fn(),
      pages: () => [],
      newCDPSession: vi.fn(() => cdp),
    };
    const page = {
      context: () => context,
      isClosed: () => false,
      viewportSize: () => ({ width: 800, height: 600 }),
      screenshot: vi.fn(async () => undefined),
      screencast: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    };
    await recorder.start(context as unknown as BrowserContext);
    accept(page);
    let closed = false;
    const closing = recorder.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release(session);
    await closing;
    expect(page.screencast.start).toHaveBeenCalledOnce();
    expect(page.screencast.stop).toHaveBeenCalledOnce();
    expect(recording.admit).toHaveBeenCalledWith(expect.objectContaining({ kind: "video" }));
    expect(recording.recordError).not.toHaveBeenCalled();
  });
  it("retains failed-popup diagnostics without admitting a nonexistent video", async () => {
    const { recording, recorder } = fixture();
    let accept!: (page: unknown) => void, release!: (session: unknown) => void;
    const cdp = new Promise((resolve) => {
      release = resolve;
    });
    const context = {
      on: vi.fn((_event: string, handler: (page: unknown) => void) => {
        accept = handler;
      }),
      off: vi.fn(),
      pages: () => [],
      newCDPSession: vi.fn(() => cdp),
    };
    const page = {
      context: () => context,
      isClosed: () => true,
      viewportSize: () => ({ width: 800, height: 600 }),
      screencast: {
        start: vi.fn(async () => {
          throw new Error("Target page, context or browser has been closed");
        }),
        stop: vi.fn(async () => undefined),
      },
    };
    await recorder.start(context as unknown as BrowserContext);
    accept(page);
    const closing = recorder.close();
    release({ send: vi.fn(async () => ({ result: {} })), detach: vi.fn(async () => undefined) });
    await closing;
    expect(recording.recordError).toHaveBeenCalledWith("recorder_attach_failed", expect.any(Error));
    expect(recording.admit).not.toHaveBeenCalled();
  });
});
