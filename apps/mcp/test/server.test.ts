import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserApiClient } from "../src/api-client.js";
import { createBrowserMcpServer } from "../src/server.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser baseline MCP profile", () => {
  it("exposes only the small lifecycle surface and keeps Flow creation agent-directed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })),
    );
    const { client, server } = await connected();
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "list_missions",
      "list_environments",
      "create_environment",
      "list_credentials",
      "create_credential",
      "bind_credentials",
      "start_mission",
      "create_objective",
      "create_flow",
      "start_run",
      "get_mission",
      "finalize_run",
      "publish_mission_report",
      "get_connection_diagnostics",
      "preview_mission_report",
      "get_testing_context",
      "start_journey",
      "get_run_status",
      "finish_incomplete_run",
      "list_reports",
      "get_report",
      "command",
      "get_command",
      "get_cleanup_ledger",
      "record_cleanup_decision",
      "connect_test_mailbox",
      "list_test_resources",
      "create_test_mailbox",
      "create_webhook_listener",
      "read_test_messages",
      "bind_test_message_secret",
      "close_test_resource",
    ]);
    const flow = tools.find((tool) => tool.name === "create_flow")!;
    expect(flow.description).toContain("agent's discretion");
    expect(flow.description).toContain("does not need to be an alternative");
    const report = tools.find((tool) => tool.name === "publish_mission_report")!;
    expect(JSON.stringify(report.inputSchema)).not.toContain("evidenceDigest");
    const command = tools.find((tool) => tool.name === "command")!;
    expect(command.description).toContain("atomically publishes");
    expect(command.description).toContain("opaque protected references");
    expect(command.description).toContain("without interpreting fields or creating handles");
    expect(command.description).toContain("read-only verification needs no capture_dom");
    expect(command.description).toContain("associated with an acknowledged mutation effect");
    expect(command.description).toContain("sanitized successorObservation");
    expect(command.description).toContain("SCRY_BROWSER_EFFECT_OUTCOME_PENDING");
    const mission = tools.find((tool) => tool.name === "start_mission")!;
    expect(JSON.stringify(mission.inputSchema)).not.toContain("publicReleaseGrants");
    expect(tools.find((tool) => tool.name === "create_environment")?.description).toContain(
      "do not ask the user to configure it manually",
    );
    expect(tools.find((tool) => tool.name === "list_credentials")?.description).toContain(
      "never infer first-use permission",
    );
    expect(tools.find((tool) => tool.name === "bind_credentials")?.description).toContain(
      "explicitly selected",
    );
    expect(tools.find((tool) => tool.name === "close_test_resource")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(tools.find((tool) => tool.name === "read_test_messages")?.annotations).toMatchObject({
      destructiveHint: false,
    });
    await client.close();
    await server.close();
  });

  it("lists only metadata, creates without echoing plaintext, and binds a user-selected credential", async () => {
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const protectedValueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const browserSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const secret = "never-return-this-value";
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/projects/${projectId}/protected-inputs`) && !init?.method)
          return new Response(
            JSON.stringify([
              {
                id: protectedValueId,
                referenceId: protectedValueId,
                projectId,
                displayName: "Vitract_password",
                state: "active",
              },
            ]),
            { status: 200 },
          );
        if (url.endsWith(`/projects/${projectId}/protected-inputs`))
          return new Response(JSON.stringify({ protectedValueId, replay: false }), { status: 200 });
        if (url.endsWith(`/runs/${runId}/protected-inputs`))
          return new Response(
            JSON.stringify({
              browserSessionId,
              protectedInputIds: [protectedValueId],
              added: 1,
              replay: false,
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ code: "UNEXPECTED_REQUEST" }), { status: 500 });
      });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    const listed = await client.callTool({
      name: "list_credentials",
      arguments: { projectId },
    });
    expect(JSON.stringify(listed)).not.toContain(secret);
    const created = await client.callTool({
      name: "create_credential",
      arguments: {
        projectId,
        displayName: "Vitract_password",
        value: secret,
        idempotencyKey: "create-vitract-password-1",
      },
    });
    expect(created.structuredContent).toMatchObject({ protectedValueId, replay: false });
    expect(JSON.stringify(created)).not.toContain(secret);
    const bound = await client.callTool({
      name: "bind_credentials",
      arguments: { runId, protectedInputIds: [protectedValueId], userConfirmed: true },
    });
    expect(bound.structuredContent).toMatchObject({ browserSessionId, added: 1, replay: false });
    const bodies = fetchMock.mock.calls
      .map((call) => (call[1] as RequestInit | undefined)?.body)
      .filter((body): body is string => typeof body === "string")
      .map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({
      displayName: "Vitract_password",
      value: secret,
      expiresInSeconds: null,
      idempotencyKey: "create-vitract-password-1",
    });
    expect(bodies[1]).toEqual({ protectedInputIds: [protectedValueId], userConfirmed: true });
    await client.close();
    await server.close();
  });

  it("discovers approved Environment IDs and scope through a read-only project call", async () => {
    const environment = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Test",
      baseOrigin: "https://example.test",
      allowedServiceOrigins: ["https://api.example.test"],
      disclosureMode: "confidential",
      state: "active",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([environment]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    const result = await client.callTool({
      name: "list_environments",
      arguments: { projectId: environment.projectId },
    });
    expect(result.structuredContent).toMatchObject({ environments: [environment] });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `http://scry.test/api/projects/${environment.projectId}/environments`,
    );
    expect(fetchMock.mock.calls[0]![1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[0]![1]?.body).toBeUndefined();
    await client.close();
    await server.close();
  });

  it("creates an assigned application environment idempotently through the customer MCP", async () => {
    const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ environmentId, replay: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ environmentId, replay: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    const arguments_ = {
      projectId,
      name: "Vitract Preview",
      baseOrigin: "https://preview.vitract.com",
      allowedServiceOrigins: ["https://preview-api.vitract.com"],
      disclosureMode: "confidential",
    };
    const created = await client.callTool({
      name: "create_environment",
      arguments: arguments_,
    });
    const replayed = await client.callTool({
      name: "create_environment",
      arguments: arguments_,
    });
    expect(created.structuredContent).toMatchObject({ environmentId, replay: false });
    expect(replayed.structuredContent).toMatchObject({ environmentId, replay: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `http://scry.test/api/projects/${projectId}/environments`,
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const replayRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: arguments_.name,
      baseOrigin: arguments_.baseOrigin,
      allowedServiceOrigins: arguments_.allowedServiceOrigins,
      disclosureMode: arguments_.disclosureMode,
      idempotencyKey: expect.stringMatching(/^mcp-browser-environment-/u),
    });
    expect(JSON.parse(String(replayRequest.body)).idempotencyKey).toBe(
      JSON.parse(String(request.body)).idempotencyKey,
    );
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
    await client.callTool({ name: "start_mission", arguments: arguments_ });
    await client.callTool({ name: "start_mission", arguments: arguments_ });
    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String((call[1] as RequestInit).body)) as { idempotencyKey: string },
    );
    expect(bodies[0]!.idempotencyKey).toBe(bodies[1]!.idempotencyKey);
    expect(bodies[0]!.idempotencyKey).toMatch(/^mcp-browser-mission-/u);
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
    await client.callTool({ name: "command", arguments: arguments_ });
    await client.callTool({ name: "command", arguments: arguments_ });
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
  const server = createBrowserMcpServer(new BrowserApiClient("http://scry.test/api"));
  const client = new Client({ name: "browser-test", version: "2.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
