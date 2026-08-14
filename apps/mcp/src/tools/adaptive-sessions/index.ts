import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  advanceAdaptiveSessionSchema,
  closeAdaptiveSessionSchema,
  missionAuthoringIntentSchema,
  missionAuthoringTurnBudgetsSchema,
  startAdaptiveSessionSchema,
} from "@scry/contracts";
import { z } from "zod";

import { apiRejection, ScryApiError, type ScryApiClient } from "../../api-client.js";
import { readOnly, stableKey, toolResult, uuid, writes } from "../../tool-registry.js";

export function registerAdaptiveSessionTools(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "start_flow_authoring",
    {
      title: "Start Flow Authoring",
      description: "Start one durable browser session for an existing Mission-owned Flow draft and approved environment. turnBudgets requires maxOperations 1-20 and maxDurationMs 1000-60000. Create the environment first; credentials are needed only for protected fills and must be authorized to that environment.",
      inputSchema: {
        ...startAdaptiveSessionSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: startAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...input }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = startAdaptiveSessionSchema.parse({
          ...input,
          idempotencyKey: idempotencyKey ?? stableKey("flow-authoring-start", input),
        });
        return toolResult(
          { session: await client.post("/mission-flow-authoring", body) },
          "Mission-owned Flow authoring started.",
        );
      }, "Flow authoring start was rejected."),
  );

  server.registerTool(
    "advance_flow_authoring",
    {
      title: "Advance Flow Authoring",
      description:
        "Execute 1-20 semantic Mission authoring intents within budgets.maxOperations (1-20) and budgets.maxDurationMs (1000-60000), or continue one stable pending turn. For kind=intents provide intents and omit turnId; for kind=continue provide turnId and omit intents. Action kinds are navigate, activate, fill, select, set_checked, press, wait_for, inspect, acquire_protected_outputs, and same_origin_request. Authorization kinds are ordinary, authentication, reversible, live_read, live_mutation, and protected_mutation. Every target requires concept plus either reference from the latest semanticPageContext or an observable role/name/label/placeholder/text/testId fact; the public field is reference, never authoritativeReference. Valid roles: button, checkbox, combobox, dialog, field, form, heading, link, listbox, menuitem, option, radio, region, row, tab, table, textbox, text, value. Inspect example: {kind:'inspect',target:{concept:'email',role:'textbox',placeholder:'Email'}}. Fresh-reference example: {kind:'inspect',target:{concept:'observed control',reference:'context-control-<32 lowercase hex>'}}. wait_for requires state, one of visible, hidden, attached, detached; example: {kind:'wait_for',target:{concept:'login form',role:'form'},state:'visible'}. An activate action must declare semanticEffect: read_context_transition only when its intended effect is proven to be read-only navigation or UI context selection; declare resource_mutation for a product/resource change, or unknown when the effect is not established. Missing or unknown effects fail closed under live_read. A read-context transition may use a click but never authorizes production mutation. Protected fill example action: {kind:'fill',target:{concept:'password',role:'textbox'},protectedReferenceId:'<credential-uuid>'}; pair it with authorization:{kind:'authentication'}, constraints:{timeoutMs:30000,allowNewPage:false,allowNonExact:true}, expectedEffect:{kind:'none'}, and protectedInputReferences:['<same-credential-uuid>']. Read completed[*].mutationOutcome before acting: not_applied permits only the reported prerequisite/revision path, applied may require effect observation, and unknown forbids blind retry. decisionBoundary.safeActions names the permitted continuation; pending returns the only stable turnId to continue. TARGET_NOT_FOUND means the observed target was absent; TARGET_NOT_ACTIONABLE or INSUFFICIENT_EVIDENCE is inconclusive and calls for fresh observation or a revised semantic target. Scry owns resolution, readiness, effect verification, journaling, and safe waiting; do not poll.",
      inputSchema: {
        sessionId: uuid,
        kind: z.enum(["intents", "continue"]),
        intents: z.array(missionAuthoringIntentSchema).min(1).max(20).optional(),
        turnId: uuid.optional(),
        budgets: missionAuthoringTurnBudgetsSchema,
        idempotencyKey: z.string().trim().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ sessionId, kind, intents, turnId, budgets, idempotencyKey }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = advanceAdaptiveSessionSchema.parse(
          kind === "intents"
            ? {
                kind,
                intents,
                budgets,
                idempotencyKey:
                  idempotencyKey ?? stableKey("flow-authoring-intents", { sessionId, intents, budgets }),
              }
            : {
                kind,
                turnId,
                budgets,
                idempotencyKey:
                  idempotencyKey ?? stableKey("flow-authoring-continuation", { sessionId, turnId, budgets }),
              },
        );
        return toolResult(
          { turn: await client.post(`/mission-flow-authoring/${sessionId}/advance`, body) },
          body.kind === "continue"
            ? "Mission authoring continuation reached its next durable boundary."
            : "Mission authoring turn reached a durable boundary.",
        );
      }, "Flow authoring advance was rejected."),
  );

  server.registerTool(
    "get_flow_authoring",
    {
      title: "Reconnect to Flow Authoring",
      description:
        "Read durable Mission authoring state only after client or worker interruption, or when the user explicitly requests status. Do not poll this tool.",
      inputSchema: { sessionId: uuid },
      annotations: readOnly,
    },
    async ({ sessionId }) =>
      withAdaptiveSessionError(
        async () =>
          toolResult(
            { session: await client.get(`/mission-flow-authoring/${sessionId}`) },
            "Mission authoring state loaded.",
          ),
        "Flow authoring reconnect was rejected.",
      ),
  );

  server.registerTool(
    "close_flow_authoring",
    {
      title: "Close Flow Authoring",
      description:
        "Close Mission authoring at a verified safe boundary. Unknown mutations must be reconciled before close.",
      inputSchema: {
        sessionId: uuid,
        idempotencyKey: closeAdaptiveSessionSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ sessionId, idempotencyKey }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = closeAdaptiveSessionSchema.parse({
          idempotencyKey: idempotencyKey ?? stableKey("flow-authoring-close", { sessionId }),
        });
        return toolResult(
          { session: await client.post(`/mission-flow-authoring/${sessionId}/close`, body) },
          "Mission authoring closed at a safe boundary.",
        );
      }, "Flow authoring close was rejected."),
  );
}

async function withAdaptiveSessionError<T>(operation: () => Promise<T>, rejectionMessage: string) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ScryApiError)) throw error;
    return {
      ...toolResult(
        {
          rejection: apiRejection(error),
        },
        rejectionMessage,
      ),
      isError: true,
    };
  }
}
