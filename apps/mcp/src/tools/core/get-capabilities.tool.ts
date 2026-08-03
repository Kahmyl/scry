import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult as result } from "../../tool-registry.js";

export function registerGetCapabilitiesTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Scry capabilities",
      description: "Verify the exact Scry release and available current-contract actions.",
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
