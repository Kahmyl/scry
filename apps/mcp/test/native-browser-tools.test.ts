import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createBrowserMcpServer } from "../src/server.js";
import { BrowserApiClient } from "../src/api-client.js";
import { nativeCommandResult } from "../src/native-browser-tools.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("controlled native MCP profile", () => {
  it.each(["queued", "running", "completed", "failed"])(
    "returns schema-valid durable %s receipts through get_command",
    async (state) => {
      vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
      vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            id,
            state,
            result:
              state === "completed"
                ? {
                    execution: "completed",
                    observation: "unavailable",
                    businessOutcome: "unverified",
                  }
                : null,
          }),
        ),
      );
      const server = createBrowserMcpServer(new BrowserApiClient("http://api.test/api", "scoped"));
      const client = new Client({ name: "durable-receipt-schema", version: "baseline" }),
        [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      try {
        const result = await client.callTool({ name: "get_command", arguments: { commandId: id } });
        expect(result.structuredContent).toMatchObject({
          message: "Browser command facts loaded.",
          command: { id, state },
        });
        expect(result.isError).toBe(state === "failed");
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  it("distinguishes deliberate attempts while replaying the exact same start identity", async () => {
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        posted.push(JSON.parse(init!.body as string));
        return Response.json({
          runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          browserSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          replay: false,
        });
      }),
    );
    const server = createBrowserMcpServer(new BrowserApiClient("http://api.test/api", "scoped"));
    const client = new Client({ name: "attempt-identity-test", version: "baseline" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      base = {
        projectId: id,
        missionId: id,
        agentSessionId: id,
        objectiveId: id,
        flowId: id,
        flowRevisionId: id,
        environmentId: id,
      };
    try {
      for (const attemptId of ["first-attempt", "first-attempt", "second-attempt"]) {
        expect(
          (await client.callTool({ name: "start_run", arguments: { ...base, attemptId } })).isError,
        ).not.toBe(true);
      }
      expect(posted[0]!.idempotencyKey).toBe(posted[1]!.idempotencyKey);
      expect(posted[0]!.idempotencyKey).not.toBe(posted[2]!.idempotencyKey);
      expect(posted.every((p) => !("attemptId" in p))).toBe(true);
      await client.callTool({ name: "start_run", arguments: base });
      await client.callTool({ name: "start_run", arguments: base });
      expect(posted[3]!.idempotencyKey).toBe(posted[4]!.idempotencyKey);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("retains action truth when authorized image retrieval fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).endsWith("/media"))
          return Response.json({
            items: [{ index: 0, artifactId: "artifact", kind: "screenshot" }],
          });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        throw new DOMException("Image delivery timed out", "TimeoutError");
      }),
    );
    const command = {
      runId: "run",
      state: "completed",
      result: {
        execution: "completed",
        media: [{ artifactId: "artifact" }],
      },
    };
    const result = await nativeCommandResult(new BrowserApiClient("http://api.test/api"), command);
    expect(result.isError).toBe(false);
    expect(result.structuredContent.command).toBe(command);
    expect(JSON.stringify(result.content)).toContain("do not repeat the action");
  });
  it.each(["tool_error", "unknown"])(
    "does not report %s as a successful MCP action",
    async (execution) => {
      const command = {
        state: "completed",
        result: { execution, businessOutcome: "unknown", observation: "unavailable" },
      };
      const result = await nativeCommandResult(new BrowserApiClient("http://unused.test"), command);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.command).toBe(command);
    },
  );
  it("exposes ordinary browser tools only under both explicit flags and returns authorized image bytes", async () => {
    vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
    vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
    const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      artifactId = "d".repeat(64);
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scoped-test-identity");
      const url = String(input);
      if (url.endsWith("/commands"))
        return Response.json({ commandId, state: "queued", replay: false });
      if (url.endsWith("/browser-commands/" + commandId))
        return Response.json({
          id: commandId,
          runId,
          sessionId,
          state: "completed",
          result: { execution: "completed", content: [], media: [{ artifactId }] },
        });
      if (url.endsWith("/media"))
        return Response.json({ items: [{ index: 0, artifactId, kind: "screenshot" }] });
      if (url.endsWith("/media/0"))
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png", "cache-control": "private, no-store" },
        });
      throw new Error("Unexpected test request");
    });
    vi.stubGlobal("fetch", fetcher);
    const server = createBrowserMcpServer(
      new BrowserApiClient("http://api.test/api", "scoped-test-identity"),
    );
    const client = new Client({ name: "native-profile-test", version: "baseline" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("browser_take_screenshot");
      expect(tools).toContain("browser_type_secret");
      expect(tools).toContain("browser_edit_text");
      expect(tools).not.toContain("command");
      expect(tools).not.toContain("browser_evaluate");
      const result = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {
          browserSessionId: sessionId,
          actionId: "one-screenshot-action",
          type: "png",
          evidenceTitle: "Saved note",
          evidenceDescription: "Visible after saving.",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: "AQID" });
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
      expect(body).toMatchObject({
        idempotencyKey: "mcp-native-one-screenshot-action",
        command: {
          kind: "browser_tool",
          tool: "browser_take_screenshot",
          args: {
            type: "png",
            evidenceTitle: "Saved note",
            evidenceDescription: "Visible after saving.",
          },
        },
      });
      await client.callTool({
        name: "browser_edit_text",
        arguments: {
          browserSessionId: sessionId,
          actionId: "replace-one-document",
          target: "e42",
          text: "Updated document",
          intent: "replace",
          method: "keyboard",
        },
      });
      const edit = fetcher.mock.calls.find(
        (c) =>
          String(c[0]).endsWith("/commands") && String(c[1]?.body).includes("browser_edit_text"),
      )!;
      expect(JSON.parse(edit[1]!.body as string)).toMatchObject({
        command: {
          tool: "browser_edit_text",
          args: { target: "e42", text: "Updated document", intent: "replace", method: "keyboard" },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
