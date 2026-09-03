import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  finalizeAgentDirectedRunSchema,
  finalizedAgentDirectedRunResultSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { idempotentDurableWrite, toolResult, uuid } from "../../tool-registry.js";

export function registerFinalizeRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "finalize_run",
    {
      title: "Finalize Run",
      description:
        "Explicitly finalize an agent-directed Run after the external agent interprets the recorded operation facts. Scry does not infer success or progression from expected effects.",
      inputSchema: { runId: uuid, ...finalizeAgentDirectedRunSchema.shape },
      outputSchema: z
        .object({ message: z.string(), run: finalizedAgentDirectedRunResultSchema })
        .strict(),
      annotations: idempotentDurableWrite,
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
