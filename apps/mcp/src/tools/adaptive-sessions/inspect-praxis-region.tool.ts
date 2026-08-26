import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inspectPraxisRegionInputSchema, inspectPraxisRegionResultSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerInspectPraxisRegionTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "inspect_praxis_region",
    {
      title: "Inspect exact Praxis semantic region",
      description:
        "Discover bounded ordinary public-value references inside one exact current semantic region without returning its plaintext. First call observe_praxis_session, then choose the exact context-control reference associated with the semantic region you need and call inspect_praxis_region. Use the returned context-value references with read_praxis_public_value to release one exact Veil-admitted public value. The control and discovered values remain bound to the exact current Page/document/entities; no selector, text, role, list-position, or semantic-similarity fallback is used.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...inspectPraxisRegionInputSchema.shape,
      },
      outputSchema: z
        .object({
          message: z.string(),
          inspection: inspectPraxisRegionResultSchema,
        })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              inspection: await client.post(
                `/praxis-sessions/${praxisSessionId}/regions/inspect`,
                input,
              ),
            },
            "Exact Praxis region inspected; choose a returned public-value reference to read.",
          ),
        "Praxis region inspection refused.",
      ),
  );
}
