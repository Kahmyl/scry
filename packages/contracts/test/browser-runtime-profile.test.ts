import { describe, expect, it } from "vitest";
import {
  assertBrowserRuntimeAgreement,
  resolveBrowserRuntime,
} from "../src/browser-runtime-profile.js";

describe("hosted browser runtime contract", () => {
  it.each([undefined, "legacy", "unknown", ""])("refuses hosted fallback %s", (adapter) => {
    expect(() =>
      resolveBrowserRuntime({ NODE_ENV: "production", SCRY_BROWSER_ADAPTER: adapter }),
    ).toThrow("ADAPTER_DISABLED");
  });
  it.each([undefined, "false", ""])("requires explicit native availability %s", (enabled) => {
    expect(() =>
      resolveBrowserRuntime({
        NODE_ENV: "production",
        SCRY_BROWSER_ADAPTER: "playwright_mcp",
        SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED: enabled,
      }),
    ).toThrow("ADAPTER_DISABLED");
  });
  it("selects the qualified hosted profile and preserves explicit non-hosted characterization", () => {
    expect(
      resolveBrowserRuntime({
        NODE_ENV: "production",
        SCRY_BROWSER_ADAPTER: "playwright_mcp",
        SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED: "true",
      }),
    ).toBe("playwright_mcp");
    expect(resolveBrowserRuntime({ NODE_ENV: "test", SCRY_BROWSER_ADAPTER: "legacy" })).toBe(
      "legacy",
    );
  });
  it.each([undefined, "legacy", "unknown"])("refuses mixed API/MCP health %s", (actual) => {
    expect(() => assertBrowserRuntimeAgreement(actual, "playwright_mcp")).toThrow(
      "ADAPTER_COMMAND_MISMATCH",
    );
  });
  it("accepts coherent native readiness", () =>
    expect(() => assertBrowserRuntimeAgreement("playwright_mcp", "playwright_mcp")).not.toThrow());
});
