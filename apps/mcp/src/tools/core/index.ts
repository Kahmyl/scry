import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerGetCapabilitiesTool } from "./get-capabilities.tool.js";
import { registerListProjectsTool } from "./list-projects.tool.js";

export function registerCoreTools(server: McpServer, client: ScryApiClient) {
  registerGetCapabilitiesTool(server, client);
  registerListProjectsTool(server, client);
}
