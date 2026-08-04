import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult as result, uuid } from "../../tool-registry.js";

export function registerExtractArtifactHtmlTool(server: McpServer, client: ScryApiClient) {
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
