import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { publishMissionReportSchema } from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { agentSessionFinalization, toolResult, writes } from "../../tool-registry.js";

export function registerPublishMissionReportTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "publish_mission_report",
    {
      title: "Publish final Mission report",
      description:
        "Explicitly publish the final Mission report and terminalize the Mission only after every Objective is reportable and all Praxis sessions, browser operations, Runs, Attempts, and Objective orchestration are at safe terminal boundaries. This tool never infers Mission success from a passed Run. Publication is idempotent and fail-closed; the external agent must provide the final conclusion and journey summary.",
      inputSchema: publishMissionReportSchema,
      annotations: writes,
    },
    async (input) => {
      await client.requireCurrentRelease();

      const report = await client.post(`/missions/${input.missionId}/reports`, input);

      return toolResult(
        {
          report,
          ...agentSessionFinalization(input.agentSessionId, "completed"),
        },
        "Final Mission report publication persisted at a terminal-safe boundary.",
      );
    },
  );
}
