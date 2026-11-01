// Customer-facing tools only. Private fixture passwords are bound once and
// thereafter selected by opaque reference; no app API or driver shortcut.
import { readFile, appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
const inputs = JSON.parse(await readFile("/inputs/private-inputs.json", "utf8"));
const origins = {
  grafana: "http://grafana:3000",
  nextcloud: "http://nextcloud",
  odoo: "http://odoo:8069",
  metabase: "http://metabase:3000",
  openproject: "http://openproject",
  discourse: "http://discourse",
  mattermost: "http://mattermost:8065",
  erpnext: "http://erpnext:8080",
  penpot: "http://penpot:8080",
  gitlab: "http://gitlab",
};
let { token } = await (await fetch("http://fixture:8080/fixture-input")).json();
const api = async (path, body) => {
  const r = await fetch("http://api:4000/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`API ${r.status} ${JSON.stringify(data)}`);
  return data;
};
const root =
  process.env.SCRY_INTEGRATION_RESUME_ROOT ?? "/integration-evidence/ten-app-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const prior = process.env.SCRY_INTEGRATION_RESUME_ROOT
  ? (await readFile(root + "/tools.jsonl", "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.name === "start_mission")
  : undefined;
const project = prior
  ? { id: prior.args.projectId }
  : await api("/projects", { name: "Ten-app controlled platform " + randomUUID().slice(0, 8) });
// Exercise the same scoped MCP credential a real customer connects. The fixture
// JWT is for human bootstrap only, not a fragile fifteen-minute agent session.
const access = await api("/mcp-tokens", { name: "Disposable controlled integration" });
token = access.token;
let session,
  sequence = 0,
  active;
const completed = process.env.SCRY_INTEGRATION_RESUME_ROOT
  ? JSON.parse(await readFile(root + "/results.json", "utf8")).completed
  : [];
const rpc = async (method, params) => {
  const response = await fetch("http://mcp:4100/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(45000),
  });
  session ??= response.headers.get("mcp-session-id");
  const e = await response.json();
  if (!response.ok || e.error) throw new Error("MCP protocol rejected");
  return e.result;
};
await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "controlled-platform-ten-apps", version: "baseline" },
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(JSON.stringify(r));
  if (name !== "create_credential")
    await appendFile(
      root + "/tools.jsonl",
      JSON.stringify({
        name,
        args,
        result: r.structuredContent ?? r.content.filter((c) => c.type === "text"),
      }) + "\n",
      { mode: 0o600 },
    );
  return r;
};
const life = async (n, a) => (await call(n, a)).structuredContent;
const mission = prior
  ? prior.result
  : await life("start_mission", {
      projectId: project.id,
      title: "Ten established apps through integrated Scry",
      instruction:
        "Revisit the ten dedicated fictional app instances using the public browser tools; verify interaction and actual native evidence through the platform.",
      provider: "human",
    });
const browser = async (tool, args = {}) => {
  const r = await call(tool, {
    ...args,
    browserSessionId: active.browserSessionId,
    actionId: randomUUID(),
  });
  for (const image of r.content.filter((c) => c.type === "image")) {
    const file = root + "/" + active.app + "-" + sequence + ".png";
    await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    console.log(JSON.stringify({ screenshot: file }));
  }
  const c = r.structuredContent?.command;
  if (c?.state !== "completed") return c ?? r;
  return c.result;
};
console.log(
  JSON.stringify({ ready: true, root, missionId: mission.missionId, apps: Object.keys(origins) }),
);
const lines = readline.createInterface({ input: process.stdin, terminal: false });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line);
      let result;
      if (cmd.op === "start") {
        if (active || !origins[cmd.app]) throw new Error("Invalid active app");
        const app = cmd.app;
        const environment = await life("create_environment", {
          projectId: project.id,
          name: app,
          baseOrigin: origins[app],
          disclosureMode: "confidential",
        });
        const credential = await life("create_credential", {
          projectId: project.id,
          displayName: app + " approved fixture password",
          value: inputs[app].password,
          idempotencyKey: randomUUID(),
        });
        const objective = await life("create_objective", {
          missionId: mission.missionId,
          agentSessionId: mission.agentSessionId,
          title: app + " platform revisit",
          completionCriteria: { interaction: true, nativeEvidence: true },
          objectiveOrder: completed.length,
        });
        const flow = await life("create_flow", {
          missionId: mission.missionId,
          agentSessionId: mission.agentSessionId,
          name: app + " integrated journey",
        });
        const run = await life("start_run", {
          projectId: project.id,
          missionId: mission.missionId,
          objectiveId: objective.objectiveId,
          agentSessionId: mission.agentSessionId,
          flowId: flow.flowId,
          flowRevisionId: flow.flowRevisionId,
          environmentId: environment.environmentId,
          protectedInputIds: [credential.protectedValueId],
        });
        active = { ...run, app, credentialId: credential.protectedValueId };
        console.log(JSON.stringify({ app, username: inputs[app].username }));
        result = await browser("browser_navigate", { url: origins[app] + (cmd.path ?? "/") });
      } else if (cmd.op === "secret")
        result = await browser("browser_type_secret", {
          target: cmd.target,
          protectedValueId: active.credentialId,
          ...(cmd.submit ? { submit: true } : {}),
        });
      else if (cmd.op === "screenshot")
        result = await browser("browser_take_screenshot", { type: "png" });
      else if (cmd.op === "tool") result = await browser(cmd.tool, cmd.args);
      else if (cmd.op === "finish") {
        const run = await api(`/runs/${active.runId}`);
        await life("finalize_run", {
          runId: active.runId,
          ownerGeneration: Number(run.ownerGeneration),
          outcome: cmd.outcome ?? "passed",
          conclusion: cmd.notes ?? "Integrated browser interaction and evidence verified",
        });
        const media = await api(`/runs/${active.runId}/media`);
        if (!media.items.some((i) => i.kind === "video")) throw new Error("Native video missing");
        completed.push({
          app: active.app,
          runId: active.runId,
          outcome: cmd.outcome ?? "passed",
          media: media.items,
          notes: cmd.notes,
        });
        active = undefined;
        await writeFile(root + "/results.json", JSON.stringify({ completed }, null, 2));
        result = { finished: completed.at(-1) };
      } else if (cmd.op === "quit") break;
      else throw new Error("Unknown operation");
      console.log(JSON.stringify({ result }));
    } catch (error) {
      console.log(JSON.stringify({ error: String(error.message) }));
    }
  }
} finally {
  if (active) {
    const run = await api(`/runs/${active.runId}`);
    await api(`/runs/${active.runId}/finalize`, {
      ownerGeneration: Number(run.ownerGeneration),
      outcome: "environment_failure",
      conclusion: "Operator console ended before completion",
    }).catch(() => {});
  }
  const fresh = await (await fetch("http://fixture:8080/fixture-input")).json();
  await fetch(`http://api:4000/api/mcp-tokens/${access.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer " + fresh.token },
  });
}
