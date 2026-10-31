// Transparent CLI transport for public HTTP MCP. No browser actions, selectors,
// fixtures, lifecycle choreography or application-specific decisions live here.
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const [root, app, operation, name, argument = "{}"] = process.argv.slice(2);
if (!root || !/^[a-z]+$/u.test(app ?? ""))
  throw new Error("Usage: client ROOT APP tools|schema|call [NAME] [JSON]");
const directory = root + "/" + app;
const { token } = JSON.parse(await readFile(directory + "/connection.json", "utf8"));
let state = JSON.parse(await readFile(directory + "/session.json", "utf8").catch(() => "{}"));
const rpc = async (method, params) => {
  const r = await fetch("http://127.0.0.1:45410/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(state.id ? { "mcp-session-id": state.id, "mcp-protocol-version": "2025-03-26" } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok)
    throw new Error(`MCP transport ${r.status}; do not repeat a potentially dispatched action`);
  state.id ??= r.headers.get("mcp-session-id");
  const result = await r.json();
  if (result.error) throw new Error(JSON.stringify(result.error));
  return result.result;
};
if (!state.id) {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "blind-customer-" + app, version: "baseline" },
  });
  state.instructions = init.instructions;
  await writeFile(directory + "/session.json", JSON.stringify(state), { mode: 0o600 });
}
if (operation === "tools" || operation === "schema") {
  const { tools } = await rpc("tools/list", {});
  console.log(
    JSON.stringify(
      operation === "tools"
        ? {
            instructions: state.instructions,
            tools: tools.map(({ name, description }) => ({ name, description })),
          }
        : tools.find((tool) => tool.name === name),
      null,
      2,
    ),
  );
} else if (operation === "call") {
  const args = JSON.parse(argument);
  await appendFile(
    directory + "/calls.jsonl",
    JSON.stringify({ at: new Date().toISOString(), name, arguments: args }) + "\n",
    { mode: 0o600 },
  );
  const result = await rpc("tools/call", { name, arguments: args });
  for (const item of result.content ?? []) {
    if (item.type !== "image") continue;
    const file =
      directory +
      "/" +
      randomUUID() +
      (item.mimeType === "image/jpeg"
        ? ".jpeg"
        : item.mimeType === "image/webp"
          ? ".webp"
          : ".png");
    await writeFile(file, Buffer.from(item.data, "base64"), { mode: 0o600 });
    delete item.data;
    item.localImagePath = file;
  }
  await appendFile(
    directory + "/results.jsonl",
    JSON.stringify({ at: new Date().toISOString(), name, result }) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result, null, 2));
} else throw new Error("Unknown transport operation");
