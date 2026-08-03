import { describe, expect, it, vi } from "vitest";
import { VeilClipboardCollector, VeilClipboardCleanupError } from "../src/veil-clipboard-collector.js";

describe("VeilClipboardCollector", () => {
  it("retries destruction and only finalizes after verified empty clipboard", async () => {
    let calls = 0;
    const page = { evaluate: vi.fn(async () => { calls += 1; if (calls < 2) throw new Error("transient"); }) };
    const collector = new VeilClipboardCollector(page as never, 3);
    collector.markProtectedClipboardTouched();
    await collector.finalize();
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(collector.state().status).toBe("finalized");
  });

  it("refuses finalization when protected clipboard destruction cannot be verified", async () => {
    const page = { evaluate: vi.fn(async () => { throw new Error("denied"); }) };
    const collector = new VeilClipboardCollector(page as never, 2);
    collector.markProtectedClipboardTouched();
    await expect(collector.finalize()).rejects.toBeInstanceOf(VeilClipboardCleanupError);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(collector.state().status).not.toBe("finalized");
  });
});
