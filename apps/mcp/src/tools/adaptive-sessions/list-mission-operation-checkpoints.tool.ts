import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { missionOperationCheckpointsResultSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerListMissionOperationCheckpointsTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "list_mission_operation_checkpoints",
    {
      title: "List mutation checkpoints",
      description:
        "Read safe Chronicle business-mutation receipts and their permitted read-only or reconciliation continuations. Source mutations are permanently non-repeatable.",
      inputSchema: { praxisSessionId: z.string().uuid() },
      outputSchema: z
        .object({ message: z.string(), result: missionOperationCheckpointsResultSchema })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              result: await client.get(`/praxis-sessions/${praxisSessionId}/operation-checkpoints`),
            },
            "Safe Chronicle mutation checkpoints loaded.",
          ),
        "Mutation checkpoint read was refused.",
      ),
  );
}
