export type BrowserRuntimeAdapter = "legacy" | "playwright_mcp";

/** One selection contract for API admission, workers and public MCP discovery.
 * The retained profile is only a development/characterization compatibility
 * path. A hosted process must never silently select it after a missing setting.
 */
export function resolveBrowserRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): BrowserRuntimeAdapter {
  const adapter = environment.SCRY_BROWSER_ADAPTER ?? "legacy";
  if (adapter === "legacy" && environment.NODE_ENV !== "production") return "legacy";
  if (adapter === "playwright_mcp" && environment.SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED === "true")
    return "playwright_mcp";
  throw new Error("SCRY_BROWSER_ADAPTER_DISABLED");
}

export function assertBrowserRuntimeAgreement(
  actual: unknown,
  expected: BrowserRuntimeAdapter,
): void {
  if (actual !== expected) throw new Error("SCRY_BROWSER_ADAPTER_COMMAND_MISMATCH");
}
