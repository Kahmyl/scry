import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  preparedProtectedOperationReservationResultSchema,
  reservePreparedProtectedOperationSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerReservePreparedProtectedOperationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "reserve_prepared_protected_operation",
    {
      title: "Reserve prepared protected operation",
      description:
        "Reserve one immutable protected operation against an observed operation-contract digest, exact current Praxis session/document, canonical fields, typed values, targets, and outputs. This performs no external side effect.",
      inputSchema: reservePreparedProtectedOperationSchema.shape,
      outputSchema: z
        .object({
          message: z.string(),
          preparedOperation: preparedProtectedOperationReservationResultSchema,
        })
        .strict(),
      annotations: writes,
    },
    async (input) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              preparedOperation: await client.post(
                `/praxis-sessions/${input.praxisSessionId}/protected-operations/reserve`,
                reservePreparedProtectedOperationSchema.parse(input),
              ),
            },
            "Prepared protected operation reserved without dispatch; exact authorization is required.",
          ),
        "Prepared protected operation reservation was refused.",
      ),
  );
}
