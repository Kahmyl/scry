import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  preparedProtectedOperationResumeResultSchema,
  resumePreparedProtectedOperationSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { toolResult, writes } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerResumePreparedProtectedOperationTool(
  server: McpServer,
  client: ScryApiClient,
) {
  server.registerTool(
    "resume_prepared_protected_operation",
    {
      title: "Resume prepared protected operation",
      description:
        "Validate that the exact authorized reservation still belongs to the same live Praxis owner/fencing epoch and unchanged contract, targets, inputs, and outputs. Replacement inputs are not accepted.",
      inputSchema: resumePreparedProtectedOperationSchema.shape,
      outputSchema: z
        .object({ message: z.string(), resume: preparedProtectedOperationResumeResultSchema })
        .strict(),
      annotations: writes,
    },
    async (input) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              resume: await client.post(
                `/praxis-sessions/${input.praxisSessionId}/protected-operations/resume`,
                resumePreparedProtectedOperationSchema.parse(input),
              ),
            },
            "Exact prepared protected operation remains resumable by this live owner.",
          ),
        "Prepared protected operation resume was refused.",
      ),
  );
}
