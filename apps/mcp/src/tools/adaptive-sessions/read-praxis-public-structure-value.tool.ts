import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readPraxisPublicStructureValueInputSchema,
  readPraxisPublicStructureValueResultSchema,
} from "@scry/contracts";
import { z } from "zod";
import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";
export function registerReadPraxisPublicStructureValueTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "read_praxis_public_structure_value",
    {
      title: "Read exact public structure field",
      description:
        "Read one Veil-admitted closed field from one exact opaque structural reference. Stale, protected, and unavailable fields are refused without plaintext.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...readPraxisPublicStructureValueInputSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), value: readPraxisPublicStructureValueResultSchema })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              value: await client.post(
                `/praxis-sessions/${praxisSessionId}/public-structure-values/read`,
                input,
              ),
            },
            "Exact Veil-admitted public structure field loaded.",
          ),
        "Public structure field read refused.",
      ),
  );
}
