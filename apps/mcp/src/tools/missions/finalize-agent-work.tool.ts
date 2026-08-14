import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { finalizeAgentWorkSchema, finalizedAgentWorkSchema } from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";

export function registerFinalizeAgentWorkTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("finalize_agent_work", {
    title: "Finalize agent work",
    description: "After every related Flow authoring session is safely closed, atomically persist an explicit terminal Objective decision and end its agent session, or persist a durable awaiting-user pointer and interrupt the session. terminal_objective requires objectiveStatus passed|failed|blocked|skipped, conclusion, sessionStatus completed|failed, and expectedMissionRevision from get_mission. await_user requires the established complete pointer and expected revision. This never infers success, cannot terminalize an UNKNOWN/running browser operation, and does not publish a Mission report.",
    inputSchema: finalizeAgentWorkSchema,
    outputSchema: finalizedAgentWorkSchema,
    annotations: writes,
  }, async (input) => {
    await client.requireCurrentRelease();
    const finalized = finalizedAgentWorkSchema.parse(await client.post(
      `/missions/${input.missionId}/finalize-agent-work`, input));
    return toolResult(finalized, input.kind === "await_user"
      ? "Durable user boundary persisted; agent session interrupted."
      : "Objective decision and agent-session completion persisted atomically.");
  });
}
