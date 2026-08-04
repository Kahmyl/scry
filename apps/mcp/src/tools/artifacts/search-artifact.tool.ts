import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult as result, uuid } from "../../tool-registry.js";

export function registerSearchArtifactTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
      "search_artifact",
      {
        title: "Search artifact",
        description: "Search textual artifact content with bounded context.",
        inputSchema: {
          artifactId: uuid,
          query: z.string().min(1).max(500),
          maxMatches: z.number().int().min(1).max(100).default(20),
        },
        annotations: readOnly,
      },
      async ({ artifactId, ...body }) =>
        result(
          { search: await client.post(`/artifacts/${artifactId}/search`, body) },
          "Artifact search complete.",
        ),
    );
}
