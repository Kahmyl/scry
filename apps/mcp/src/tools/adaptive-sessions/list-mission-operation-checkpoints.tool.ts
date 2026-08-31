import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { missionContinuationsResultSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerListMissionOperationCheckpointsTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "list_mission_continuations",
    {
      title: "List Mission continuations",
      description:
        "Read the exact resource identity and eligible next operations from completed Mission work. Choose the next operation and pass its continuationReference during reservation; Scry derives the internal binding atomically.",
      inputSchema: { praxisSessionId: z.string().uuid() },
      outputSchema: z
        .object({ message: z.string(), result: missionContinuationsResultSchema })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              result: await client.get(`/praxis-sessions/${praxisSessionId}/continuations`),
            },
            "Mission continuations loaded.",
          ),
        "Continuation read was refused.",
      ),
  );
}
