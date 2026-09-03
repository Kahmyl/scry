import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readPraxisPublicResourceInputSchema,
  readPraxisPublicResourceResultSchema,
} from "@scry/contracts";
import { z } from "zod";
import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerReadPraxisPublicResourceTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "read_praxis_public_resource",
    {
      title: "Read exact admitted public browser resource",
      description:
        "Read bounded Veil-admitted text from one exact opaque same-origin resource reference returned by inspect_praxis_resources. The reference is session/document/body-snapshot scoped; stale, protected, unavailable, forged, and cross-origin resources are refused without plaintext.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...readPraxisPublicResourceInputSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), resource: readPraxisPublicResourceResultSchema })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              resource: await client.post(
                `/praxis-sessions/${praxisSessionId}/public-resources/read`,
                input,
              ),
            },
            "Exact Veil-admitted public browser resource loaded from its current reference.",
          ),
        "Public browser resource read refused.",
      ),
  );
}
