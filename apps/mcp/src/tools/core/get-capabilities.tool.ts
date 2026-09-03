import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult as result } from "../../tool-registry.js";

export function registerGetCapabilitiesTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Scry capabilities",
      description:
        "Read Scry release and capability facts. Use this when the task asks about the release or available capabilities, when contract compatibility is uncertain, or when a Scry error explicitly directs you to verify the release. Do not use it as a routine preflight before ordinary Mission, Praxis, Flow, or Run work.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () =>
      result(
        { capabilities: await client.requireCurrentRelease() },
        "Scry release and schema agree.",
      ),
  );
}
