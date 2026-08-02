import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ScryApiClient } from "../src/api-client.js";
import { createScryMcpServer } from "../src/server.js";

const api = new ScryApiClient();
const suffix = Date.now().toString(36);
const projects = await api.get<Array<{ id: string; name: string }>>("/projects");
const project = projects[0] ?? await api.post<{ id: string; name: string }>("/projects", {
  name: "Scry MCP verification",
  description: "Safe local project for production-shaped MCP verification.",
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createScryMcpServer(api);
const client = new Client({ name: "scry-codex-demo", version: "2.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

try {
  await call("get_capabilities", {});
  const started = await call("start_mission", {
    projectId: project.id,
    title: `MCP execution verification ${suffix}`,
    originalInstruction: "Verify Scry health through the complete Mission-aware MCP execution path.",
    instructionSnapshot: "Run one safe local Mission through MCP and inspect its durable result.",
    provider: "codex",
    idempotencyKey: `mcp-mission-${suffix}`,
  });
  const missionId = stringAt(started, "missionId");
  const agentSessionId = stringAt(started, "agentSessionId");
  const context = { missionId, agentSessionId };

  const createdObjective = await call("create_mission_objective", {
    ...context,
    title: "Verify Scry health",
    description: "Open the local Scry API health document and prove it reports status ok.",
    dependencies: [],
    completionCriteria: [{ description: "The API health document visibly reports status ok.", required: true }],
    order: 0,
  });
  const objectiveId = stringAt(createdObjective.objective as Record<string, unknown>, "id");
  const objectiveContext = { ...context, objectiveId };

  const createdEnvironment = await call("create_test_environment", {
    ...objectiveContext,
    projectId: project.id,
    name: `Local Scry web ${suffix}`,
    baseOrigin: "http://api:4000",
    policy: {
      allowedOrigins: ["http://api:4000"],
      allowPrivateNetwork: true,
      allowDownloads: false,
      allowPopups: false,
      maxActions: 4,
      maxDurationMs: 30_000,
      maxNavigations: 1,
    },
    secretRefs: [],
  });
  const environmentId = stringAt(createdEnvironment.environment as Record<string, unknown>, "id");
  const expectedText = '"status":"ok"';
  const healthIntent = { concept:"Scry health status",requiredCapabilities:["readable_value"],preferredEvidence:{roles:["text"],names:[expectedText],labels:[],descriptions:[],placeholders:[],inputTypes:[],expectedText},scope:{kind:"page"},relations:[],prohibited:["hidden"],risk:"read_only",confidence:{requiredFamilies:[],minimum:.5,minimumMargin:0,minimumFamilyCount:1} };
  const plan = {
    name: "MCP Mission browser verification",
    objective: "Verify the local Scry API health document is reachable by the browser worker.",
    preconditions: [],
    allowedOrigins: ["http://api:4000"],
    budgets: { maxActions: 4, maxDurationMs: 30_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [{
      id: "open-scry",
      title: "Open the Scry health document",
      action: { type: "navigate", url: "/api/health" },
      after: {
        mode: "all",
        timeoutMs: 15_000,
        conditions: [{ type: "visible", target: healthIntent }],
      },
      assertions: [{
        type: "text",
        target: healthIntent,
        expected: expectedText,
        exact: false,
      }],
      onFailure: "stop",
      evidence: ["screenshot", "dom", "network"],
      captureIntent: "final",
    }],
  };
  await call("validate_test_plan", { projectId: project.id, environmentId, plan });
  const createdFlow = await call("create_flow", {
    ...objectiveContext,
    projectId: project.id,
    environmentId,
    name: `Scry landing verification ${suffix}`,
    description: "Safe local browser verification created through MCP.",
    content: {
      objective: plan.objective,
      preconditions: [],
      expectedOutcomes: ["The API health document reports status ok."],
      prohibitedSideEffects: ["Do not submit forms or mutate application state."],
    },
    plan,
    visibility: "mission_local",
    purpose: "verification",
    reason: "Production-shaped MCP acceptance run.",
    idempotencyKey: `mcp-flow-${suffix}`,
  });
  const flow = createdFlow.flow as Record<string, unknown>;
  const flowRevisionId = stringAt(flow, "latestRevisionId", "revisionId");

  const createdPlan = await call("create_execution_plan", {
    ...context,
    bindings: [{
      objectiveId,
      mode: "automatic",
      flowRevisionId,
      environmentId,
      authorizationIds: [],
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
      seed: 1,
    }],
    idempotencyKey: `mcp-plan-${suffix}`,
  });
  const executionPlan = createdPlan.plan as Record<string, unknown>;
  const planRevision = numberAt(executionPlan, "revision");
  const validation = await call("validate_execution_plan", { missionId, planRevision });
  if ((validation.validation as Record<string, unknown>).valid !== true) throw new Error(`Execution plan rejected: ${JSON.stringify(validation.validation)}`);
  await call("activate_execution_plan", { ...context, planRevision });
  await call("start_ready_objectives", { ...context, objectiveIds: [objectiveId] });

  let objective: Record<string, unknown> | undefined;
  let runId = "";
  let observation: Record<string, unknown> = {};
  for (let poll = 0; poll < 120; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const orchestration = (await call("get_orchestration_status", { missionId })).orchestration as Record<string, unknown>;
    objective = (orchestration.objectives as Record<string, unknown>[]).find((item) => item.id === objectiveId);
    if (!runId && objective?.activeRunId) runId = String(objective.activeRunId);
    if (!runId) continue;
    observation = (await call("get_run", { runId })).observation as Record<string, unknown>;
    const currentState = String((observation.run as Record<string, unknown>).state);
    if (["passed", "failed", "cancelled", "timed_out", "infrastructure_error"].includes(currentState)) break;
  }
  if (!objective) throw new Error("Objective disappeared from orchestration status.");
  if (!runId) throw new Error("Orchestration did not create a Run.");
  const run = observation.run as Record<string, unknown>;
  const state = String(run.state);
  if (state !== "passed") throw new Error(`MCP Run did not pass: ${JSON.stringify({ runId, state, failure: observation.failure })}`);

  await call("accept_objective_evidence", {
    ...context,
    objectiveId,
    runId,
    artifactIds: [],
    conclusion: "The Scry landing page rendered the expected primary heading in a controlled Chromium Run.",
  });
  const mission = (await call("get_mission", { missionId })).mission as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify({
    projectId: project.id,
    missionId,
    objectiveId,
    flowRevisionId,
    runId,
    runState: state,
    orchestrationState: objective.state,
    artifactCount: Array.isArray(observation.artifacts) ? observation.artifacts.length : 0,
    acceptedEvidenceCount: mission.acceptedEvidenceCount,
  }, null, 2)}\n`);
} finally {
  await client.close();
  await server.close();
}

async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return response.structuredContent as Record<string, unknown>;
}

function stringAt(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  throw new Error(`Expected one of ${keys.join(", ")} in ${JSON.stringify(value)}`);
}

function numberAt(value: Record<string, unknown>, key: string) {
  if (typeof value[key] === "number") return value[key] as number;
  throw new Error(`Expected ${key} in ${JSON.stringify(value)}`);
}
