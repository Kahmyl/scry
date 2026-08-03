import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerListEnvironmentsTool } from "./list-environments.tool.js";
import { registerCreateTestEnvironmentTool } from "./create-test-environment.tool.js";
import { registerListProjectCredentialsTool } from "./list-project-credentials.tool.js";
import { registerCreateProjectCredentialTool } from "./create-project-credential.tool.js";
import { registerAuthorizeEnvironmentCredentialsTool } from "./authorize-environment-credentials.tool.js";

export function registerProjectsTools(server: McpServer, client: ScryApiClient) {
  registerListEnvironmentsTool(server, client);
  registerCreateTestEnvironmentTool(server, client);
  registerListProjectCredentialsTool(server, client);
  registerCreateProjectCredentialTool(server, client);
  registerAuthorizeEnvironmentCredentialsTool(server, client);
}
