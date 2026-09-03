import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createBrowserFlowV2Schema,
  createBrowserObjectiveV2Schema,
  finalizeBrowserRunV2Schema,
  publishBrowserMissionReportV2Schema,
  startBrowserMissionV2Schema,
  startBrowserRunV2Schema,
  browserCommandV2Schema,
} from "@scry/contracts";
import { z } from "zod";

import { BrowserV2ApiClient } from "./browser-v2-api-client.js";
import {
  idempotentDurableWrite,
  localFactualRead,
  stableKey,
  toolResult,
  uuid,
} from "./tool-registry.js";

const message = z.string();

const INSTRUCTIONS =
  "Use one Mission for one user objective. Before starting a Mission, list the Project's Missions and resume a matching active Mission when one exists. Before starting a Run, list that Project's approved Environments and select the active scope whose origins match the assigned application. You may create any number of Flows inside that Mission whenever distinct work streams, retries, resumptions, experiments, or approaches help; Flows are not restricted to alternatives and creating another Flow does not abandon the Mission. Every Run belongs to exactly one Flow revision. Observe current Mission facts before deciding what to do. The agent chooses browser actions and judges task completion. Mutation truth, owner fencing, protected values, evidence capture, and publication are mechanical invariants. UNKNOWN means a mutation may have happened: never replay it; reconcile or stop accurately. Protected references are opaque and must never be requested as plaintext. Each Run exposes the Environment's immutable disclosure mode. The agent can discover approved Environments but cannot create or broaden them. In confidential mode, selected outputs remain protected. In trusted_application_output mode, the single protection authority may release selected ordinary values but protected lineage and high-confidence secret findings always veto public release. After reading a durable capture's structural index, propose an output meaning and exact path. Bind user-supplied protected references to the Run with protectedInputIds, then use those IDs only in protected fills. Every navigate, observe, fill, and read-only click is already preserved by the continuous authenticated session recorder, including resulting DOM changes; do not create a protected capture merely to prove a read-only result. Every commit creates its own HTTP capture. Settle that capture before creating a later DOM capture for the same effect. For a passing Run, determine every commit's factual outcome before finalizing. For a failed, blocked, cancelled, or environment-failed Run, finalization closes the browser, proves undispatched effects not-applied, preserves any post-dispatch uncertainty as UNKNOWN, and permits an evidence-backed failure report; it never redispatches. Every durable protected capture must still be published or discarded before any finalization. capture_dom is only for an operation-owned protected result region associated with an acknowledged mutation effect. Publication retains detected or agent-selected protected values as opaque references and destroys unselected ordinary data with the raw capture. Discard performs no field interpretation and creates no handles; it destroys the encrypted capture and records only a safe tombstone. Publish a report only after every required Objective and Run is terminal with durable evidence.";

export function createBrowserV2McpServer(client = new BrowserV2ApiClient()) {
  const server = new McpServer(
    { name: "scry-browser-v2", version: "2.7.0" },
    { instructions: INSTRUCTIONS },
  );
  registerLifecycleTools(server, client);
  registerBrowserCommandTools(server, client);
  return server;
}

function registerBrowserCommandTools(server: McpServer, client: BrowserV2ApiClient): void {
  server.registerTool(
    "browser_v2_command",
    {
      title: "Issue browser command",
      description:
        "Queue one agent-chosen browser command for the Run's durable worker owner. Observe returns opaque current-document control and result-region references. Navigate, observe, fill, and read-only click results are continuously recorded as authenticated session evidence, so read-only verification needs no capture_dom. Navigate is origin-scoped. Public fill values are encrypted at rest; protected fills take only a scoped protectedValueId. Every successful commit creates its own HTTP capture and returns a sanitized successorObservation after the page's response handler settles; use that observation before deciding whether another effect is needed. Settle the capture before adding a DOM capture for the same effect, and determine the factual mutation outcome of every commit before a successful close. Close refuses BROWSER_V2_EFFECT_OUTCOME_PENDING without destroying the live context. close_for_failure is reserved for terminal failure handling: it proves undispatched work not-applied and preserves post-dispatch uncertainty as UNKNOWN without replay. Commit permits and captures exactly the first same-origin write caused by the chosen control while blocking every additional write. Capture_dom durably captures only an operation-owned protected result region associated with an acknowledged mutation effect; it is not used for read-only evidence. Every protected capture must be settled before close: publish_capture atomically publishes selected outputs and opaque protected references before destroying raw evidence; discard_capture destroys an unneeded capture without interpreting fields or creating handles. UNKNOWN prohibits replay.",
      inputSchema: { browserSessionId: uuid, command: browserCommandV2Schema },
      outputSchema: {
        message,
        commandId: uuid,
        replay: z.boolean(),
        state: z.string(),
        command: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: idempotentDurableWrite,
    },
    async ({ browserSessionId, command }) => {
      const submitted = await client.post<{ commandId: string; replay: boolean; state: string }>(
        `/v2/browser-sessions/${browserSessionId}/commands`,
        {
          command,
          idempotencyKey: `mcp-browser-v2-command-${randomUUID()}`,
        },
      );
      const completed = await awaitCommand(client, submitted.commandId, 30_000);
      return toolResult(
        {
          ...submitted,
          state: completed?.state ?? submitted.state,
          ...(completed ? { command: completed } : {}),
        },
        completed
          ? "Browser command reached a durable terminal state."
          : "Browser command remains queued or running after the bounded wait. Read its durable result with browser_v2_get_command.",
      );
    },
  );

  server.registerTool(
    "browser_v2_get_command",
    {
      title: "Get browser command result",
      description:
        "Read one durable browser command result. A completed observe or navigation returns current-document opaque control references. A failed command remains factual history; do not invent a successful action.",
      inputSchema: { commandId: uuid },
      outputSchema: { message, command: z.record(z.string(), z.unknown()) },
      annotations: localFactualRead,
    },
    async ({ commandId }) =>
      toolResult(
        { command: await client.get(`/v2/browser-commands/${commandId}`) },
        "Browser command facts loaded.",
      ),
  );
}

async function awaitCommand(
  client: BrowserV2ApiClient,
  commandId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const command = await client.get<Record<string, unknown>>(`/v2/browser-commands/${commandId}`);
    if (command.state === "completed" || command.state === "failed") return command;
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return undefined;
}

function registerLifecycleTools(server: McpServer, client: BrowserV2ApiClient): void {
  server.registerTool(
    "browser_v2_list_projects",
    {
      title: "List Projects",
      description:
        "List Projects visible to the current MCP identity before choosing Mission scope.",
      inputSchema: {},
      outputSchema: { message, projects: z.array(z.record(z.string(), z.unknown())) },
      annotations: localFactualRead,
    },
    async () =>
      toolResult(
        { projects: await client.get<Array<Record<string, unknown>>>("/v2/projects") },
        "Projects loaded.",
      ),
  );

  server.registerTool(
    "browser_v2_list_missions",
    {
      title: "List Project Missions",
      description:
        "List current and completed Missions for one Project so a fresh or resumed agent can continue the same user objective instead of creating a duplicate Mission.",
      inputSchema: { projectId: uuid },
      outputSchema: { message, missions: z.array(z.record(z.string(), z.unknown())) },
      annotations: localFactualRead,
    },
    async ({ projectId }) =>
      toolResult(
        {
          missions: (await client.get(`/v2/projects/${projectId}/missions`)) as Array<
            Record<string, unknown>
          >,
        },
        "Project Missions loaded.",
      ),
  );

  server.registerTool(
    "browser_v2_list_environments",
    {
      title: "List Project Environments",
      description:
        "List the approved Environments visible in one Project, including immutable origin scope, disclosure mode, and active or disabled state. Use an active matching Environment when starting a Run. This tool cannot create or broaden an Environment.",
      inputSchema: { projectId: uuid },
      outputSchema: { message, environments: z.array(z.record(z.string(), z.unknown())) },
      annotations: localFactualRead,
    },
    async ({ projectId }) =>
      toolResult(
        {
          environments: (await client.get(`/v2/projects/${projectId}/environments`)) as Array<
            Record<string, unknown>
          >,
        },
        "Project Environments loaded.",
      ),
  );

  const startMissionInput = startBrowserMissionV2Schema.omit({ idempotencyKey: true });
  server.registerTool(
    "browser_v2_start_mission",
    {
      title: "Start browser Mission",
      description:
        "Create one durable Mission and its first agent session. Reuse the returned Mission for all work serving the same user objective.",
      inputSchema: startMissionInput.shape,
      outputSchema: {
        message,
        missionId: uuid,
        agentSessionId: uuid,
        replay: z.boolean(),
      },
      annotations: idempotentDurableWrite,
    },
    async (input) =>
      toolResult(
        await client.post("/v2/missions", {
          ...input,
          idempotencyKey: stableKey("browser-v2-mission", input),
        }),
        "Mission started.",
      ),
  );

  const objectiveInput = createBrowserObjectiveV2Schema.omit({ idempotencyKey: true });
  server.registerTool(
    "browser_v2_create_objective",
    {
      title: "Create Mission Objective",
      description: "Add an independently assessable completion objective to the current Mission.",
      inputSchema: { missionId: uuid, ...objectiveInput.shape },
      outputSchema: { message, objectiveId: uuid, replay: z.boolean() },
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, ...input }) =>
      toolResult(
        await client.post(`/v2/missions/${missionId}/objectives`, {
          ...input,
          idempotencyKey: stableKey("browser-v2-objective", { missionId, ...input }),
        }),
        "Objective created.",
      ),
  );

  const flowInput = createBrowserFlowV2Schema.omit({ idempotencyKey: true });
  server.registerTool(
    "browser_v2_create_flow",
    {
      title: "Create Mission Flow",
      description:
        "Create a Flow at the agent's discretion inside the same Mission. A Flow can represent any useful work stream, retry, resumption, investigation, or approach; it does not need to be an alternative to another Flow.",
      inputSchema: { missionId: uuid, ...flowInput.shape },
      outputSchema: { message, flowId: uuid, flowRevisionId: uuid, replay: z.boolean() },
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, ...input }) =>
      toolResult(
        await client.post(`/v2/missions/${missionId}/flows`, {
          ...input,
          idempotencyKey: stableKey("browser-v2-flow", { missionId, ...input }),
        }),
        "Flow created within the Mission.",
      ),
  );

  const startRunInput = startBrowserRunV2Schema.omit({ idempotencyKey: true });
  server.registerTool(
    "browser_v2_start_run",
    {
      title: "Start Flow Run",
      description:
        "Start one browser Run under exactly one current Flow revision. Bind any user-supplied opaque protected input IDs needed by this Run. This queues a browser owner but does not itself dispatch an external application mutation.",
      inputSchema: startRunInput.shape,
      outputSchema: { message, runId: uuid, browserSessionId: uuid, replay: z.boolean() },
      annotations: idempotentDurableWrite,
    },
    async (input) =>
      toolResult(
        await client.post("/v2/runs", {
          ...input,
          idempotencyKey: stableKey("browser-v2-run", input),
        }),
        "Run started and queued.",
      ),
  );

  server.registerTool(
    "browser_v2_get_mission",
    {
      title: "Observe browser Mission",
      description:
        "Read the Mission, Objectives, all agent-created Flows, Runs, browser session ownership, and durable outcomes before choosing the next action.",
      inputSchema: { missionId: uuid },
      outputSchema: { message, mission: z.record(z.string(), z.unknown()) },
      annotations: localFactualRead,
    },
    async ({ missionId }) =>
      toolResult(
        { mission: await client.get(`/v2/missions/${missionId}`) },
        "Mission facts loaded.",
      ),
  );

  server.registerTool(
    "browser_v2_finalize_run",
    {
      title: "Finalize browser Run",
      description:
        "Finalize a Run after every protected capture is settled. Passing finalization requires every commit outcome to be resolved. Non-passing finalization automatically proves pre-dispatch work not-applied, preserves post-dispatch uncertainty as UNKNOWN, closes the browser, and completes authenticated evidence so the terminal failure can be reported without redispatch.",
      inputSchema: { runId: uuid, ...finalizeBrowserRunV2Schema.shape },
      outputSchema: { message, replay: z.boolean() },
      annotations: idempotentDurableWrite,
    },
    async ({ runId, ...input }) =>
      toolResult(await client.post(`/v2/runs/${runId}/finalize`, input), "Run finalized."),
  );

  server.registerTool(
    "browser_v2_publish_mission_report",
    {
      title: "Publish Mission report",
      description:
        "Publish the final safe Mission report. The API derives its evidence digest from complete authenticated Run evidence; the agent cannot supply or invent that digest.",
      inputSchema: { missionId: uuid, ...publishBrowserMissionReportV2Schema.shape },
      outputSchema: { message, reportId: uuid, replay: z.boolean() },
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, ...input }) =>
      toolResult(
        await client.post(`/v2/missions/${missionId}/report`, input),
        "Mission report published.",
      ),
  );
}
