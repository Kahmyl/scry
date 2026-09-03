import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { missionRelationFactSchema, missionRelationKindSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import {
  idempotentDurableWrite,
  missionContext,
  stableKey,
  toolResult,
  uuid,
} from "../../tool-registry.js";

const missionRelationResultSchema = missionRelationFactSchema
  .extend({ replayed: z.boolean() })
  .strict();

export function registerRelateMissionsTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "relate_missions",
    {
      title: "Relate distinct Missions",
      description:
        "Append a factual same-Project relation from the current source Mission to a distinct target Mission, using a bounded privacy-safe reason with no protected values. Use this after the user explicitly authorized separate diagnostic or recovery work; never auto-create a Mission. A relation discloses provenance only: it cannot move UNKNOWN mutation truth, transfer blockers or completion authority, or admit source evidence into the target. If the target truly depends on a fact, model that requirement in the target's own Objectives and evidence.",
      inputSchema: {
        ...missionContext,
        targetMissionId: uuid,
        relation: missionRelationKindSchema,
        reason: z.string().trim().min(1).max(2_000),
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
      outputSchema: z
        .object({
          message: z.string(),
          relation: missionRelationResultSchema,
        })
        .strict(),
      annotations: idempotentDurableWrite,
    },
    async ({ missionId, idempotencyKey, ...body }) =>
      toolResult(
        {
          relation: missionRelationResultSchema.parse(
            await client.post(`/missions/${missionId}/relations`, {
              missionId,
              ...body,
              idempotencyKey:
                idempotencyKey ?? stableKey("mission-relation", { missionId, ...body }),
            }),
          ),
        },
        "Cross-Mission factual provenance recorded without transferring lifecycle authority.",
      ),
  );
}
