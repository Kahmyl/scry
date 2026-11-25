import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserApiClient } from "../src/api-client.js";
import { createBrowserMcpServer } from "../src/server.js";
import { nativeCommandResult } from "../src/native-browser-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browserToolCall, browserErrorEnvelopeCapability } from "../src/browser-tool-error.js";
import { BrowserApiError } from "../src/api-client.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.each([
  { execution: "completed", complete: true, receipts: [{ execution: "unknown" }] },
  { execution: "partial", complete: false, receipts: [{ execution: "not_dispatched" }] },
])(
  "never promotes malformed or unknown sequence truth to a successful SDK result",
  async (result) => {
    const r = await nativeCommandResult(new BrowserApiClient("http://unused.invalid"), {
      state: "completed",
      result,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.command).toMatchObject({ interaction: { state: "unknown" } });
  },
);
it.each(["browser_click", "browser_sequence", "browser_scoped_request"])(
  "returns a typed, correlated and private SDK rejection for %s",
  async (name) => {
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED",
            incidentId: "scry-command-" + id,
            relatedCommandId: id,
            message: "PRIVATE_PROVIDER_PASSWORD",
            safeActions: ["PRIVATE_PROVIDER_URL"],
          },
          { status: 409 },
        ),
      ),
    );
    const server = createBrowserMcpServer(new BrowserApiClient("http://fixture.invalid/api"));
    const client = new Client(
      { name: "recovery-regression", version: "1" },
      { capabilities: { experimental: { [browserErrorEnvelopeCapability]: { version: 1 } } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const args =
        name === "browser_click"
          ? { browserSessionId: id, actionId: "regression-click", target: "e7" }
          : name === "browser_sequence"
            ? {
                browserSessionId: id,
                planId: "regression-plan",
                observationId: id,
                steps: [
                  { tool: "browser_click", actionId: "regression-click", args: { target: "e7" } },
                ],
              }
            : {
                browserSessionId: id,
                actionId: "regression-get",
                method: "GET",
                url: "https://fixture.example/readiness",
              };
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        error: {
          version: 1,
          code: "SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED",
          incidentId: "scry-command-" + id,
          relatedCommandId: id,
          supportUrl: "https://scry.giize.com/support",
        },
      });
      expect(JSON.stringify(r)).not.toContain("PRIVATE_PROVIDER");
      expect(r.structuredContent).not.toHaveProperty("commandId");
      expect(JSON.parse((r.content as any[])[0].text)).toEqual(r.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  },
);
it("keeps a cached strict success schema usable without structured-error negotiation", async () => {
  const server = new McpServer({ name: "legacy-schema-fixture", version: "1" });
  server.registerTool(
    "legacy_cached_tool",
    {
      inputSchema: {},
      outputSchema: {
        message: z.string(),
        commandId: z.string().uuid(),
        state: z.string(),
        complete: z.boolean(),
      },
    },
    async () =>
      browserToolCall(server, async () => {
        throw new BrowserApiError("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED", 409);
      }),
  );
  const client = new Client({ name: "legacy-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    await client.listTools();
    const r = await client.callTool({ name: "legacy_cached_tool", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const body = JSON.parse((r.content as any[])[0].text);
    expect(body.error).toMatchObject({
      version: 1,
      code: "SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED",
    });
    expect(body).not.toHaveProperty("commandId");
  } finally {
    await client.close();
    await server.close();
  }
});
it.each([{ version: 2 }, { version: "1" }, { enabled: true }, { version: 1, unexpected: true }])(
  "does not negotiate a truthy or incompatible experimental capability %j",
  async (capability) => {
    const server = new McpServer({ name: "capability-fixture", version: "1" });
    server.registerTool("failing_tool", { inputSchema: {} }, async () =>
      browserToolCall(server, async () => {
        throw new BrowserApiError("SCRY_BROWSER_COMMAND_RECONCILIATION_REQUIRED", 409);
      }),
    );
    const client = new Client(
      { name: "capability-client", version: "1" },
      { capabilities: { experimental: { [browserErrorEnvelopeCapability]: capability } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const r = await client.callTool({ name: "failing_tool", arguments: {} });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  },
);
it.each(["PRIVATE_PROVIDER_PASSWORD", "SCRY_BROWSER_PRIVATE_VALUE=secret", "HTTP_502"])(
  "does not disclose unknown service error metadata %s",
  async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code, message: code, safeActions: [code], incidentId: code, relatedCommandId: code },
          { status: 502 },
        ),
      ),
    );
    const error = await new BrowserApiClient("http://fixture.invalid/api")
      .get("/test")
      .catch((e) => e);
    if (!(error instanceof BrowserApiError)) throw Error("EXPECTED_SAFE_API_ERROR");
    const text = JSON.stringify(error.publicDetail) + error.message;
    expect(text).not.toContain(code);
    expect(error.publicDetail.code).toBe("SCRY_BROWSER_API_UNAVAILABLE");
  },
);
