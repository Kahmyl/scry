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
        "Reserve one immutable protected operation against an observed operation-contract digest, exact current Praxis session/document, canonical fields, typed values, targets, and outputs. For an exact continuation, pass continuationReference and omit its identity field from values; Scry derives it atomically. The kernel assigns a bounded expiry; dispatch the returned handle while its runtime authority is current. This performs no external side effect and requires no second owner approval.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        ...reservePreparedProtectedOperationSchema.omit({
          targetCommitment: true,
          inputCommitment: true,
          outputCommitment: true,
          expiresAt: true,
        }).shape,
      },
      outputSchema: z
        .object({
          message: z.string(),
          preparedOperation: preparedProtectedOperationReservationResultSchema,
        })
        .strict(),
      annotations: writes,
    },
    async (input) => {
      const { praxisSessionId, ...body } = input;
      return withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              preparedOperation: await client.post(
                `/praxis-sessions/${praxisSessionId}/protected-operations/reserve`,
                reservePreparedProtectedOperationSchema.parse(body),
              ),
            },
            "Operation prepared without dispatch; execute the returned handle when ready.",
          ),
        "Prepared protected operation reservation was refused.",
      );
    },
  );
}
