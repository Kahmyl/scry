import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  inspectPraxisBrowserResourcesInputSchema,
  inspectPraxisBrowserResourcesResultSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerInspectPraxisResourcesTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "inspect_praxis_resources",
    {
      title: "Inspect bounded current Praxis browser resources",
      description:
        "Discover bounded opaque references to already-loaded same-origin textual browser resources without returning URLs, request data, headers, or body plaintext. Select one exact returned resource reference and call read_praxis_public_resource; no fetch, navigation, replay, or cross-origin following occurs.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...inspectPraxisBrowserResourcesInputSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), inspection: inspectPraxisBrowserResourcesResultSchema })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              inspection: await client.post(
                `/praxis-sessions/${praxisSessionId}/resources/inspect`,
                input,
              ),
            },
            "Bounded same-origin browser resources inspected; choose one exact resource reference to read.",
          ),
        "Praxis resource inspection refused.",
      ),
  );
}
