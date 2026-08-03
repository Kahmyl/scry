import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerStartRunTool } from "./start-run.tool.js";
import { registerGetRunTool } from "./get-run.tool.js";
import { registerGetVeilFindingsTool } from "./get-veil-findings.tool.js";
import { registerTightenVeilPreferencesTool } from "./tighten-veil-preferences.tool.js";
import { registerGetProtectedRecoveryTool } from "./get-protected-recovery.tool.js";
import { registerActOnProtectedRecoveryTool } from "./act-on-protected-recovery.tool.js";
import { registerAcceptObjectiveEvidenceTool } from "./accept-objective-evidence.tool.js";
import { registerClassifyRunTool } from "./classify-run.tool.js";
import { registerSetMissionResumePointerTool } from "./set-mission-resume-pointer.tool.js";
import { registerPublishMissionReportTool } from "./publish-mission-report.tool.js";

export function registerRunsTools(server: McpServer, client: ScryApiClient) {
  registerStartRunTool(server, client);
  registerGetRunTool(server, client);
  registerGetVeilFindingsTool(server, client);
  registerTightenVeilPreferencesTool(server, client);
  registerGetProtectedRecoveryTool(server, client);
  registerActOnProtectedRecoveryTool(server, client);
  registerAcceptObjectiveEvidenceTool(server, client);
  registerClassifyRunTool(server, client);
  registerSetMissionResumePointerTool(server, client);
  registerPublishMissionReportTool(server, client);
}
