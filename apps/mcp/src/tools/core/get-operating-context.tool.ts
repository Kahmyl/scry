import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperatingContextSchema, operatingContextSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult } from "../../tool-registry.js";

export function registerGetOperatingContextTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("get_operating_context", {
    title: "Get agent operating context",
    description: "Return one bounded, coherent readiness view of projects and, only when selection is unambiguous, resumable Missions, their non-terminal awaiting_user lifecycle and factual fulfillment paths, opaque credential references, compatible environments, and reusable authoring. This never returns protected values. After dashboard credential creation, call this again to discover references by name; if multiple candidates fit, ask rather than guess.",
    inputSchema: getOperatingContextSchema,
    outputSchema: operatingContextSchema.extend({ message: z.string() }),
    annotations: readOnly,
  }, async (input) => {
    const context = operatingContextSchema.parse(await client.post("/projects/operating-context", input));
    const selectedMission = context.missions.candidates.items.find(
      (mission) => mission.id === context.missions.selectedMissionId,
    );
    return toolResult(context, selectedMission?.status === "awaiting_user"
      ? "This is a non-terminal human prerequisite. Preserve and resume the same Mission/Objective; explain the factual fulfillment paths and do not publish a final result while input remains obtainable."
      : context.authoring.ready
        ? "Authoring context is ready."
        : `Authoring context needs: ${context.authoring.missing.join(", ") || context.continuation.blockerCode}.`);
  });
}
