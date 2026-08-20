import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { attachRunPraxisSessionSchema } from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, uuid, writes } from "../../tool-registry.js";

export function registerAttachRunPraxisSessionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "attach_run_praxis_session",
    {
      title: "Attach a new live Praxis session",
      description:
        "Attach a new live Praxis session epoch after session loss. Run remains a durable ledger and never owns or creates the browser. Old references remain permanently stale; call observe_praxis_session and select a new exact reference before dispatch.",
      inputSchema: { runId: uuid, ...attachRunPraxisSessionSchema.shape },
      annotations: writes,
    },
    async ({ runId, ...input }) => {
      await client.requireCurrentRelease();
      return toolResult(
        { binding: await client.post(`/runs/${runId}/praxis-session`, input) },
        "New Praxis session epoch attached; re-observation is required.",
      );
    },
  );
}
