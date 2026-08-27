import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readPraxisPublicRuntimeValueInputSchema,
  readPraxisPublicRuntimeValueResultSchema,
} from "@scry/contracts";
import { z } from "zod";
import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";
export function registerReadPraxisPublicRuntimeValueTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "read_praxis_public_runtime_value",
    {
      title: "Read exact public runtime value",
      description:
        "Read one Veil-admitted exact opaque runtime value. No code, expressions, getters, functions, paths, or arbitrary runtime access are accepted.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...readPraxisPublicRuntimeValueInputSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), value: readPraxisPublicRuntimeValueResultSchema })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              value: await client.post(
                `/praxis-sessions/${praxisSessionId}/public-runtime-values/read`,
                input,
              ),
            },
            "Exact Veil-admitted public runtime value loaded.",
          ),
        "Public runtime value read refused.",
      ),
  );
}
