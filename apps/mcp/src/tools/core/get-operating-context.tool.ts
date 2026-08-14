import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperatingContextSchema, operatingContextSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult } from "../../tool-registry.js";

export function registerGetOperatingContextTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("get_operating_context", {
    title: "Get agent operating context",
    description: "Return one bounded Project readiness view with resumable Missions, non-terminal awaiting_user lifecycle/paths, and safe Project credential candidates (opaque ref, name, security state, eligibility for authorization, authorized environments with completeness flag, timestamps). This never returns protected values. Credentials persist independently of Missions. Refresh after dashboard creation. A unique obvious semantic match may be used without needless confirmation; if candidates are multiple, role-ambiguous, stale/revoked, unrelated, or top-level/per-item truncated, ask using safe names/refs rather than guessing or selecting by order. Protected use remains separately constrained by Project scope and environment/task authorization.",
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
