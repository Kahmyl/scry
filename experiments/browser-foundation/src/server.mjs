import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnection } from "@playwright/mcp";
import Ajv from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { Coordinator, allowedTools } from "./coordinator.mjs";
import { observationTools } from "./action-kind.mjs";

// Private stdio transport: the launching owner supplies the workspace/environment
// policy. There is deliberately no unauthenticated HTTP listener or production hook.
const config = JSON.parse(readFileSync(process.env.SCRY_CANDIDATE_CONFIG, "utf8"));
const coordinator = new Coordinator(config);
await coordinator.recover();
for (const [environment, values] of Object.entries(config.secrets ?? {}))
  for (const [id, value] of Object.entries(values))
    coordinator.store.putSecret(environment, id, value);
const probe = await createConnection(
  { webmcp: false, capabilities: ["core", "vision"] },
  async () => {
    throw new Error("METADATA_ONLY");
  },
);
const [a, b] = InMemoryTransport.createLinkedPair();
await probe.connect(b);
const probeClient = new Client({ name: "scry-tool-schema", version: "experiment" });
await probeClient.connect(a);
const definitions = (await probeClient.listTools()).tools.filter((t) => allowedTools.has(t.name));
await probeClient.close();
await probe.close();
if ([...allowedTools].some((name) => !definitions.some((tool) => tool.name === name)))
  throw new Error("UPSTREAM_TOOL_CONTRACT_MISMATCH");
const string = { type: "string", minLength: 1, maxLength: 256 };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const lifecycle = [
  {
    name: "scry_list_environments",
    description:
      "List the environments authorized for this workspace, including the application origins you may test. No internal IDs or configuration-file knowledge is needed before starting.",
    inputSchema: object({}, []),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "scry_start_test",
    description:
      "Start a browser test in an authorized environment. This can change test application data. Returns runId for browser tools.",
    inputSchema: object({ environment: string }),
  },
  {
    name: "scry_test_status",
    description:
      "Read durable action results, findings and recording coverage, including after an interruption. Do not retry an uncertain action automatically.",
    inputSchema: object({ runId: string }),
  },
  {
    name: "scry_finish_test",
    description:
      "Finish a test and retain its native recording and findings, even when the test failed.",
    inputSchema: object({
      runId: string,
      outcome: { type: "string", enum: ["completed", "failed", "blocked"] },
    }),
  },
  {
    name: "scry_cancel_test",
    description:
      "Stop the test browser and preserve partial evidence. An in-flight action may already have changed the application.",
    inputSchema: object({ runId: string }),
  },
  {
    name: "scry_log_finding",
    description:
      "Record an observed problem or inconsistency without asserting that it is necessarily an application defect.",
    inputSchema: object({
      runId: string,
      summary: { type: "string", minLength: 1, maxLength: 2000 },
      classification: {
        type: "string",
        enum: ["observation", "suspected_defect", "scry_failure", "environment_failure"],
      },
    }),
  },
  {
    name: "browser_type_secret",
    description:
      "Type an owner-configured secret by identifier, without returning it. Use a target from the latest snapshot.",
    inputSchema: object(
      {
        runId: string,
        actionId: string,
        target: string,
        secretId: string,
        submit: { type: "boolean" },
      },
      ["runId", "actionId", "target", "secretId"],
    ),
  },
];
const tools = [
  ...lifecycle,
  ...definitions.map((t) => {
    const properties = { ...t.inputSchema.properties };
    delete properties.filename;
    if (t.name === "browser_wait_for")
      properties.time = { ...properties.time, minimum: 0, maximum: 10 };
    return {
      ...t,
      inputSchema: {
        ...t.inputSchema,
        properties: {
          ...properties,
          runId: string,
          actionId: {
            ...string,
            description:
              "Choose a stable ID for this action. Reuse it only to retrieve the same action after a transport retry.",
          },
        },
        required: [
          ...(t.inputSchema.required ?? []).filter((k) => k !== "filename"),
          "runId",
          "actionId",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: observationTools.has(t.name),
        destructiveHint: !observationTools.has(t.name),
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }),
];
const validator = new Ajv({ strict: false, useDefaults: true });
const validate = new Map(tools.map((t) => [t.name, validator.compile(t.inputSchema)]));
const server = new Server(
  { name: "scry-isolated-browser-foundation", version: "experiment" },
  {
    capabilities: { tools: {} },
    instructions:
      "List authorized environments, start a test, use browser snapshots/find and ordinary browser tools, record findings, then finish. Start returns available secret identifiers; type secrets by identifier. Use stable action IDs. A completed tool does not by itself prove the application result: inspect the resulting UI, including application confirmation dialogs and newly opened tabs. Use screenshots when accessibility text omits visual content, such as canvas or rich-editor values. Read test status after interruption; never repeat an uncertain change automatically. Recordings preserve native UI with best-effort black masks, not guaranteed complete redaction. No internal capture or owner-management knowledge is needed.",
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  try {
    if (!validate.get(params.name)?.(args)) throw new Error("INVALID_TOOL_ARGUMENTS");
    if (params.name === "scry_list_environments")
      return reply({
        environments: Object.entries(config.environments)
          .filter(([, policy]) => policy.allowTesting)
          .map(([environment, policy]) => ({ environment, origins: policy.origins })),
      });
    if (params.name === "scry_start_test") return reply(await coordinator.start(args.environment));
    if (params.name === "scry_test_status") return reply(coordinator.status(args.runId));
    if (params.name === "scry_finish_test")
      return reply(await coordinator.finish(args.runId, args.outcome));
    if (params.name === "scry_cancel_test") return reply(await coordinator.cancel(args.runId));
    if (params.name === "scry_log_finding") {
      const row = coordinator.store.run(args.runId, coordinator.workspace);
      const clean = coordinator.live.get(args.runId)?.protection.clean;
      coordinator.store.finding(row.id, coordinator.workspace, {
        summary: clean ? clean(args.summary) : "[Finding text withheld after runtime loss]",
        classification: args.classification,
      });
      return reply({ recorded: true });
    }
    const { runId, actionId, ...input } = args;
    const result = await coordinator.action(runId, actionId, params.name, input);
    const { generation, result: storedResult, ...receipt } = result.receipt;
    return {
      isError: result.isError ?? false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            receipt,
            replay: result.replay ?? false,
            warning: result.warning,
          }),
        },
        ...(result.content ?? []),
      ],
    };
  } catch (error) {
    const allowed =
      /^(RUN_NOT_FOUND|RUN_NOT_ACTIVE|ENVIRONMENT_NOT_AUTHORIZED|CANDIDATE_CAPACITY|ACTION_QUEUE_CAPACITY|ACTION_ID_CONFLICT|INVALID_TOOL_ARGUMENTS|ORIGIN_NOT_ALLOWED|TOOL_NOT_ALLOWED|UNSUPPORTED_ARGUMENT)$/;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: allowed.test(error.message) ? error.message : "CANDIDATE_REQUEST_FAILED",
        },
      ],
    };
  }
});
let shutdown;
async function close() {
  return (shutdown ??= (async () => {
    await coordinator.close();
    await server.close();
    process.exit(0);
  })());
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => void close());
