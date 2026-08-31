// Repository-blind client: only stdin, MCP HTTP and stdout; no filesystem,
// process execution, database, provider adapter or business HTTP capability.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { endpoint, token, praxisSessionId } = JSON.parse(input);
if (new URL(endpoint).hostname !== "127.0.0.1") throw new Error("LOCAL_MCP_REQUIRED");
let session,
  sequence = 0;
async function request(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
  });
  session = response.headers.get("mcp-session-id") ?? session;
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP_HTTP_${response.status}`);
  const message = response.headers.get("content-type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((item) => item.id === sequence)
    : JSON.parse(body);
  if (message.error || message.result?.isError) throw new Error(JSON.stringify(message));
  return message.result;
}
await request("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "repository-blind-semantic-reader", version: "1" },
});
async function call(name) {
  const result = await request("tools/call", { name, arguments: { praxisSessionId } });
  return (
    result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === "text").text)
  );
}
const semantics = await call("observe_operation_contracts");
const values = await call("list_mission_values");
if (
  /"(?:runtimeOwnerId|fencingEpoch|ciphertext|plaintext)"/.test(
    JSON.stringify({ semantics, values }),
  )
)
  throw new Error("UNSAFE_DISCOVERY_SURFACE");
process.stdout.write(JSON.stringify({ semantics, values }));
if (session)
  await fetch(endpoint, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "mcp-session-id": session },
  });
