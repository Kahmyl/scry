import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerGetArtifactTool } from "./get-artifact.tool.js";
import { registerSearchArtifactTool } from "./search-artifact.tool.js";
import { registerExtractArtifactHtmlTool } from "./extract-artifact-html.tool.js";

export function registerArtifactsTools(server: McpServer, client: ScryApiClient) {
  registerGetArtifactTool(server, client);
  registerSearchArtifactTool(server, client);
  registerExtractArtifactHtmlTool(server, client);
}
