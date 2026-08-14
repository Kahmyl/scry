import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperatingContextSchema, operatingContextSchema } from "@scry/contracts";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult } from "../../tool-registry.js";

export function registerGetOperatingContextTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("get_operating_context", {
    title: "Get agent operating context",
    description: "Return one bounded, coherent readiness view of projects and, only when a project is unambiguous or explicitly selected, its resumable Missions, opaque credential references, compatible environments, and reusable authoring session. This never returns protected values and never guesses among multiple projects or Missions.",
    inputSchema: getOperatingContextSchema,
    outputSchema: operatingContextSchema,
    annotations: readOnly,
  }, async (input) => {
    const context = operatingContextSchema.parse(await client.post("/projects/operating-context", input));
    return toolResult(context, context.authoring.ready
      ? "Authoring context is ready."
      : `Authoring context needs: ${context.authoring.missing.join(", ") || context.continuation.blockerCode}.`);
  });
}
