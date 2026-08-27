import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  inspectPraxisStructureInputSchema,
  inspectPraxisStructureResultSchema,
} from "@scry/contracts";
import { z } from "zod";
import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";
export function registerInspectPraxisStructureTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "inspect_praxis_structure",
    {
      title: "Inspect bounded Praxis structure",
      description:
        "Discover bounded opaque structural references from the current main document without returning DOM, accessibility names, attributes, URLs, or CDP identifiers.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...inspectPraxisStructureInputSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), inspection: inspectPraxisStructureResultSchema })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              inspection: await client.post(
                `/praxis-sessions/${praxisSessionId}/structure/inspect`,
                {},
              ),
            },
            "Bounded structural references inspected; choose one exact reference and closed field.",
          ),
        "Praxis structure inspection refused.",
      ),
  );
}
