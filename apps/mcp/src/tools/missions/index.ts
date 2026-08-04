import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ScryApiClient } from "../../api-client.js";
import { registerStartMissionTool } from "./start-mission.tool.js";
import { registerResumeMissionTool } from "./resume-mission.tool.js";
import { registerAttachToMissionTool } from "./attach-to-mission.tool.js";
import { registerGetMissionTool } from "./get-mission.tool.js";
import { registerListMissionsTool } from "./list-missions.tool.js";
import { registerUpdateMissionTool } from "./update-mission.tool.js";
import { registerEndAgentSessionTool } from "./end-agent-session.tool.js";
import { registerGetMissionActivityTool } from "./get-mission-activity.tool.js";
import { registerCreateExecutionPlanTool } from "./create-execution-plan.tool.js";
import { registerValidateExecutionPlanTool } from "./validate-execution-plan.tool.js";
import { registerActivateExecutionPlanTool } from "./activate-execution-plan.tool.js";
import { registerGetOrchestrationStatusTool } from "./get-orchestration-status.tool.js";
import { registerStartReadyObjectivesTool } from "./start-ready-objectives.tool.js";
import { registerPauseMissionOrchestrationTool } from "./pause-mission-orchestration.tool.js";
import { registerResumeMissionOrchestrationTool } from "./resume-mission-orchestration.tool.js";
import { registerCancelMissionOrchestrationTool } from "./cancel-mission-orchestration.tool.js";
import { registerGrantMissionExecutionAuthorizationTool } from "./grant-mission-execution-authorization.tool.js";
import { registerRelateMissionActivityTool } from "./relate-mission-activity.tool.js";
import { registerCreateMissionObjectiveTool } from "./create-mission-objective.tool.js";
import { registerUpdateMissionObjectiveTool } from "./update-mission-objective.tool.js";
import { registerAttachFlowToMissionTool } from "./attach-flow-to-mission.tool.js";

export function registerMissionsTools(server: McpServer, client: ScryApiClient) {
  registerStartMissionTool(server, client);
  registerResumeMissionTool(server, client);
  registerAttachToMissionTool(server, client);
  registerGetMissionTool(server, client);
  registerListMissionsTool(server, client);
  registerUpdateMissionTool(server, client);
  registerEndAgentSessionTool(server, client);
  registerGetMissionActivityTool(server, client);
  registerCreateExecutionPlanTool(server, client);
  registerValidateExecutionPlanTool(server, client);
  registerActivateExecutionPlanTool(server, client);
  registerGetOrchestrationStatusTool(server, client);
  registerStartReadyObjectivesTool(server, client);
  registerPauseMissionOrchestrationTool(server, client);
  registerResumeMissionOrchestrationTool(server, client);
  registerCancelMissionOrchestrationTool(server, client);
  registerGrantMissionExecutionAuthorizationTool(server, client);
  registerRelateMissionActivityTool(server, client);
  registerCreateMissionObjectiveTool(server, client);
  registerUpdateMissionObjectiveTool(server, client);
  registerAttachFlowToMissionTool(server, client);
}
