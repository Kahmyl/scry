import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { contextFeedback, errorFeedback } from "@scry/contracts";
import { BrowserApiClient } from "../src/api-client.js";
import { createBrowserMcpServer } from "../src/server.js";
import { registerNativeBrowserTools } from "../src/native-browser-tools.js";
import { registerBrowserSequence } from "../src/browser-sequence.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

it.each(["completed", "tool_error"])(
  "keeps %s truth and media gaps inside the existing SDK command envelope",
  async (execution) => {
    let durable: Record<string, unknown>;
    const f = vi.fn(async () => Response.json(durable));
    vi.stubGlobal("fetch", f);
    const { client, close } = await connect();
    try {
      for (const snapshot of [false, true])
        for (const live of [false, true])
          for (const permanent of [false, true]) {
            const result = {
              execution,
              observation: "available",
              ...(snapshot ? { observationId: id } : {}),
              readOnlyImageInspectionSupported: live,
              imageEvidence: {
                state: "withheld",
                reason: permanent
                  ? "native_protection_geometry_unsupported"
                  : "native_protection_geometry_stale",
                recovery: permanent ? "preserve_gap" : "read_only_once",
              },
              content: [
                { type: "text", text: snapshot ? "Actual page snapshot" : "Interaction receipt" },
              ],
            };
            durable = { id, runId: id, state: "completed", result };
            const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
            const body = r.structuredContent as any;
            expect(Object.keys(body).sort()).toEqual(["command", "message"]);
            expect(body.command.result).toEqual(result);
            expect(r.isError).toBe(execution === "tool_error");
            expect(body.command.interaction.applicationConclusion).toBe("not_determined");
            expect(body.command.interaction.next.action).toBe(
              !permanent && live
                ? "recover_image_read_only_once"
                : snapshot
                  ? "use_returned_observation"
                  : execution === "tool_error"
                    ? "inspect_application"
                    : "review_returned_receipt",
            );
            expect(body.message.includes("returned page text is available")).toBe(snapshot);
            expect(r.content).toHaveLength(1);
            expect(durable).not.toHaveProperty("interaction");
          }
      // A response projection neither fetches media that was not admitted nor
      // automatically replays/retries a browser action to fill an evidence gap.
      expect(f).toHaveBeenCalledTimes(8);
    } finally {
      await close();
    }
  },
);

it("retains error-only inspection but reuses a real guarded successor observation", async () => {
  let snapshot = false;
  const f = vi.fn(async () =>
    Response.json({
      id,
      runId: id,
      state: "completed",
      result: {
        execution: "tool_error",
        observation: "available",
        ...(snapshot ? { observationId: id } : {}),
        content: [{ type: "text", text: snapshot ? "Actual successor" : "Error only" }],
      },
    }),
  );
  vi.stubGlobal("fetch", f);
  const { client, close } = await connect();
  try {
    for (const expected of ["inspect_application", "use_returned_observation"]) {
      const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
      expect(r.isError).toBe(true);
      expect((r.structuredContent as any).command.interaction.next.action).toBe(expected);
      snapshot = true;
    }
    expect(f).toHaveBeenCalledTimes(2);
  } finally {
    await close();
  }
});

it("continues reporting after actual release with a withheld recording without polling media", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      paths.push(url);
      return Response.json(
        url.endsWith("/stop")
          ? { replay: false }
          : {
              terminal: true,
              pendingCommands: 0,
              browserReleased: true,
              recordingAssessment: { state: "withheld" },
            },
      );
    }),
  );
  const { client, close } = await connect();
  try {
    const r = await client.callTool({
      name: "finish_incomplete_run",
      arguments: {
        runId: id,
        confirmed: true,
        conclusion: "Retain incomplete evidence gap",
      },
    });
    expect((r.structuredContent as any).interaction).toMatchObject({
      state: "release_confirmed_recording_withheld",
      next: { action: "continue_with_returned_context" },
    });
    expect((r.structuredContent as any).message).toContain("report the recording gap");
    expect(paths).toEqual([
      `http://fixture.test/api/runs/${id}/stop`,
      `http://fixture.test/api/runs/${id}/status`,
    ]);
    expect(r.isError).not.toBe(true);
  } finally {
    await close();
  }
});

it("does not repeat closure or poll evidence when optional assessment retrieval is unavailable", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      paths.push(url);
      return Response.json(
        url.endsWith("/stop")
          ? { replay: false }
          : {
              terminal: true,
              pendingCommands: 0,
              browserReleased: true,
              recordingAssessmentAvailability: "unavailable",
            },
      );
    }),
  );
  const { client, close } = await connect();
  try {
    const r = await client.callTool({
      name: "finish_incomplete_run",
      arguments: {
        runId: id,
        confirmed: true,
        conclusion: "Preserve actual release and recording uncertainty",
      },
    });
    expect((r.structuredContent as any).interaction).toMatchObject({
      state: "release_confirmed_recording_unavailable",
      next: { action: "continue_with_returned_context" },
    });
    expect((r.structuredContent as any).message).toContain("could not retrieve");
    expect((r.structuredContent as any).message).not.toContain("was withheld");
    expect(paths).toEqual([
      `http://fixture.test/api/runs/${id}/stop`,
      `http://fixture.test/api/runs/${id}/status`,
    ]);
    expect(r.isError).not.toBe(true);
  } finally {
    await close();
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function connect(server?: McpServer) {
  vi.stubEnv("SCRY_BROWSER_ADAPTER", "playwright_mcp");
  vi.stubEnv("SCRY_BROWSER_PLAYWRIGHT_MCP_ENABLED", "true");
  const s = server ?? createBrowserMcpServer(new BrowserApiClient("http://fixture.test/api"));
  const client = new Client({ name: "interaction-wire-proof", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await s.close();
    },
  };
}

it.each([
  ["queued", null, "pending", false, "get_command"],
  ["completed", { execution: "unknown" }, "unknown", true, "get_run_status"],
  ["completed", { execution: "tool_error" }, "tool_error", true, "browser_snapshot"],
  [
    "completed",
    {
      execution: "tool_error",
      observation: "unavailable",
      observationIssue: "native_protection_capacity",
    },
    "tool_error",
    true,
    "get_run_status",
  ],
  [
    "completed",
    {
      execution: "tool_error",
      observation: "unavailable",
      observationIssue: "native_protection_classification_failed",
    },
    "tool_error",
    true,
    "get_run_status",
  ],
  [
    "completed",
    { execution: "completed", observation: "unavailable" },
    "action_complete_observation_unavailable",
    false,
    "browser_snapshot",
  ],
  [
    "completed",
    {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "native_protection_capacity",
    },
    "action_complete_observation_unavailable",
    false,
    "get_run_status",
  ],
  [
    "completed",
    {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "native_protection_classification_failed",
    },
    "action_complete_observation_unavailable",
    false,
    "get_run_status",
  ],
  [
    "completed",
    {
      execution: "completed",
      observation: "unavailable",
      observationIssue: "native_protection_refresh_incomplete",
    },
    "action_complete_observation_unavailable",
    false,
    "browser_snapshot",
  ],
  [
    "completed",
    {
      execution: "tool_error",
      scopeRestrictionObserved: true,
      scopeRestrictionImpact: "action_blocked",
    },
    "scope_restricted",
    true,
    undefined,
  ],
] as const)(
  "projects actionable %s/%j receipts without changing durable facts",
  async (state, result, assessment, isError, tool) => {
    const durable = { id, runId: id, state, result };
    const f = vi.fn(async () => Response.json(durable));
    vi.stubGlobal("fetch", f);
    const { client, close } = await connect();
    try {
      const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
      const body = r.structuredContent as any;
      // This strict historical envelope must still validate at the SDK boundary.
      expect(Object.keys(body).sort()).toEqual(["command", "message"]);
      expect(body.command).toMatchObject({
        ...durable,
        interaction: { state: assessment, applicationConclusion: "not_determined" },
      });
      expect(body.command.result).toEqual(result);
      expect(body.command.interaction.next.tool).toBe(tool);
      expect(r.isError).toBe(isError);
      expect(f).toHaveBeenCalledTimes(1);
      expect(durable).not.toHaveProperty("interaction");
    } finally {
      await close();
    }
  },
);

it("keeps observed success compact and reuses the actual observation without another API read", async () => {
  const result = {
    execution: "completed",
    observation: "available",
    observationId: id,
    content: [{ type: "text", text: "Saved current state" }],
  };
  const f = vi.fn(async () => Response.json({ id, state: "completed", result }));
  vi.stubGlobal("fetch", f);
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
    const body = r.structuredContent as any;
    expect(body.command.result).toEqual(result);
    expect(body.command).not.toHaveProperty("interaction");
    expect(body.message).toContain("returned observation");
    expect(body.message.length).toBeLessThan(120);
    expect(f).toHaveBeenCalledTimes(1);
  } finally {
    await close();
  }
});

it.each(["http_origin", "connect_endpoint"])(
  "keeps successful action feedback compact while retaining incidental %s restrictions",
  async (transport) => {
    const result = {
      execution: "completed",
      observation: "available",
      observationId: id,
      scopeRestrictionObserved: true,
      scopeDiagnostics: {
        current: {
          denialCount: 1,
          endpoints: [{ transport, endpoint: "public-fixture.example", count: 1 }],
          interpretation: "contextual_observation_only",
          causalAssociation: "not_established",
        },
      },
      content: [{ type: "text", text: "Current saved state" }],
    };
    const durable = { id, runId: id, state: "completed", result };
    const f = vi.fn(async () => Response.json(durable));
    vi.stubGlobal("fetch", f);
    const { client, close } = await connect();
    try {
      const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
      const body = r.structuredContent as any;
      expect(body.command).toEqual(durable);
      expect(body.command).not.toHaveProperty("interaction");
      expect(body.message).toContain("returned observation");
      expect(body.message.length).toBeLessThan(120);
      expect(r.isError).toBe(false);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  },
);

it.each(["browser_snapshot", "browser_sequence"])(
  "retains a pending %s command after bounded polling without resubmission",
  async (name) => {
    const f = vi.fn(async () => Response.json({ commandId: id, state: "running" }));
    vi.stubGlobal("fetch", f);
    const api = new BrowserApiClient("http://fixture.test/api"),
      server = new McpServer({ name: "pending-boundary", version: "1" });
    const poll = vi.fn(async () => undefined);
    registerNativeBrowserTools(server, api, poll);
    registerBrowserSequence(server, api, poll);
    const { client, close } = await connect(server);
    try {
      const args =
        name === "browser_snapshot"
          ? { actionId: "pending-observe" }
          : {
              planId: "pending-plan",
              observationId: id,
              steps: [
                {
                  tool: "browser_type",
                  actionId: "pending-field",
                  args: { target: "e1", text: "Fixture" },
                },
              ],
            };
      const r = await client.callTool({ name, arguments: { browserSessionId: id, ...args } });
      expect(r.isError).toBe(false);
      expect(r.structuredContent).toMatchObject({
        command: {
          commandId: id,
          state: "running",
          interaction: { state: "pending", next: { tool: "get_command" } },
        },
      });
      expect(f).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  },
);

it.each(["object", "string", "transport"])(
  "renders a finite safe %s error without exposing provider data or retrying",
  async (form) => {
    const privateText =
      "provider token=SEEDED_PRIVATE_TOKEN https://private.example/path?secret=SEED";
    const canonical = errorFeedback("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    const f = vi.fn(async () => {
      if (form === "transport") throw Error(privateText);
      return Response.json(
        form === "string"
          ? { message: privateText }
          : {
              message: {
                code: "SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED",
                message: privateText,
                safeActions: [privateText],
                interaction: canonical,
              },
            },
        { status: 503 },
      );
    });
    vi.stubGlobal("fetch", f);
    const { client, close } = await connect();
    try {
      const r = await client.callTool({
        name: "browser_click",
        arguments: {
          browserSessionId: id,
          actionId: "one-safe-error",
          target: "e1",
          element: "Save",
        },
      });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(/SEEDED_PRIVATE_TOKEN|private\.example|secret=SEED/);
      const text = (r.content as Array<{ type: string; text?: string }>).find(
        (item) => item.type === "text",
      )!.text!;
      expect(JSON.parse(text).interaction).toMatchObject({
        version: 1,
        state: form === "object" ? "capacity_unavailable" : "unknown",
        applicationConclusion: "not_determined",
      });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  },
);

it("uses API context assessment and resume in one request without rebuilding scope", async () => {
  const interaction = errorFeedback("SCRY_BROWSER_DISABLED");
  const resume = { status: "available", originalMissionFacts: { title: "Existing goal" } };
  const f = vi.fn(async () =>
    Response.json({ ready: false, blocked: ["browser"], interaction, resume }),
  );
  vi.stubGlobal("fetch", f);
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: "get_testing_context", arguments: { projectId: id } });
    expect(r.structuredContent).toMatchObject({
      interaction,
      resume,
      message: interaction.summary,
    });
    expect(f).toHaveBeenCalledTimes(1);
  } finally {
    await close();
  }
});

it.each([true, false])(
  "reuses the existing incomplete-stop status receipt (released=%s)",
  async (released) => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        paths.push(url);
        return Response.json(
          url.endsWith("/stop")
            ? { replay: false }
            : { terminal: released, pendingCommands: released ? 0 : 1, browserReleased: released },
        );
      }),
    );
    const { client, close } = await connect();
    try {
      const r = await client.callTool({
        name: "finish_incomplete_run",
        arguments: { runId: id, confirmed: true, conclusion: "Authorized attempt stop" },
      });
      expect(r.structuredContent).toMatchObject({
        interaction: {
          state: released ? "release_confirmed" : "release_pending",
          next: released ? { actor: "none", action: "none" } : { tool: "get_run_status" },
        },
      });
      expect(paths).toEqual([
        `http://fixture.test/api/runs/${id}/stop`,
        `http://fixture.test/api/runs/${id}/status`,
      ]);
      expect((r.structuredContent as any).message).toContain(
        released ? "no immediate status reread" : "Check",
      );
    } finally {
      await close();
    }
  },
);

it.each(["queued", "running"])(
  "keeps %s action checkpoints pending on their original command without a status read",
  async (state) => {
    const paths: string[] = [];
    let current: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        paths.push(url);
        return Response.json(current);
      }),
    );
    const { client, close } = await connect();
    try {
      for (const execution of ["unknown", "completed", "tool_error"]) {
        const prefix = {
          execution,
          reason: execution === "unknown" ? "dispatch_started" : "sequence_prefix",
          receipts: [
            { actionId: "first-known-action", execution: "completed", observation: "available" },
          ],
        };
        current = { id, runId: id, state, result: prefix };
        const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
        expect(r.isError).toBe(false);
        expect(r.structuredContent).toMatchObject({
          command: {
            id,
            state,
            result: prefix,
            interaction: {
              state: "pending",
              next: { action: "retrieve_existing_command", tool: "get_command" },
            },
          },
        });
        expect((r.structuredContent as any).command.result).toEqual(prefix);
      }
      expect(paths).toEqual(Array(3).fill(`http://fixture.test/api/browser-commands/${id}`));
    } finally {
      await close();
    }
  },
);

it.each(["available", "unavailable"])(
  "preserves acknowledged action truth after later command failure (observation=%s)",
  async (observation) => {
    const receipt = {
      execution: "completed",
      businessOutcome: "unverified",
      observation,
      content: [{ type: "text", text: "Saved action receipt" }],
      receipts: [{ actionId: "one-completed-effect", execution: "completed" }],
    };
    const f = vi.fn(async () => Response.json({ id, runId: id, state: "failed", result: receipt }));
    vi.stubGlobal("fetch", f);
    const { client, close } = await connect();
    try {
      const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        command: {
          id,
          state: "failed",
          result: receipt,
          interaction: {
            state: "action_complete_command_failed",
            applicationConclusion: "not_determined",
            next:
              observation === "available"
                ? { action: "use_returned_observation" }
                : { action: "inspect_run_release", tool: "get_run_status" },
          },
        },
      });
      expect((r.structuredContent as any).command.result).toEqual(receipt);
      expect((r.structuredContent as any).message).toContain("do not repeat the action");
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  },
);

it("retains an authoritative predispatch refusal as not dispatched without replay or quarantine", async () => {
  const refusal = {
    execution: "not_dispatched",
    businessOutcome: "not_dispatched",
    reason: "sequence_observation_changed",
    scopeRestrictionObserved: true,
    scopeRestrictionImpact: "unknown",
    scopeDiagnostics: { count: 1, activity: "idle" },
  };
  const f = vi.fn(async () => Response.json({ id, runId: id, state: "failed", result: refusal }));
  vi.stubGlobal("fetch", f);
  const { client, close } = await connect();
  try {
    const r = await client.callTool({ name: "get_command", arguments: { commandId: id } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      command: {
        id,
        result: refusal,
        interaction: {
          state: "not_dispatched",
          applicationConclusion: "not_determined",
          next: { actor: "agent", action: "review_recorded_refusal" },
        },
      },
    });
    expect((r.structuredContent as any).command.result).toEqual(refusal);
    expect((r.structuredContent as any).command.interaction.next).not.toHaveProperty("tool");
    expect((r.structuredContent as any).message).toContain("not permission to retry");
    expect(f).toHaveBeenCalledTimes(1);
  } finally {
    await close();
  }
});

it.each(["unavailable", "rejected", "partial", "not_provided"])(
  "keeps a completed Mission's partial %s report resume and points to its exact saved report",
  async (reportState) => {
    const reportId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const resume = {
      status: "partial",
      originalMissionFacts: {
        finalReportId: reportId,
        instruction: "Review previously authorized checks",
      },
      reportFacts: { state: reportState, checks: [] },
      parts: { report: "unavailable" },
    };
    const context = {
      ready: false,
      blocked: ["active_mission_selection_required"],
      selected: { mission: { id, state: "completed", finalReportId: reportId } },
      resume,
    };
    const interaction = contextFeedback(context);
    const f = vi.fn(async () => Response.json({ ...context, interaction }));
    vi.stubGlobal("fetch", f);
    const { client, close } = await connect();
    try {
      const r = await client.callTool({
        name: "get_testing_context",
        arguments: { projectId: id, missionId: id },
      });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({
        resume,
        selected: { mission: { finalReportId: reportId } },
        interaction: {
          state: "follow_up_required",
          next: { actor: "agent", action: "read_saved_report", tool: "get_report" },
        },
      });
      expect((r.structuredContent as any).resume).toEqual(resume);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  },
);
