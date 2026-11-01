import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserMcpServer } from "../src/server.js";
import { BrowserApiClient } from "../src/api-client.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("mission test-resource MCP tools", () => {
  it("forwards stable creation identities and treats provider waiting as a normal result", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return Response.json(
          String(url).endsWith("/refresh")
            ? { events: [], status: "waiting", retryAfterSeconds: 30 }
            : { id: "resource", state: "pending", retryAfterSeconds: 2 },
        );
      }),
    );
    const server = createBrowserMcpServer(
      new BrowserApiClient("http://fixture.test/api", "fictional-scoped-token"),
    );
    const client = new Client({ name: "email-callback-customer", version: "baseline" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const input = {
        missionId: id,
        name: "Invitation emails",
        idempotencyKey: "stable-invitation",
        expiresInSeconds: 3600,
      };
      for (let i = 0; i < 2; i++)
        expect(
          (await client.callTool({ name: "create_test_mailbox", arguments: input })).isError,
        ).not.toBe(true);
      expect(calls[0]).toEqual(calls[1]);
      expect(calls[0]!.body).toMatchObject({
        kind: "mailbox",
        idempotencyKey: "stable-invitation",
      });
      const waiting = await client.callTool({
        name: "read_test_messages",
        arguments: { resourceId: id, waitSeconds: 0 },
      });
      expect(waiting.isError).not.toBe(true);
      expect(waiting.structuredContent).toMatchObject({ status: "waiting", retryAfterSeconds: 30 });
      const listed = await client.listTools();
      const existing = { ...input, address: "existing@mail.example", passwordCredentialId: id };
      expect(
        (await client.callTool({ name: "connect_test_mailbox", arguments: existing })).isError,
      ).not.toBe(true);
      expect(calls.at(-1)).toMatchObject({
        url: `http://fixture.test/api/missions/${id}/test-resources/connect-mailbox`,
        body: { address: "existing@mail.example", passwordCredentialId: id },
      });
      const connectionTool = listed.tools.find((t) => t.name === "connect_test_mailbox")!;
      expect(connectionTool.inputSchema.properties).not.toHaveProperty("password");
      expect(connectionTool.description).toContain("never deletes");
      expect(listed.tools.find((t) => t.name === "read_test_messages")!.description).toContain(
        "untrusted",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
