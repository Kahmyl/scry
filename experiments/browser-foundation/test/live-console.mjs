import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
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
const root = "/results/live-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const config = {
  root: root + "/store",
  workspace: "ten-established-apps",
  environments: Object.fromEntries(
    Object.entries(origins).map(([app, origin]) => [
      app,
      {
        allowTesting: true,
        origins: [origin, ...(app === "erpnext" ? ["https://i.ytimg.com"] : [])],
      },
    ]),
  ),
  secrets: Object.fromEntries(
    Object.keys(origins).map((app) => [app, { password: inputs[app].password }]),
  ),
};
await writeFile(root + "/config.json", JSON.stringify(config), { mode: 0o600 });
const client = new Client({ name: "customer-style-public-browser-tools", version: "isolated" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.mjs"],
  env: { ...process.env, SCRY_CANDIDATE_CONFIG: root + "/config.json" },
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
await client.connect(transport);
let active,
  seq = 0;
const completed = [];
const text = (r) =>
  r.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
const json = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);
async function call(tool, args) {
  const result = await client.callTool({ name: tool, arguments: args });
  const safe = {
    tool,
    args,
    content: result.content.filter((c) => c.type === "text"),
    isError: result.isError ?? false,
  };
  await appendFile(root + "/commands.jsonl", JSON.stringify(safe) + "\n", { mode: 0o600 });
  for (const image of result.content.filter((c) => c.type === "image")) {
    const file = root + "/" + active.app + "-" + seq + ".png";
    await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    console.log(JSON.stringify({ screenshot: file }));
  }
  return result;
}
async function browser(tool, args) {
  return call(tool, { runId: active.runId, actionId: "live-" + ++seq, ...args });
}
console.log(
  JSON.stringify({
    ready: true,
    root,
    apps: Object.keys(origins),
    instructions:
      "JSON lines: start app; tool plus args; screenshot; finish outcome and notes; quit. All business actions go through public MCP.",
  }),
);
const lines = readline.createInterface({ input: process.stdin, terminal: false });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      let result;
      if (command.op === "start") {
        if (active) throw new Error("Finish the active test first");
        if (!origins[command.app]) throw new Error("Unknown approved app");
        const started = json(await call("scry_start_test", { environment: command.app }));
        if (!started.runId) throw new Error("Start failed");
        active = { app: command.app, runId: started.runId, started: Date.now() };
        console.log(
          JSON.stringify({
            app: active.app,
            runId: active.runId,
            username: inputs[active.app].username,
            secretId: "password",
          }),
        );
        await browser("browser_navigate", { url: origins[active.app] });
        result = await browser("browser_snapshot", {});
      } else if (command.op === "finish") {
        result = await call("scry_finish_test", {
          runId: active.runId,
          outcome: command.outcome ?? "completed",
        });
        completed.push({
          ...active,
          assessment: command.notes ?? "",
          outcome: command.outcome ?? "completed",
          final: json(result),
        });
        await writeFile(root + "/journeys.json", JSON.stringify(completed, null, 2));
        active = null;
        console.log(
          JSON.stringify({
            finished: completed.at(-1).app,
            state: completed.at(-1).final.state,
            evidence: completed.at(-1).final.evidence,
          }),
        );
        continue;
      } else if (command.op === "screenshot") {
        result = await browser("browser_take_screenshot", { type: "png", scale: "css" });
      } else if (command.op === "status")
        result = await call("scry_test_status", { runId: active.runId });
      else if (command.op === "tools") {
        console.log(JSON.stringify((await client.listTools()).tools));
        continue;
      } else if (command.op === "quit") break;
      else result = await browser(command.tool, command.args ?? {});
      const output = text(result);
      console.log(
        output.length > 18000
          ? output.slice(0, 18000) + "\n[Harness display truncated; request a focused snapshot]"
          : output,
      );
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  }
} finally {
  lines.close();
  process.stdin.pause();
  await client.close();
  console.log(
    JSON.stringify({
      closed: true,
      root,
      completed: completed.map((c) => ({ app: c.app, outcome: c.outcome })),
    }),
  );
}
