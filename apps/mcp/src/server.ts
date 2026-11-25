import { toolAuthMetadata } from "./oauth-discovery.js";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  bindBrowserProtectedInputsSchema,
  createBrowserEnvironmentSchema,
  createBrowserFlowSchema,
  createBrowserProtectedInputSchema,
  createBrowserObjectiveSchema,
  finalizeBrowserRunSchema,
  publishBrowserMissionReportSchema,
  startBrowserMissionSchema,
  startBrowserRunSchema,
  browserCommandSchema,
  resolveBrowserRuntime,
} from "@scry/contracts";
import { z } from "zod";

import { BrowserApiClient } from "./api-client.js";
import { browserErrorEnvelopeCapability } from "./browser-tool-error.js";
import {
  registerSavedReportTools,
  reportNavigation,
  reportNavigationSchema,
} from "./saved-report-tools.js";
import { reportingInstructions } from "./reporting-guidance.js";
import { customerWorkflowInstructions } from "./customer-workflow.js";
import { nativeWorkflowGuidance } from "./native-workflow.js";
import { registerAgentWorkflowTools } from "./agent-workflow-tools.js";
import { registerBrowserSequence } from "./browser-sequence.js";
import { registerTestResourceTools, testResourceInstructions } from "./test-resource-tools.js";
import { nativeCommandResult, registerNativeBrowserTools } from "./native-browser-tools.js";
import {
  idempotentDurableWrite,
  localFactualRead,
  stableKey,
  toolResult,
  uuid,
} from "./tool-registry.js";

const message = z.string();

const INSTRUCTIONS =
  "Use one Mission for one user objective. Before starting a Mission, list the Project's Missions and resume a matching active Mission when one exists. Before starting a Run, list that Project's Environments and select the active scope whose origins match the assigned application. When no matching Environment exists, create one from the application's origins in the user's explicit Mission assignment; do not send the user away to configure routine execution scope. Do not add unrelated origins or silently move between test and live applications. Every Run receives an immutable origin and disclosure snapshot, so later Environment creation cannot broaden an active Run. You may create any number of Flows inside that Mission whenever distinct work streams, retries, resumptions, experiments, or approaches help; Flows are not restricted to alternatives and creating another Flow does not abandon the Mission. Every Run belongs to exactly one Flow revision. Observe current Mission facts before deciding what to do. The agent chooses browser actions and judges task completion. Mutation truth, owner fencing, protected values, evidence capture, and publication are mechanical invariants. UNKNOWN means a mutation may have happened: never replay it; reconcile or stop accurately. Protected references are opaque and must never be requested as plaintext. Each Run exposes the Environment's immutable disclosure mode. When authentication is required, never guess credentials and never select a saved credential merely because its name appears unique, similar, or obvious. You may list safe credential metadata to present choices, but every binding requires an explicit current-user choice. Offer the matching saved candidates, Create a new credential in Project settings, or explicitly provide a new value to this agent. Only after that choice may you bind the selected opaque references to the active Run. In confidential mode, selected outputs remain protected. In trusted_application_output mode, the single protection authority may release selected ordinary values but protected lineage and high-confidence secret findings always veto public release. After reading a durable capture's structural index, propose an output meaning and exact path. Bind user-supplied protected references to the Run with protectedInputIds, then use those IDs only in protected fills. Every navigate, observe, fill, and read-only click is already preserved by the continuous authenticated session recorder, including resulting DOM changes; do not create a protected capture merely to prove a read-only result. Every commit creates its own HTTP capture. Settle that capture before creating a later DOM capture for the same effect. For a passing Run, determine every commit's factual outcome before finalizing. For a failed, blocked, cancelled, or environment-failed Run, finalization closes the browser, proves undispatched effects not-applied, preserves any post-dispatch uncertainty as UNKNOWN, and permits an evidence-backed failure report; it never redispatches. Every durable protected capture must still be published or discarded before any finalization. capture_dom is only for an operation-owned protected result region associated with an acknowledged mutation effect. Publication retains detected or agent-selected protected values as opaque references and destroys unselected ordinary data with the raw capture. Discard performs no field interpretation and creates no handles; it destroys the encrypted capture and records only a safe tombstone. Publish a report only after every required Objective and Run is terminal with durable evidence.";

export function createBrowserMcpServer(client = new BrowserApiClient()) {
  const native = resolveBrowserRuntime(process.env) === "playwright_mcp";
  const navigation = reportNavigation();
  const workflowGuidance = native
    ? nativeWorkflowGuidance
    : `${customerWorkflowInstructions}\n\n${INSTRUCTIONS}\n\n${testResourceInstructions}\n\n${reportingInstructions}`;
  const server = new McpServer(
    { name: "scry-browser", version: "baseline" },
    {
      // Codex charges namespace instructions per tool against a shared plugin budget.
      // Deliver complete guidance through discovery/preflight instead of repeating it per tool.
      instructions: "Use list_projects.",
      capabilities: { experimental: { [browserErrorEnvelopeCapability]: { version: 1 } } },
    },
  );
  registerLifecycleTools(server, client, native, navigation, workflowGuidance);
  registerAgentWorkflowTools(server, client, native, workflowGuidance);
  registerSavedReportTools(server, client, navigation);
  registerBrowserCommandTools(server, client, native);
  if (native) {
    registerNativeBrowserTools(server, client, awaitCommand);
    registerBrowserSequence(server, client, awaitCommand);
  }
  registerTestResourceTools(server, client);
  return server;
}

function registerBrowserCommandTools(
  server: McpServer,
  client: BrowserApiClient,
  native = false,
): void {
  if (!native)
    server.registerTool(
      "command",
      {
        title: "Issue browser command",
        description:
          "Queue one agent-chosen browser command for the Run's durable worker owner. Observe returns opaque current-document control and result-region references. Navigate, observe, fill, and read-only click results are continuously recorded as authenticated session evidence, so read-only verification needs no capture_dom. Navigate is origin-scoped. Public fill values are encrypted at rest; protected fills take only a scoped protectedValueId. Every successful commit creates its own HTTP capture and returns a sanitized successorObservation after the page's response handler settles; use that observation before deciding whether another effect is needed. Settle the capture before adding a DOM capture for the same effect, and determine the factual mutation outcome of every commit before a successful close. Close refuses SCRY_BROWSER_EFFECT_OUTCOME_PENDING without destroying the live context. close_for_failure is reserved for terminal failure handling: it proves undispatched work not-applied and preserves post-dispatch uncertainty as UNKNOWN without replay. Commit permits and captures exactly the first same-origin write caused by the chosen control while blocking every additional write. Capture_dom durably captures only an operation-owned protected result region associated with an acknowledged mutation effect; it is not used for read-only evidence. Every protected capture must be settled before close: publish_capture atomically publishes selected outputs and opaque protected references before destroying raw evidence; discard_capture destroys an unneeded capture without interpreting fields or creating handles. UNKNOWN prohibits replay.",
        inputSchema: { browserSessionId: uuid, command: browserCommandSchema },
        outputSchema: {
          message,
          commandId: uuid,
          replay: z.boolean(),
          state: z.string(),
          command: z.record(z.string(), z.unknown()).optional(),
        },
        _meta: toolAuthMetadata(),
        annotations: idempotentDurableWrite,
      },
      async ({ browserSessionId, command }) => {
        const submitted = await client.post<{ commandId: string; replay: boolean; state: string }>(
          `/browser-sessions/${browserSessionId}/commands`,
          {
            command,
            idempotencyKey: `mcp-browser-command-${randomUUID()}`,
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
            : "Browser command remains queued or running after the bounded wait. Read its durable result with get_command.",
        );
      },
    );

  server.registerTool(
    "get_command",
    {
      title: "Get browser command result",
      description: native
        ? "Read a durable command status, preserved action receipt and any authorized screenshot. Queued or running work must not be replaced by repeating the action. Errors and uncertainty remain explicit."
        : "Read one durable browser command result. A completed observe or navigation returns current-document opaque control references. A failed command remains factual history; do not invent a successful action.",
      inputSchema: { commandId: uuid },
      outputSchema: { message, command: z.record(z.string(), z.unknown()) },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ commandId }) =>
      native
        ? nativeCommandResult(client, await client.get(`/browser-commands/${commandId}`))
        : toolResult(
            { command: await client.get(`/browser-commands/${commandId}`) },
            "Browser command facts loaded.",
          ),
  );
}

async function awaitCommand(
  client: BrowserApiClient,
  commandId: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const command = await client.get<Record<string, unknown>>(`/browser-commands/${commandId}`);
    if (command.state === "completed" || command.state === "failed") return command;
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return undefined;
}

function registerLifecycleTools(
  server: McpServer,
  client: BrowserApiClient,
  native: boolean,
  navigation: ReturnType<typeof reportNavigation>,
  workflowGuidance: string,
): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "Discover accessible Projects, including empty accounts. Read required Scry workflow guidance in the returned message. Use get_testing_context before testing.",
      inputSchema: {},
      outputSchema: {
        message,
        projects: z.array(z.record(z.string(), z.unknown())),
      },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async () =>
      toolResult(
        {
          projects: await client.get<Array<Record<string, unknown>>>("/projects"),
        },
        `Projects loaded.\n\n${workflowGuidance}`,
      ),
  );

  server.registerTool(
    "list_missions",
    {
      title: "List Project Missions",
      description:
        "List current and completed Missions for one Project so a fresh or resumed agent can continue the same user objective instead of creating a duplicate Mission.",
      inputSchema: { projectId: uuid },
      outputSchema: { message, missions: z.array(z.record(z.string(), z.unknown())) },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ projectId }) =>
      toolResult(
        {
          missions: (await client.get(`/projects/${projectId}/missions`)) as Array<
            Record<string, unknown>
          >,
        },
        "Project Missions loaded.",
      ),
  );

  server.registerTool(
    "list_environments",
    {
      title: "List Project Environments",
      description:
        "List Project Environments and their origin scope, disclosure and state. Reuse an active match; create_environment only for assigned origins.",
      inputSchema: { projectId: uuid },
      outputSchema: { message, environments: z.array(z.record(z.string(), z.unknown())) },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ projectId }) =>
      toolResult(
        {
          environments: (await client.get(`/projects/${projectId}/environments`)) as Array<
            Record<string, unknown>
          >,
        },
        "Project Environments loaded.",
      ),
  );

  const createEnvironmentInput = createBrowserEnvironmentSchema.omit({
    projectId: true,
    idempotencyKey: true,
  });
  server.registerTool(
    "create_environment",
    {
      title: "Create Project Environment",
      description:
        "Create/reuse routine Environment setup from user-assigned origins; do not ask the user to configure it manually. Never broaden an active Run or infer live origins.",
      inputSchema: { projectId: uuid, ...createEnvironmentInput.shape },
      outputSchema: { message, environmentId: uuid, replay: z.boolean() },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async ({ projectId, ...input }) =>
      toolResult(
        await client.post(`/projects/${projectId}/environments`, {
          ...input,
          idempotencyKey: stableKey("browser-environment", { projectId, ...input }),
        }),
        "Environment is ready for a Run. Its origin and disclosure scope will be snapshotted when the Run starts.",
      ),
  );

  server.registerTool(
    "list_credentials",
    {
      title: "List Project Credentials",
      description:
        "List safe Project credential metadata; never infer first-use permission from names. Require current-user selection before binding.",
      inputSchema: { projectId: uuid },
      outputSchema: { message, credentials: z.array(z.record(z.string(), z.unknown())) },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ projectId }) =>
      toolResult(
        {
          credentials: (await client.get(`/projects/${projectId}/protected-inputs`)) as Array<
            Record<string, unknown>
          >,
        },
        "Credential metadata loaded. User choice is still required before first use.",
      ),
  );

  const createCredentialInput = createBrowserProtectedInputSchema.omit({
    projectId: true,
    expiresInSeconds: true,
  });
  server.registerTool(
    "create_credential",
    {
      title: "Create Project Credential",
      description:
        "Encrypt a credential only if the user explicitly chooses to provide plaintext here. Prefer Project settings to keep it from the model/host. Never returns the value.",
      inputSchema: { projectId: uuid, ...createCredentialInput.shape },
      outputSchema: { message, protectedValueId: uuid, replay: z.boolean() },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async ({ projectId, ...input }) =>
      toolResult(
        await client.post(`/projects/${projectId}/protected-inputs`, {
          ...input,
          expiresInSeconds: null,
        }),
        "Credential encrypted and stored. Scry did not return its value.",
      ),
  );

  server.registerTool(
    "bind_credentials",
    {
      title: "Bind Selected Credentials to Run",
      description:
        "Bind only explicitly selected opaque references to an active Run. Never choose by name. Generated references require the same Mission/Environment and permitted uses.",
      inputSchema: { runId: uuid, ...bindBrowserProtectedInputsSchema.shape },
      outputSchema: {
        message,
        browserSessionId: uuid,
        protectedInputIds: z.array(uuid),
        added: z.number().int().nonnegative(),
        replay: z.boolean(),
      },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async ({ runId, ...input }) =>
      toolResult(
        await client.post(`/runs/${runId}/protected-inputs`, input),
        "The user-selected credentials are now available to this Run as opaque references.",
      ),
  );

  const startMissionInput = startBrowserMissionSchema.omit({ idempotencyKey: true });
  server.registerTool(
    "start_mission",
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
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async (input) =>
      toolResult(
        await client.post("/missions", {
          ...input,
          idempotencyKey: stableKey("browser-mission", input),
        }),
        "Mission started.",
      ),
  );

  const objectiveInput = createBrowserObjectiveSchema.omit({ idempotencyKey: true });
  server.registerTool(
    "create_objective",
    {
      title: "Create Mission Objective",
      description: "Add an independently assessable completion objective to the current Mission.",
      inputSchema: { missionId: uuid, ...objectiveInput.shape },
      outputSchema: { message, objectiveId: uuid, replay: z.boolean() },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, ...input }) =>
      toolResult(
        await client.post(`/missions/${missionId}/objectives`, {
          ...input,
          idempotencyKey: stableKey("browser-objective", { missionId, ...input }),
        }),
        "Objective created.",
      ),
  );

  const flowInput = createBrowserFlowSchema.omit({ idempotencyKey: true });
  server.registerTool(
    "create_flow",
    {
      title: "Create Mission Flow",
      description:
        "Create a Flow at the agent's discretion within the same Mission; it does not need to be an alternative to another Flow.",
      inputSchema: { missionId: uuid, ...flowInput.shape },
      outputSchema: { message, flowId: uuid, flowRevisionId: uuid, replay: z.boolean() },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, ...input }) =>
      toolResult(
        await client.post(`/missions/${missionId}/flows`, {
          ...input,
          idempotencyKey: stableKey("browser-flow", { missionId, ...input }),
        }),
        "Flow created within the Mission.",
      ),
  );

  const startRunInput = startBrowserRunSchema.omit({ idempotencyKey: true }).extend({
    attemptId: z
      .string()
      .min(8)
      .max(256)
      .optional()
      .describe(
        "Identity of this intended attempt. Use a new value for a deliberate new attempt in the same Flow; reuse it only to recover this exact start request. Omit only for compatibility with an older single-attempt client.",
      ),
  });
  server.registerTool(
    "start_run",
    {
      title: "Start Flow Run",
      description:
        "Start/recover an attempt for the selected Flow and Environment. Reuse attemptId and identical inputs after lost replies; new identity means deliberately new work. Bind only explicitly selected credentials. Reuse returned browserSessionId.",
      inputSchema: startRunInput.shape,
      outputSchema: { message, runId: uuid, browserSessionId: uuid, replay: z.boolean() },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async (input) => {
      const { attemptId, ...run } = input;
      return toolResult(
        await client.post("/runs", {
          ...run,
          idempotencyKey: stableKey("browser-run", attemptId === undefined ? run : input),
        }),
        "Run started and queued.",
      );
    },
  );

  server.registerTool(
    "get_mission",
    {
      title: "Observe browser Mission",
      description:
        "Read the Mission, Objectives, all agent-created Flows, Runs, browser session ownership, and durable outcomes before choosing the next action. Before asking the customer, review their earlier answers and available tools; reuse applicable inputs and continue independent checks. Own routine Scry setup. Ask only for genuinely missing decisions or required human actions, in plain English with the exact action, why it is needed and what can continue. Never infer new approval or ask the customer to debug Scry.",
      inputSchema: { missionId: uuid },
      outputSchema: {
        message,
        mission: z.record(z.string(), z.unknown()),
        ...reportNavigationSchema,
      },
      _meta: toolAuthMetadata(),
      annotations: localFactualRead,
    },
    async ({ missionId }) => {
      const mission = await client.get<Record<string, unknown>>(`/missions/${missionId}`);
      return toolResult(
        { mission, ...navigation(mission.finalReportId) },
        "Mission facts loaded. Read the saved report with get_report before reviewing its results.",
      );
    },
  );

  server.registerTool(
    "finalize_run",
    {
      title: "Finalize browser Run",
      description: native
        ? "Finish the Run after checking the actual application outcome. The API closes the browser, admits native recording evidence and finalizes its coverage. A passed Run requires complete evidence; failures retain an honest prefix. Never repeat an uncertain action to finish. If recovery advances the owner generation, refresh get_mission and use that factual current generation."
        : "Finalize a Run after every protected capture is settled. Passing finalization requires every commit outcome to be resolved. Non-passing finalization automatically proves pre-dispatch work not-applied, preserves post-dispatch uncertainty as UNKNOWN, closes the browser, and completes authenticated evidence so the terminal failure can be reported without redispatch.",
      inputSchema: { runId: uuid, ...finalizeBrowserRunSchema.shape },
      outputSchema: { message, replay: z.boolean() },
      _meta: toolAuthMetadata(),
      annotations: { ...idempotentDurableWrite, destructiveHint: true },
    },
    async ({ runId, ...input }) =>
      toolResult(await client.post(`/runs/${runId}/finalize`, input), "Run finalized."),
  );

  server.registerTool(
    "publish_mission_report",
    {
      title: "Publish Mission report",
      description:
        "Publish the tested application report after terminal work using returned workflowGuidance. Preview customer presentation first; preserve evidence, unresolved/excluded checks, cleanup and limitations. Publication is immutable; idempotent replay returns the existing report.",
      inputSchema: { missionId: uuid, ...publishBrowserMissionReportSchema.shape },
      outputSchema: { message, reportId: uuid, replay: z.boolean(), ...reportNavigationSchema },
      _meta: toolAuthMetadata(),
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, ...input }) => {
      const published = await client.post<{ reportId: string; replay: boolean }>(
        `/missions/${missionId}/report`,
        input,
      );
      return toolResult(
        { ...published, ...navigation(published.reportId) },
        "Mission report published. Dashboard links require sign-in; evidence availability is not a claim of visual review.",
      );
    },
  );
}
