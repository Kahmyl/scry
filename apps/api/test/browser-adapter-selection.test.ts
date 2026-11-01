import { afterEach, describe, it, expect, vi } from "vitest";
import { selectedBrowserAdapter } from "../src/browser-execution/browser-adapter-selection.js";
afterEach(() => vi.unstubAllEnvs());
describe("controlled browser adapter selection", () => {
  it("keeps the existing runtime as the inactive default", () => {
    vi.stubEnv("SCRY_BROWSER_ADAPTER", undefined);
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", undefined);
    expect(selectedBrowserAdapter()).toBe("legacy");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    expect(selectedBrowserAdapter()).toBe("legacy");
  });
  it("requires both exact candidate selections, with no unknown fallback", () => {
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "false");
    expect(() => selectedBrowserAdapter()).toThrow("ADAPTER_DISABLED");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    expect(selectedBrowserAdapter()).toBe("playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "unknown");
    expect(() => selectedBrowserAdapter()).toThrow("ADAPTER_DISABLED");
  });
});
