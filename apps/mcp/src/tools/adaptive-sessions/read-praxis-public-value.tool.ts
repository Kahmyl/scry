import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readPraxisPublicValueInputSchema,
  readPraxisPublicValueResultSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerReadPraxisPublicValueTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "read_praxis_public_value",
    {
      title: "Read exact admitted public value",
      description:
        "Read one bounded exact public text/value from an opaque readableValues reference returned by the current observe_praxis_session result. The reference is bound to the exact current Page/document/entity and is never re-resolved by selector, role, text, list position, or semantic similarity. Veil reclassifies the current value immediately before release; protected or unknown content is refused without returning plaintext. Use offset/maxBytes for bounded pagination.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...readPraxisPublicValueInputSchema.shape,
      },
      outputSchema: z
        .object({
          message: z.string(),
          value: readPraxisPublicValueResultSchema,
        })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              value: await client.post(
                `/praxis-sessions/${praxisSessionId}/public-values/read`,
                input,
              ),
            },
            "Exact Veil-admitted public value loaded from the current document reference.",
          ),
        "Public value read refused.",
      ),
  );
}
