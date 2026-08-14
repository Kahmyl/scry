import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { finalizeAgentWorkSchema, finalizedAgentWorkSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";

export function registerFinalizeAgentWorkTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("finalize_agent_work", {
    title: "Finalize agent work",
    description: "After every related Flow authoring session is safely closed, atomically persist an explicit terminal Objective decision and end its agent session, or persist a NON-TERMINAL durable awaiting-user pointer and interrupt the session. await_user means the task and same Mission/Objective remain active and resumable: send an intermediate user message describing factual fulfillmentPaths, do not publish a final report, do not mark failure, and do not create a replacement Mission. terminal_objective is denied while the Mission awaits obtainable human input; explicit cancellation uses cancel_mission_orchestration. This never infers success and cannot terminalize an UNKNOWN/running browser operation.",
    inputSchema: finalizeAgentWorkSchema,
    outputSchema: finalizedAgentWorkSchema.extend({ message: z.string() }),
    annotations: writes,
  }, async (input) => {
    await client.requireCurrentRelease();
    const finalized = finalizedAgentWorkSchema.parse(await client.post(
      `/missions/${input.missionId}/finalize-agent-work`, input));
    return toolResult(finalized, input.kind === "await_user"
      ? "Non-terminal user boundary persisted; the same Mission and Objective remain active and resumable. Communicate the supported fulfillment paths, do not issue a final Mission result, and resume after the human prerequisite is satisfied."
      : "Objective decision and agent-session completion persisted atomically.");
  });
}
