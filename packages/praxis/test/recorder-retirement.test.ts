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
});
