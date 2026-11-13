import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserMcpServer } from "../src/server.js";
import { BrowserApiClient } from "../src/api-client.js";
import { codexPluginBudget, utf8Prefix } from "./fixtures/codex-plugin-budget.js";

afterEach(() => vi.unstubAllEnvs());
it.each([false, true])(
  "keeps every tool within Codex plugin exposure budgets (native=%s)",
  async (native) => {
    vi.stubEnv("SCRY_BROWSER_ADAPTER", native ? "playwright_mcp" : "legacy");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", native ? "true" : "false");
    vi.stubEnv("SCRY_OAUTH_ENABLED", "true");
    vi.stubEnv("SCRY_OAUTH_RESOURCE", "https://scry.example/mcp");
    vi.stubEnv("SCRY_OAUTH_ISSUER", "https://scry.example/oauth");
    const server = createBrowserMcpServer(new BrowserApiClient("http://unused.test/api"));
    const client = new Client({ name: "catalog-budget", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(native ? 61 : 33);
      // Frozen from the pre-campaign source through the real SDK. Handler copy
      // can evolve; cached schemas, identities, annotations and OAuth cannot.
      const historical = JSON.parse(
        readFileSync(new URL("./fixtures/catalog-compatibility.json", import.meta.url), "utf8"),
      );
      const shapes = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          createHash("sha256")
            .update(
              JSON.stringify({
                title: tool.title,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                annotations: tool.annotations,
                _meta: tool._meta,
              }),
            )
            .digest("hex"),
        ]),
      );
      expect(shapes).toEqual(historical[native ? "native" : "retained"]);
      const budget = codexPluginBudget(tools, client.getInstructions() ?? "");
      expect(budget.hidden).toEqual([]);
      // Reserve space for modest host attribution changes; all current tools must fit.
      expect(budget.totalBytes).toBeLessThan(62000);
      expect(budget.maxToolBytes).toBeLessThan(8000);
      expect(budget.visible).toEqual(
        expect.arrayContaining([
          "list_projects",
          "get_testing_context",
          "get_report",
          "get_mission",
          "get_run_status",
          "finish_incomplete_run",
          "finalize_run",
          "publish_mission_report",
        ]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  },
);
it("charges UTF-8 byte budgets without cutting a code point", () => {
  expect(utf8Prefix("a😀b", 4)).toBe("a");
  expect(utf8Prefix("a😀b", 5)).toBe("a😀");
});
