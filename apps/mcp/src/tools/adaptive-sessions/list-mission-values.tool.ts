import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { missionValueAssetsResultSchema } from "@scry/contracts";
import { z } from "zod";
import type { ScryApiClient } from "../../api-client.js";
import { toolResult, readOnly } from "../../tool-registry.js";
import { withAdaptiveSessionError } from "./shared.js";

export function registerListMissionValuesTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "list_mission_values",
    {
      title: "Discover durable generated value assets",
      description:
        "Read safe opaque generated assets and canonical output provenance from this Mission, even after its browser owner closes. No plaintext, ciphertext or executable references are returned. Reservation validates exact scope and presentation and derives internal one-use bindings.",
      inputSchema: { praxisSessionId: z.string().uuid() },
      outputSchema: z
        .object({ message: z.string(), result: missionValueAssetsResultSchema })
        .strict(),
      annotations: readOnly,
    },
    async ({ praxisSessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            {
              result: await client.get(`/praxis-sessions/${praxisSessionId}/value-assets`),
            },
            "Durable value provenance; no value material exposed.",
          ),
        "Value discovery was refused.",
      ),
  );
}
