import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult as result, uuid } from "../../tool-registry.js";

export function registerGetArtifactTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
      "get_artifact",
      {
        title: "Get artifact",
        description: "Read a bounded text page or return a stable Scry resource identifier.",
        inputSchema: {
          artifactId: uuid,
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(262_144).default(65_536),
        },
        annotations: readOnly,
      },
      async ({ artifactId, offset, limit }) => {
        await client.requireCurrentRelease();
        const metadata = await client.get<{ contentType: string }>(
          `/artifacts/${artifactId}/metadata`,
        );
        if (
          metadata.contentType.startsWith("text/") ||
          metadata.contentType.includes("json") ||
          metadata.contentType.includes("html")
        ) {
          const page = await client.get(
            `/artifacts/${artifactId}/text?offset=${offset}&limit=${limit}`,
          );
          return result(
            { artifactId, resource: `scry://artifact/${artifactId}`, metadata, page },
            "Artifact page loaded.",
          );
        }
        return result(
          { artifactId, resource: `scry://artifact/${artifactId}`, metadata },
          "Binary artifact is available as a Scry resource.",
        );
      },
    );
}
