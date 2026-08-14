import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperatingContextSchema, operatingContextSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult } from "../../tool-registry.js";

export function registerGetOperatingContextTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("get_operating_context", {
    title: "Get agent operating context",
    description: "Return one bounded Project readiness view with resumable Missions, factual environment policy/runtime admission, exact state-bound authoring recovery, composed preparation availability, and safe Project credential candidates. runtime_required means the durable environment exists and is policy-valid but browser execution has not been admitted; runtime_admitted means an authoring session passed controlled runtime admission (not a process-liveness promise); recovery_required means follow authoring.recoverable's exact tool, kind, resource refs, and recoveryBinding. Prefer that recovery over creating replacement drafts or sessions. prepare_flow_authoring is the composed durable lifecycle preparation action when advertised. This never returns protected values.",
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
      : context.authoring.recoverable.items.length
        ? "Authoring is recoverable without replacing the Mission or Flow. Call the exact recoveryTool/recoveryKind and include the returned recoveryBinding; this is a fresh intents turn, never a pending-turn continuation."
      : context.authoring.ready
        ? "Authoring context is ready."
        : `Authoring context needs: ${context.authoring.missing.join(", ") || context.continuation.blockerCode}.`);
  });
}
