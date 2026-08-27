import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerPrepareFlowAuthoringTool } from "./prepare-flow-authoring.tool.js";
import { registerStartFlowAuthoringTool } from "./start-flow-authoring.tool.js";
import { registerAdvanceFlowAuthoringTool } from "./advance-flow-authoring.tool.js";
import { registerRecoverTrustedScriptOriginsTool } from "./recover-trusted-script-origins.tool.js";
import { registerGetFlowAuthoringTool } from "./get-flow-authoring.tool.js";
import { registerReconcileUnknownOperationTool } from "./reconcile-unknown-operation.tool.js";
import { registerCloseFlowAuthoringTool } from "./close-flow-authoring.tool.js";
import { registerStartPraxisSessionTool } from "./start-praxis-session.tool.js";
import { registerObservePraxisSessionTool } from "./observe-praxis-session.tool.js";
import { registerInspectPraxisRegionTool } from "./inspect-praxis-region.tool.js";
import { registerReadPraxisPublicValueTool } from "./read-praxis-public-value.tool.js";
import { registerInspectPraxisResourcesTool } from "./inspect-praxis-resources.tool.js";
import { registerReadPraxisPublicResourceTool } from "./read-praxis-public-resource.tool.js";
import { registerGetPraxisSessionTool } from "./get-praxis-session.tool.js";
import { registerReconcilePraxisUnknownOperationTool } from "./reconcile-praxis-unknown-operation.tool.js";
import { registerClosePraxisSessionTool } from "./close-praxis-session.tool.js";

export function registerAdaptiveSessionTools(server: McpServer, client: ScryApiClient) {
  registerPrepareFlowAuthoringTool(server, client);
  registerStartFlowAuthoringTool(server, client);
  registerAdvanceFlowAuthoringTool(server, client);
  registerRecoverTrustedScriptOriginsTool(server, client);
  registerGetFlowAuthoringTool(server, client);
  registerReconcileUnknownOperationTool(server, client);
  registerCloseFlowAuthoringTool(server, client);
}

export function registerPraxisSessionTools(server: McpServer, client: ScryApiClient) {
  registerStartPraxisSessionTool(server, client);
  registerObservePraxisSessionTool(server, client);
  registerInspectPraxisRegionTool(server, client);
  registerReadPraxisPublicValueTool(server, client);
  registerInspectPraxisResourcesTool(server, client);
  registerReadPraxisPublicResourceTool(server, client);
  registerGetPraxisSessionTool(server, client);
  registerReconcilePraxisUnknownOperationTool(server, client);
  registerClosePraxisSessionTool(server, client);
}
