import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  dispatchPreparedProtectedOperationSchema,
  preparedProtectedOperationDispatchResultSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerDispatchPreparedProtectedOperationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "dispatch_prepared_protected_operation",
    {
      title: "Dispatch prepared protected operation",
      description:
        "Dispatch the exact previously reserved operation on its same live fenced Praxis owner. Dispatch validates the exact mechanical capability internally. This accepts only immutable reservation commitments and never replacement targets or inputs.",
      inputSchema: {
        praxisSessionId: z.string().uuid(),
        runId: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Existing durable Run attached to this owner; include it to bind canonical execution and evidence across owner rotation.",
          ),
        ...dispatchPreparedProtectedOperationSchema.shape,
      },
      outputSchema: z
        .object({ message: z.string(), dispatch: preparedProtectedOperationDispatchResultSchema })
        .strict(),
      annotations: writes,
    },
    async (input) => {
      const { praxisSessionId, runId, ...body } = input;
      return withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              dispatch: await client.post(
                runId
                  ? `/runs/${runId}/prepared-operations`
                  : `/praxis-sessions/${praxisSessionId}/protected-operations/dispatch`,
                {
                  ...dispatchPreparedProtectedOperationSchema.parse(body),
                  ...(runId ? { praxisSessionId } : {}),
                },
              ),
            },
            "The exact prepared protected operation was admitted for one fenced dispatch.",
          ),
        "Prepared protected operation dispatch was refused.",
      );
    },
  );
}
