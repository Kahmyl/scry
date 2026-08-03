import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerListFlowsTool } from "./list-flows.tool.js";
import { registerEnsureCalibrationTool } from "./ensure-calibration.tool.js";
import { registerListCalibrationsTool } from "./list-calibrations.tool.js";
import { registerGetCalibrationTool } from "./get-calibration.tool.js";
import { registerApproveCalibrationTool } from "./approve-calibration.tool.js";
import { registerRetryCalibrationTool } from "./retry-calibration.tool.js";
import { registerCancelCalibrationTool } from "./cancel-calibration.tool.js";
import { registerBindCalibrationTool } from "./bind-calibration.tool.js";

export function registerFlowsTools(server: McpServer, client: ScryApiClient) {
  registerListFlowsTool(server, client);
  registerEnsureCalibrationTool(server, client);
  registerListCalibrationsTool(server, client);
  registerGetCalibrationTool(server, client);
  registerApproveCalibrationTool(server, client);
  registerRetryCalibrationTool(server, client);
  registerCancelCalibrationTool(server, client);
  registerBindCalibrationTool(server, client);
}
