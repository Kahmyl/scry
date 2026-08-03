import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../api-client.js";
import { readOnly, toolResult as result, uuid } from "../tool-registry.js";

export function registerArtifactTools(server: McpServer, client: ScryApiClient) {
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

  server.registerTool(
    "extract_artifact_html",
    {
      title: "Extract artifact HTML",
      description:
        "Extract bounded structural HTML and normalized text using a validated CSS selector.",
      inputSchema: { artifactId: uuid, selector: z.string().trim().min(1).max(500) },
      annotations: readOnly,
    },
    async ({ artifactId, selector }) =>
      result(
        { extraction: await client.post(`/artifacts/${artifactId}/extract-html`, { selector }) },
        "HTML extraction complete.",
      ),
  );
}
