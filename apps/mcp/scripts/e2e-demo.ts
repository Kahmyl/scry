import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";

const api = new ScryApiClient();
const projects = await api.get<Array<{ id: string; name: string }>>("/projects");
let selected:
  | { projectId: string; environmentId: string; origin: string }
  | undefined;
for (const project of projects) {
  const environments = await api.get<
    Array<{ id: string; baseOrigin: string }>
  >(`/projects/${project.id}/environments`);
  const environment = environments.find(
    (item) => item.baseOrigin === "http://127.0.0.1:4187",
  );
  if (environment) {
    selected = {
      projectId: project.id,
      environmentId: environment.id,
      origin: environment.baseOrigin,
    };
    break;
  }
}
if (!selected) {
  throw new Error(
    "No local Phase 4 environment found. Create http://127.0.0.1:4187 first.",
  );
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createScryMcpServer(api);
const client = new Client({ name: "scry-codex-demo", version: "1.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

const plan = {
  protocolVersion: "2",
  name: "MCP browser verification",
  objective: "Verify that Codex can request and read a durable Scry run.",
  allowedOrigins: [selected.origin],
  budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 1 },
  steps: [
    {
      id: "open",
      title: "Open the MCP fixture",
      action: { type: "navigate", url: "/" },
      after: {
        mode: "all",
        timeoutMs: 15_000,
        conditions: [{ type: "visible", target: { strategy: "text", value: "Phase 6 MCP works", exact: true } }],
      },
      assertions: [
        {
          type: "text",
          target: {
            strategy: "role",
            role: "heading",
            name: "Phase 6 MCP works",
          },
          expected: "Phase 6 MCP works",
        },
      ],
      evidence: ["screenshot", "network"],
      captureIntent: "final",
    },
  ],
};

await call("validate_test_plan", { ...selected, plan });
const submitted = await call("submit_test_spec", {
  projectId: selected.projectId,
  name: "MCP browser verification",
  objective: plan.objective,
  expectedOutcomes: ["The MCP fixture heading is visible."],
  plan,
});
const planVersionId = String(submitted.planVersionId);
const started = await call("start_run", {
  projectId: selected.projectId,
  environmentId: selected.environmentId,
  planVersionId,
});
const runId = String(started.runId);

let state = "queued";
for (let poll = 0; poll < 80; poll += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const status = await call("get_run_status", { runId });
  const run = status.run as { state: string };
  state = run.state;
  if (
    ["passed", "failed", "cancelled", "timed_out", "infrastructure_error"].includes(
      state,
    )
  ) {
    break;
  }
}
const report = await call("get_test_report", { runId });
const artifacts = await call("list_run_artifacts", { runId });
process.stdout.write(
  `${JSON.stringify(
    {
      runId,
      state,
      reportState: (report.report as { run: { state: string } }).run.state,
      artifactCount: (artifacts.artifacts as unknown[]).length,
    },
    null,
    2,
  )}\n`,
);
if (state !== "passed") process.exitCode = 1;

await client.close();
await server.close();

async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return response.structuredContent as Record<string, unknown>;
}
