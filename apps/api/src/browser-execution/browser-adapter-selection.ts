export function selectedBrowserAdapter(): "legacy" | "playwright_mcp" {
  const value = process.env.SCRY_BROWSER_ADAPTER ?? "legacy";
  if (value === "legacy") return value;
  if (value === "playwright_mcp" && process.env.SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED === "true")
    return value;
  throw new Error("SCRY_BROWSER_ADAPTER_DISABLED");
}
