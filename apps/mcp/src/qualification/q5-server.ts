import type { ScryApiClient } from "../api-client.js";
import { Q5_MCP_PROFILE, Q5_MCP_TOOL_NAMES } from "@scry/contracts";
import { createScryServerComposition } from "../server-composition.js";
import { registerGetCapabilitiesTool } from "../tools/core/get-capabilities.tool.js";
import { registerGetOperatingContextTool } from "../tools/core/get-operating-context.tool.js";
import { registerListEnvironmentsTool } from "../tools/projects/list-environments.tool.js";
import { registerListProjectCredentialsTool } from "../tools/projects/list-project-credentials.tool.js";
import { registerStartPraxisSessionTool } from "../tools/adaptive-sessions/start-praxis-session.tool.js";
import { registerObservePraxisSessionTool } from "../tools/adaptive-sessions/observe-praxis-session.tool.js";
import { registerInspectPraxisRegionTool } from "../tools/adaptive-sessions/inspect-praxis-region.tool.js";
import { registerReadPraxisPublicValueTool } from "../tools/adaptive-sessions/read-praxis-public-value.tool.js";
import { registerInspectPraxisResourcesTool } from "../tools/adaptive-sessions/inspect-praxis-resources.tool.js";
import { registerReadPraxisPublicResourceTool } from "../tools/adaptive-sessions/read-praxis-public-resource.tool.js";
import { registerInspectPraxisStructureTool } from "../tools/adaptive-sessions/inspect-praxis-structure.tool.js";
import { registerReadPraxisPublicStructureValueTool } from "../tools/adaptive-sessions/read-praxis-public-structure-value.tool.js";
import { registerInspectPraxisRuntimeStateTool } from "../tools/adaptive-sessions/inspect-praxis-runtime-state.tool.js";
import { registerReadPraxisPublicRuntimeValueTool } from "../tools/adaptive-sessions/read-praxis-public-runtime-value.tool.js";
import { registerGetPraxisSessionTool } from "../tools/adaptive-sessions/get-praxis-session.tool.js";
import { registerReconcilePraxisUnknownOperationTool } from "../tools/adaptive-sessions/reconcile-praxis-unknown-operation.tool.js";
import { registerClosePraxisSessionTool } from "../tools/adaptive-sessions/close-praxis-session.tool.js";
import { registerStartRunTool } from "../tools/runs/start-run.tool.js";
import { registerAgentDirectedRunTool } from "../tools/runs/agent-directed-run.tool.js";
import { registerAttachRunPraxisSessionTool } from "../tools/runs/attach-run-praxis-session.tool.js";
import { registerFinalizeRunTool } from "../tools/runs/finalize-run.tool.js";
import { registerGetRunTool } from "../tools/runs/get-run.tool.js";
import { registerAcceptObjectiveEvidenceTool } from "../tools/runs/accept-objective-evidence.tool.js";
import { registerGetMissionTool } from "../tools/missions/get-mission.tool.js";
import { registerGrantMissionExecutionAuthorizationTool } from "../tools/missions/grant-mission-execution-authorization.tool.js";
import { registerUpdateMissionObjectiveTool } from "../tools/missions/update-mission-objective.tool.js";
import { registerFinalizeAgentWorkTool } from "../tools/missions/finalize-agent-work.tool.js";
import { registerPreviewMissionReportTool } from "../tools/missions/preview-mission-report.tool.js";
import { registerPublishMissionReportTool } from "../tools/missions/publish-mission-report.tool.js";
import { registerEndAgentSessionTool } from "../tools/missions/end-agent-session.tool.js";

export { Q5_MCP_PROFILE, Q5_MCP_TOOL_NAMES };

export function createQ5McpServer(client: ScryApiClient) {
  const server = createScryServerComposition(Q5_MCP_PROFILE);
  registerGetCapabilitiesTool(server, client);
  registerGetOperatingContextTool(server, client);
  registerListEnvironmentsTool(server, client);
  registerListProjectCredentialsTool(server, client);
  registerStartPraxisSessionTool(server, client);
  registerObservePraxisSessionTool(server, client);
  registerInspectPraxisRegionTool(server, client);
  registerReadPraxisPublicValueTool(server, client);
  registerInspectPraxisResourcesTool(server, client);
  registerReadPraxisPublicResourceTool(server, client);
  registerInspectPraxisStructureTool(server, client);
  registerReadPraxisPublicStructureValueTool(server, client);
  registerInspectPraxisRuntimeStateTool(server, client);
  registerReadPraxisPublicRuntimeValueTool(server, client);
  registerGetPraxisSessionTool(server, client);
  registerReconcilePraxisUnknownOperationTool(server, client);
  registerClosePraxisSessionTool(server, client);
  registerStartRunTool(server, client);
  registerAgentDirectedRunTool(server, client);
  registerAttachRunPraxisSessionTool(server, client);
  registerFinalizeRunTool(server, client);
  registerGetRunTool(server, client);
  registerAcceptObjectiveEvidenceTool(server, client);
  registerGetMissionTool(server, client);
  registerGrantMissionExecutionAuthorizationTool(server, client);
  registerUpdateMissionObjectiveTool(server, client);
  registerFinalizeAgentWorkTool(server, client);
  registerPreviewMissionReportTool(server, client);
  registerPublishMissionReportTool(server, client);
  registerEndAgentSessionTool(server, client);
  return server;
}

export async function inspectQ5McpContract(client: ScryApiClient) {
  const server = createQ5McpServer(client);
  const inspector = new Client({ name: "scry-q5-contract-inspector", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await inspector.connect(clientTransport);
  try {
    const tools = (await inspector.listTools()).tools;
    const digest = createHash("sha256")
      .update(JSON.stringify({ profile: Q5_MCP_PROFILE, tools }))
      .digest("hex");
    return {
      protocolVersion: "2025-11-25",
      profile: Q5_MCP_PROFILE,
      toolNames: tools.map(({ name }) => name),
      toolCount: tools.length,
      digest,
    };
  } finally {
    await inspector.close();
    await server.close();
  }
}
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
