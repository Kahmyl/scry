import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  inspectPraxisRuntimeStateInputSchema,
  inspectPraxisRuntimeStateResultSchema,
} from "@scry/contracts";
import { z } from "zod";
import type { ScryApiClient } from "../../api-client.js";
import { externalFactualRead, toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";
export function registerInspectPraxisRuntimeStateTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "inspect_praxis_runtime_state",
    {
      title: "Inspect bounded Praxis runtime state",
      description:
        "Discover bounded opaque references to safely characterized page-owned JSON-like runtime state. No caller expression, evaluation, invocation, path, or browser state access is available.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...inspectPraxisRuntimeStateInputSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), inspection: inspectPraxisRuntimeStateResultSchema })
        .strict(),
      annotations: externalFactualRead,
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              inspection: await client.post(
                `/praxis-sessions/${praxisSessionId}/runtime-state/inspect`,
                {},
              ),
            },
            "Bounded runtime-state references inspected; choose one exact reference.",
          ),
        "Praxis runtime-state inspection refused.",
      ),
  );
}
