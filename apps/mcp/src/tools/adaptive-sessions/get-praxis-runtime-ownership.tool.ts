import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { praxisRuntimeOwnershipSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerGetPraxisRuntimeOwnershipTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "get_praxis_runtime_ownership",
    {
      title: "Get Praxis runtime ownership state",
      description:
        "Read durable session state separately from live browser ownership. Active does not imply owned. Internal owner IDs and fencing tokens are never exposed.",
      inputSchema: { praxisSessionId: z.string().uuid() },
      outputSchema: z
        .object({ message: z.string(), ownership: praxisRuntimeOwnershipSchema })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              ownership: await client.get(`/praxis-sessions/${praxisSessionId}/runtime-ownership`),
            },
            "Praxis durable and live-runtime ownership states loaded separately.",
          ),
        "Praxis runtime ownership read was refused.",
      ),
  );
}
