import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.BROWSER_V2_MCP_ENDPOINT;
const tokenPath = process.env.BROWSER_V2_MCP_TOKEN_PATH;
const toolName = process.argv[2];
const serializedArguments = process.argv[3] ?? "{}";

if (!endpoint) throw new Error("BROWSER_V2_MCP_ENDPOINT_REQUIRED");
if (!tokenPath) throw new Error("BROWSER_V2_MCP_TOKEN_PATH_REQUIRED");
if (!toolName) throw new Error("BROWSER_V2_MCP_TOOL_REQUIRED");

const token = (await readFile(tokenPath, "utf8")).trim();
if (!token) throw new Error("BROWSER_V2_MCP_TOKEN_EMPTY");

const parsedArguments = JSON.parse(serializedArguments) as Record<string, unknown>;
const client = new Client({ name: "browser-v2-qualification", version: "2.6.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: {
    headers: {
      authorization: `Bearer ${token}`,
      "x-scry-agent-provider": "codex-native",
      "x-scry-experiment-id": process.env.BROWSER_V2_EXPERIMENT_ID ?? "browser-v2-qualification",
    },
  },
});

try {
  await client.connect(transport as Parameters<typeof client.connect>[0]);
  const result = await client.callTool({ name: toolName, arguments: parsedArguments });
  process.stdout.write(`${JSON.stringify(result.structuredContent ?? result, null, 2)}\n`);
} finally {
  await client.close();
}
