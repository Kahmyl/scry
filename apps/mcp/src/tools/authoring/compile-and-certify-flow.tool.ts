import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import {
  objectiveContext,
  stableKey,
  toolResult as result,
  uuid,
  writes,
} from "../../tool-registry.js";

export function registerCompileAndCertifyFlowTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "compile_and_certify_flow",
    {
      title: "Compile and certify Flow draft",
      description:
        "Compile successful authoring transcript knowledge and bind a fresh passing certification Run before publication.",
      inputSchema: {
        ...objectiveContext,
        draftId: uuid,
        environmentId: uuid,
        draftVersion: z.number().int().positive(),
        probeSessionId: uuid,
        authenticationContractRevisionId: uuid.optional(),
        viewport: z
          .object({
            width: z.number().int().min(320).max(3_840),
            height: z.number().int().min(320).max(2_160),
          })
          .default({ width: 1280, height: 720 }),
        seed: z.number().int().min(0).max(4_294_967_295).default(1),
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ draftId, idempotencyKey, ...body }) =>
      result(
        {
          result: await client.post(`/flow-drafts/${draftId}/compile-and-certify`, {
            ...body,
            idempotencyKey:
              idempotencyKey ?? stableKey("compile-and-certify", { draftId, ...body }),
          }),
        },
        "Flow draft compiled and a fresh certification Run queued.",
      ),
  );
}
