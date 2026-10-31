import { describe, it, expect } from "vitest";
import {
  browserToolCommandSchema,
  nativeToolInputSchema,
  playwrightToolDefinitions,
} from "../src/native-browser-command.js";
describe("pinned native browser surface", () => {
  it("translates every supported official schema without permissive fallback", () => {
    for (const d of playwrightToolDefinitions)
      expect(() => nativeToolInputSchema(d.inputSchema)).not.toThrow();
    expect(() => nativeToolInputSchema({ type: "unknown" })).toThrow("SCHEMA_UNSUPPORTED");
  });
  it("excludes filesystem and arbitrary evaluation capabilities", () => {
    for (const tool of [
      "browser_run_code",
      "browser_evaluate",
      "browser_install",
      "browser_file_upload",
      "browser_network_requests",
    ])
      expect(
        browserToolCommandSchema.safeParse({ kind: "browser_tool", tool, args: {} }).success,
      ).toBe(false);
    expect(
      browserToolCommandSchema.safeParse({
        kind: "browser_tool",
        tool: "browser_take_screenshot",
        args: { filename: "/tmp/secret.png" },
      }).success,
    ).toBe(false);
    const screenshot = playwrightToolDefinitions.find((t) => t.name === "browser_take_screenshot")!;
    expect(
      nativeToolInputSchema(screenshot.inputSchema).safeParse({ filename: "/tmp/secret.png" })
        .success,
    ).toBe(false);
  });
});
