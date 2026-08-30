import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { observedOperationContractsResultSchema } from "@scry/contracts";
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
        "Project bounded redacted request/response operation facts from the current public document. Canonical operation and field keys are authority; labels and aliases are display-only.",
      inputSchema: { praxisSessionId: z.string().uuid() },
      outputSchema: z
        .object({ message: z.string(), observation: observedOperationContractsResultSchema })
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
            "Current redacted operation contracts observed with factual provenance.",
          ),
        "Operation-contract observation was refused.",
      ),
  );
}
