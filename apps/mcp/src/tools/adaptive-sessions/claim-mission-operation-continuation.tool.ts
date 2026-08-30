import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  claimMissionOperationContinuationSchema,
  missionOperationContinuationClaimResultSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerClaimMissionOperationContinuationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "claim_mission_operation_continuation",
    {
      title: "Claim mutation continuation",
      description:
        "Claim one Chronicle mutation checkpoint for a new exact consumer. Applied sources admit read_only_retrieve or reconcile; UNKNOWN admits reconcile only. The source mutation is permanently non-repeatable.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...claimMissionOperationContinuationSchema.shape,
      },
      outputSchema: z
        .object({
          message: z.string(),
          continuation: missionOperationContinuationClaimResultSchema,
        })
        .strict(),
      annotations: writes,
    },
    async ({ praxisSessionId, ...input }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              continuation: await client.post(
                `/praxis-sessions/${praxisSessionId}/operation-checkpoints/claim`,
                claimMissionOperationContinuationSchema.parse(input),
              ),
            },
            "Mutation checkpoint claimed by a new non-repeating continuation operation.",
          ),
        "Mutation continuation claim was refused.",
      ),
  );
}
