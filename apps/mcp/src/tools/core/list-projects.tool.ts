import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult as result } from "../../tool-registry.js";

export function registerListProjectsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List available Scry projects before any Mission write. If the result is empty, MCP has no project-creation capability: ask the user to create/select a project in the Scry dashboard, then call list_projects again.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const projects = await client.get<unknown[]>("/projects");
      return result({ projects }, `Found ${projects.length} projects.`);
    },
  );
}
