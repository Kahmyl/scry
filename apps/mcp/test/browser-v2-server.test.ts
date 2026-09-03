import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserV2ApiClient } from "../src/browser-v2-api-client.js";
import { createBrowserV2McpServer } from "../src/browser-v2-server.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser v2 MCP profile", () => {
  it("exposes only the small lifecycle surface and keeps Flow creation agent-directed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
    );
    const { client, server } = await connected();
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "browser_v2_list_projects",
      "browser_v2_list_missions",
      "browser_v2_start_mission",
      "browser_v2_create_objective",
      "browser_v2_create_flow",
      "browser_v2_start_run",
      "browser_v2_get_mission",
      "browser_v2_finalize_run",
      "browser_v2_publish_mission_report",
      "browser_v2_command",
      "browser_v2_get_command",
    ]);
    const flow = tools.find((tool) => tool.name === "browser_v2_create_flow")!;
    expect(flow.description).toContain("agent's discretion");
    expect(flow.description).toContain("does not need to be an alternative");
    const report = tools.find((tool) => tool.name === "browser_v2_publish_mission_report")!;
    expect(JSON.stringify(report.inputSchema)).not.toContain("evidenceDigest");
    const command = tools.find((tool) => tool.name === "browser_v2_command")!;
    expect(command.description).toContain("atomically publishes");
    expect(command.description).toContain("opaque protected references");
    expect(command.description).toContain("without interpreting fields or creating handles");
    expect(command.description).toContain("read-only verification needs no capture_dom");
    expect(command.description).toContain("associated with an acknowledged mutation effect");
    expect(command.description).toContain("sanitized successorObservation");
    expect(command.description).toContain("BROWSER_V2_EFFECT_OUTCOME_PENDING");
    const mission = tools.find((tool) => tool.name === "browser_v2_start_mission")!;
    expect(JSON.stringify(mission.inputSchema)).not.toContain("publicReleaseGrants");
    await client.close();
    await server.close();
  });

  it("derives stable lifecycle idempotency without asking the agent to invent keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          missionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          replay: false,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    const arguments_ = {
      projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      title: "Test",
      instruction: "Complete the journey",
      provider: "codex",
      settings: {},
    };
    await client.callTool({ name: "browser_v2_start_mission", arguments: arguments_ });
    await client.callTool({ name: "browser_v2_start_mission", arguments: arguments_ });
    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as { idempotencyKey: string },
    );
    expect(bodies[0]!.idempotencyKey).toBe(bodies[1]!.idempotencyKey);
    expect(bodies[0]!.idempotencyKey).toMatch(/^mcp-browser-v2-mission-/u);
    await client.close();
    await server.close();
  });

  it("uses a fresh command idempotency key for each intentional invocation", async () => {
    const commandIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    let posts = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          const commandId = commandIds[posts++]!;
          return new Response(JSON.stringify({ commandId, replay: false, state: "queued" }), {
            status: 200,
          });
        }
        const commandId = commandIds.find((id) => url.endsWith(id))!;
        return new Response(JSON.stringify({ id: commandId, state: "completed" }), { status: 200 });
      });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    const arguments_ = {
      browserSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      command: { kind: "observe" },
    };
    await client.callTool({ name: "browser_v2_command", arguments: arguments_ });
    await client.callTool({ name: "browser_v2_command", arguments: arguments_ });
    const bodies = fetchMock.mock.calls
      .filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")
      .map(
        (call) => JSON.parse(String((call[1] as RequestInit).body)) as { idempotencyKey: string },
      );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.idempotencyKey).not.toBe(bodies[1]!.idempotencyKey);
    await client.close();
    await server.close();
  });
});

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBrowserV2McpServer(new BrowserV2ApiClient("http://scry.test/api"));
  const client = new Client({ name: "browser-v2-test", version: "2.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
