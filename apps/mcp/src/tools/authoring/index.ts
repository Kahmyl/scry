import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerCreateFlowDraftTool } from "./create-flow-draft.tool.js";
import { registerGetFlowDraftTool } from "./get-flow-draft.tool.js";
import { registerListMissionFlowDraftsTool } from "./list-mission-flow-drafts.tool.js";
import { registerAbandonFlowDraftTool } from "./abandon-flow-draft.tool.js";
import { registerPublishFlowDraftTool } from "./publish-flow-draft.tool.js";
import { registerListAuthenticationContractsTool } from "./list-authentication-contracts.tool.js";
import { registerListAuthenticatedSessionLeasesTool } from "./list-authenticated-session-leases.tool.js";
import { registerRevokeAuthenticatedSessionLeaseTool } from "./revoke-authenticated-session-lease.tool.js";

export function registerAuthoringTools(server: McpServer, client: ScryApiClient) {
  registerCreateFlowDraftTool(server, client);
  registerGetFlowDraftTool(server, client);
  registerListMissionFlowDraftsTool(server, client);
  registerAbandonFlowDraftTool(server, client);
  registerPublishFlowDraftTool(server, client);
  registerListAuthenticationContractsTool(server, client);
  registerListAuthenticatedSessionLeasesTool(server, client);
  registerRevokeAuthenticatedSessionLeaseTool(server, client);
}
