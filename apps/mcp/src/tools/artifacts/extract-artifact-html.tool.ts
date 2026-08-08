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
          "Extract bounded structural HTML and normalized text using one tag, #id, .class, or [data-testid=\"value\"] selector; combinators are not supported.",
        inputSchema: {
          artifactId: uuid,
          selector: z
            .string()
            .trim()
            .regex(/^(?:[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[data-testid=["'][^"']{1,200}["']\])$/),
        },
        annotations: readOnly,
      },
      async ({ artifactId, selector }) =>
        result(
          { extraction: await client.post(`/artifacts/${artifactId}/extract-html`, { selector }) },
          "HTML extraction complete.",
        ),
    );
}
