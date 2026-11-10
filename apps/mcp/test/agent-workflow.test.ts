import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserMcpServer } from "../src/server.js";
import { BrowserApiClient } from "../src/api-client.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function connected() {
  vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
  vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
  const server = createBrowserMcpServer(new BrowserApiClient("http://fixture.test/api", "scoped"));
  const client = new Client({ name: "workflow-regression", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
it("keeps client-reported missing tools separate from authenticated server diagnostics", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        serverAuthenticated: true,
        hostToolExposure: "unknown",
        connection: { grantAvailable: true },
      }),
    ),
  );
  const { client, close } = await connected();
  try {
    const r = await client.callTool({
      name: "get_connection_diagnostics",
      arguments: { observedToolNames: ["list_projects"] },
    });
    expect(r.structuredContent).toMatchObject({
      serverAuthenticated: true,
      hostToolExposure: "unknown",
      clientReport: { source: "client_supplied_unverified" },
    });
    expect((r.structuredContent as any).clientReport.missingRequiredTools).toContain(
      "get_run_status",
    );
    expect((r.structuredContent as any).clientReport.missingRequiredTools).not.toContain(
      "list_projects",
    );
  } finally {
    await close();
  }
});
it("gets one scoped server readiness snapshot rather than inferring capabilities in MCP", async () => {
  const f = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      contractVersion: 1,
      ready: false,
      blocked: ["mailboxRead"],
      hostToolExposure: "unknown",
    }),
  );
  vi.stubGlobal("fetch", f);
  const { client, close } = await connected();
  try {
    const r = await client.callTool({ name: "get_testing_context", arguments: { projectId: id } });
    expect(r.isError).not.toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("http://fixture.test/api/testing-context");
    expect(r.structuredContent).toMatchObject({
      ready: false,
      blocked: ["mailboxRead"],
      hostToolExposure: "unknown",
    });
  } finally {
    await close();
  }
});
it("uses one atomic journey request and retries the identical attempt after a lost response", async () => {
  const bodies: unknown[] = [];
  let first = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://fixture.test/api/journeys");
      bodies.push(JSON.parse(String(init.body)));
      if (first) {
        first = false;
        throw Error("fictional lost reply");
      }
      return Response.json({ runId: id, browserSessionId: id, replay: true });
    }),
  );
  const { client, close } = await connected();
  const args = {
    missionId: id,
    projectId: id,
    agentSessionId: id,
    environmentId: id,
    attemptId: "one-attempt",
    title: "Profile",
    completionCriteria: { saved: true },
    objectiveOrder: 0,
  };
  try {
    expect((await client.callTool({ name: "start_journey", arguments: args })).isError).toBe(true);
    expect(
      (await client.callTool({ name: "start_journey", arguments: args })).structuredContent,
    ).toMatchObject({ runId: id, replay: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
  } finally {
    await close();
  }
});
const steps = [
  { tool: "browser_type", actionId: "fill-name-1", args: { target: "e1", text: "Fictional name" } },
  {
    tool: "browser_type_secret",
    actionId: "fill-password-1",
    args: { target: "e2", protectedValueId: id },
  },
  { tool: "browser_click", actionId: "submit-form-1", args: { target: "e3", element: "Sign in" } },
];
it.each(["completed", "tool_error", "unknown"])(
  "submits a single durable worker plan for %s results",
  async (execution) => {
    const writes = new Map<string, unknown>();
    let submissions = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/commands")) {
          const body = JSON.parse(String(init?.body));
          writes.set(body.idempotencyKey, body);
          submissions++;
          return Response.json({ commandId: id, state: "queued" });
        }
        return Response.json({
          id,
          runId: id,
          state: "completed",
          result: {
            execution,
            complete: execution === "completed",
            observation: "available",
            receipts: steps.map((s) => ({ actionId: s.actionId, execution })),
            content: [{ type: "text", text: "Current form state" }],
          },
        });
      }),
    );
    const { client, close } = await connected(),
      args = { browserSessionId: id, planId: "known-form-plan", observationId: id, steps };
    try {
      const r = await client.callTool({ name: "browser_sequence", arguments: args });
      expect((r.structuredContent as { complete: boolean }).complete).toBe(
        execution === "completed",
      );
      expect(submissions).toBe(1);
      const body = [...writes.values()][0] as any;
      expect(body.command.tool).toBe("browser_sequence");
      expect(body.command.args.steps).toHaveLength(3);
      await client.callTool({ name: "browser_sequence", arguments: args });
      expect(writes.size).toBe(1);
    } finally {
      await close();
    }
  },
);
it("rejects click/key before later actions, selectors and unsupported versions before dispatch", async () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  const { client, close } = await connected();
  try {
    for (const plan of [
      { planId: "invalid-plan", steps: [steps[2], steps[0]] },
      {
        planId: "invalid-plan",
        steps: [
          {
            tool: "browser_press_key",
            actionId: "press-first",
            args: { target: "e1", key: "Enter" },
          },
          steps[0],
        ],
      },
      {
        planId: "invalid-plan",
        steps: [{ ...steps[0], args: { target: "#unobserved", text: "No" } }],
      },
      { planId: "invalid-plan", contractVersion: 2, steps },
    ])
      expect(
        (
          await client.callTool({
            name: "browser_sequence",
            arguments: { browserSessionId: id, ...plan },
          })
        ).isError,
      ).toBe(true);
    expect(f).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});
it("does not expose operator-only report details in its preview", async () => {
  const { client, close } = await connected();
  try {
    const r = await client.callTool({
      name: "preview_mission_report",
      arguments: {
        summary: "Limited scope",
        safeReport: {
          presentation: {
            subject: "application",
            scope: [],
            checks: [{ title: "Payment", actual: "No fixture", status: "blocked" }],
            sections: [
              {
                title: "Cleanup",
                items: [{ title: "Temporary key", detail: "Revoked and verified" }],
              },
            ],
          },
          operatorDiagnostics: { private: "PRIVATE_VALUE" },
        },
      },
    });
    expect(r.structuredContent).toMatchObject({
      valid: true,
      operatorOnlyFields: ["operatorDiagnostics"],
    });
    expect(JSON.stringify(r)).not.toContain("PRIVATE_VALUE");
  } finally {
    await close();
  }
});
