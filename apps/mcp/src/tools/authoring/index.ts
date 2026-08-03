import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerValidateTestPlanTool } from "./validate-test-plan.tool.js";
import { registerCreateFlowDraftTool } from "./create-flow-draft.tool.js";
import { registerUpdateFlowDraftTool } from "./update-flow-draft.tool.js";
import { registerGetFlowDraftTool } from "./get-flow-draft.tool.js";
import { registerListMissionFlowDraftsTool } from "./list-mission-flow-drafts.tool.js";
import { registerAbandonFlowDraftTool } from "./abandon-flow-draft.tool.js";
import { registerStartProbeSessionTool } from "./start-probe-session.tool.js";
import { registerGetProbeSessionTool } from "./get-probe-session.tool.js";
import { registerCancelProbeSessionTool } from "./cancel-probe-session.tool.js";
import { registerCompileFlowDraftTool } from "./compile-flow-draft.tool.js";
import { registerPublishFlowDraftTool } from "./publish-flow-draft.tool.js";
import { registerListAuthenticationContractsTool } from "./list-authentication-contracts.tool.js";
import { registerListAuthenticatedSessionLeasesTool } from "./list-authenticated-session-leases.tool.js";
import { registerRevokeAuthenticatedSessionLeaseTool } from "./revoke-authenticated-session-lease.tool.js";

export function registerAuthoringTools(server: McpServer, client: ScryApiClient) {
  registerValidateTestPlanTool(server, client);
  registerCreateFlowDraftTool(server, client);
  registerUpdateFlowDraftTool(server, client);
  registerGetFlowDraftTool(server, client);
  registerListMissionFlowDraftsTool(server, client);
  registerAbandonFlowDraftTool(server, client);
  registerStartProbeSessionTool(server, client);
  registerGetProbeSessionTool(server, client);
  registerCancelProbeSessionTool(server, client);
  registerCompileFlowDraftTool(server, client);
  registerPublishFlowDraftTool(server, client);
  registerListAuthenticationContractsTool(server, client);
  registerListAuthenticatedSessionLeasesTool(server, client);
  registerRevokeAuthenticatedSessionLeaseTool(server, client);
}
