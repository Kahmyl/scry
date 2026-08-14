import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOperatingContextSchema, operatingContextSchema } from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import { readOnly, toolResult } from "../../tool-registry.js";

export function registerGetOperatingContextTool(server: McpServer, client: ScryApiClient) {
  server.registerTool("get_operating_context", {
    title: "Get agent operating context",
    description: "Return one bounded Project readiness view with resumable Missions, factual environment policy/runtime admission, exact state-bound authoring recovery, unresolved UNKNOWN operation references, composed preparation availability, and safe Project credential candidates. runtime_required means the durable environment exists and is policy-valid but browser execution has not been admitted; runtime_admitted means an authoring session passed controlled runtime admission (not a process-liveness promise); recovery_required means inspect authoring.uncertain first, or follow authoring.recoverable's exact tool, kind, resource refs, and recoveryBinding. An uncertain item forbids redispatch and names the exact get_flow_authoring inspection target; only that result may expose reconcile_unknown_operation when authoritative evidence is currently available. Prefer exact recovery over replacement lifecycle state. This never returns protected values.",
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
      : context.authoring.uncertain.items.length
        ? "An unresolved UNKNOWN operation fences this Mission. Do not redispatch it. Call each uncertain item's exact inspectionTool with its sessionId; reconcile only if that current authoring result exposes reconciliation as available."
      : context.authoring.recoverable.items.length
        ? "Authoring is recoverable without replacing the Mission or Flow. Call the exact recoveryTool/recoveryKind and include the returned recoveryBinding; this is a fresh intents turn, never a pending-turn continuation."
      : context.authoring.ready
        ? "Authoring context is ready."
        : `Authoring context needs: ${context.authoring.missing.join(", ") || context.continuation.blockerCode}.`);
  });
}
