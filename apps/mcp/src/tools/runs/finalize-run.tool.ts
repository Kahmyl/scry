import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { finalizeAgentDirectedRunSchema } from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, uuid, writes } from "../../tool-registry.js";

export function registerFinalizeRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "finalize_run",
    {
      title: "Finalize Run",
      description:
        "Explicitly finalize an agent-directed Run after the external agent interprets the recorded operation facts. Scry does not infer success or progression from expected effects.",
      inputSchema: { runId: uuid, ...finalizeAgentDirectedRunSchema.shape },
      annotations: writes,
    },
    async ({ runId, ...input }) => {
      await client.requireCurrentRelease();
      return toolResult(
        { run: await client.post(`/runs/${runId}/finalize`, input) },
        "Run finalized explicitly.",
      );
    },
  );
}
