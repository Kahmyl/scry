import { describe, expect, it, vi } from "vitest";
import { VeilClipboardCollector, VeilClipboardCleanupError } from "../src/clipboard-collector.js";

describe("VeilClipboardCollector", () => {
  it("retries destruction and only finalizes after verified empty clipboard", async () => {
    let calls = 0;
    const clearAndVerify = vi.fn(async () => {
        calls += 1;
        if (calls < 2) throw new Error("transient");
      });
    const collector = new VeilClipboardCollector(clearAndVerify, 3);
    collector.markProtectedClipboardTouched();
    await collector.finalize();
    expect(clearAndVerify).toHaveBeenCalledTimes(2);
    expect(collector.state().status).toBe("finalized");
  });

  it("refuses finalization when protected clipboard destruction cannot be verified", async () => {
    const clearAndVerify = vi.fn(async () => {
        throw new Error("denied");
      });
    const collector = new VeilClipboardCollector(clearAndVerify, 2);
    collector.markProtectedClipboardTouched();
    await expect(collector.finalize()).rejects.toBeInstanceOf(VeilClipboardCleanupError);
    expect(clearAndVerify).toHaveBeenCalledTimes(2);
    expect(collector.state().status).not.toBe("finalized");
  });

  it("bounds each cleanup attempt when page evaluation never settles", async () => {
    const clearAndVerify = vi.fn(() => new Promise<void>(() => undefined));
    const collector = new VeilClipboardCollector(clearAndVerify, 2, 5);
    collector.markProtectedClipboardTouched();
    await expect(collector.finalize()).rejects.toBeInstanceOf(VeilClipboardCleanupError);
    expect(clearAndVerify).toHaveBeenCalledTimes(2);
    expect(collector.state().status).not.toBe("finalized");
  });
});
