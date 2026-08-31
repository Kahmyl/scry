import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operationContractDiscoveryResultSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerObserveOperationContractsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "observe_operation_contracts",
    {
      title: "Observe operation contracts",
      description:
        "Read durable redacted operation-contract revisions, canonical inputs/outputs and transport mappings, with separate current interaction availability. Closed owners remain readable without executable refs. Canonical keys are semantic authority; labels and aliases are display-only. Known semantics alone never authorize browser execution.",
      inputSchema: { praxisSessionId: z.string().uuid() },
      outputSchema: z
        .object({ message: z.string(), observation: operationContractDiscoveryResultSchema })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              observation: await client.get(
                `/praxis-sessions/${praxisSessionId}/operation-contracts`,
              ),
            },
            "Durable redacted operation-contract revisions with separate live interaction availability.",
          ),
        "Operation-contract observation was refused.",
      ),
  );
}
