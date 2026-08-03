import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../api-client.js";
import { readOnly, toolResult as result } from "../tool-registry.js";

export function registerCoreTools(server: McpServer, client: ScryApiClient) {
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

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List available Scry projects.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const projects = await client.get<unknown[]>("/projects");
      return result({ projects }, `Found ${projects.length} projects.`);
    },
  );
}
