import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  randomUUID,
  advanceAdaptiveSessionSchema,
  agentDecisionBoundarySchema,
  closeAdaptiveSessionSchema,
  missionAuthoringTurnBudgetsSchema,
  recoverTrustedOriginsSchema,
  startAdaptiveSessionSchema,
  prepareFlowAuthoringSchema,
  preparedFlowAuthoringSchema,
  reconcileAdaptiveOperationSchema,
  agentProviderSchema,
  flowDraftPurposeSchema,
  flowRevisionContentSchema,
  z,
  readOnly,
  stableKey,
  toolResult,
  uuid,
  writes,
  publicPlanSchema,
  navigationExpectedEffectGuidance,
  hostAuthoringIntentSchema,
  withAdaptiveSessionError,
  type ScryApiClient,
} from "./shared.js";

export function registerAdvanceFlowAuthoringTool(server: McpServer, client: ScryApiClient) {
  if (process.env.NODE_ENV === "test")
    server.registerTool(
      "advance_flow_authoring",
      {
        title: "Advance Flow Authoring",
        description:
          navigationExpectedEffectGuidance +
          "Execute 1-20 semantic Mission authoring intents within budgets.maxOperations (1-20) and budgets.maxDurationMs (1000-60000), or continue one stable pending turn. For kind=intents provide intents and omit turnId; for kind=continue provide turnId and omit intents. kind=continue is admissible only when the exact returned turn state is pending. Omit idempotencyKey for a new continuation attempt; reuse an explicit key only to replay a response-lost attempt. A terminal decision_required environment failure may instead expose decisionBoundary.authoringRecovery; follow its exact recoveryTool/recoveryKind. recoveryKind=intents means resubmit the failed intent as a new turn with a fresh idempotency key, omit turnId, and preserve the listed Mission, Objective, Flow, session, and environment. Never reinterpret that descriptor as kind=continue. A stale recovery request returns MISSION_AUTHORING_RECOVERY_STALE with refreshedDecisionBoundary rather than a generic turn error. After process loss, continue is valid only for state=pending. If get_flow_authoring proves a running operation stayed not_dispatched, resubmit the exact original kind=intents payload with its original idempotencyKey after the stale runtime lease expires; Scry recovers that same durable turn rather than creating a new operation. Never do this after dispatch may have occurred. Every intent requires the complete constraints object {timeoutMs:100-60000,allowNewPage:boolean,allowNonExact:boolean}; allowNonExact has no implicit default. Action kinds are navigate, activate, fill, select, set_checked, press, wait_for, inspect, acquire_protected_outputs, and same_origin_request. Authorization kinds are ordinary, authentication, reversible, live_read, live_mutation, and protected_mutation. Every target requires concept plus either reference from the latest semanticPageContext or an observable role/name/label/placeholder/text/testId fact; the public field is reference, never authoritativeReference. Each returned control declares capabilities and, for text entry, inputSources: literal or protected_reference. When repeated controls have distinct group values, scope them as target.scope:{kind:'row',name:'<exact group>'}; do not invent root-level row or relations fields. Ordinary fill example action: {kind:'fill',target:{concept:'credential name',reference:'context-control-<32 lowercase hex>'},publicValue:'Scry Qualification 2026'}; pair it with authorization:{kind:'ordinary'}, constraints:{timeoutMs:30000,allowNewPage:false,allowNonExact:false}, expectedEffect:{kind:'none'}, and protectedInputReferences:[]. Never send publicValue to a control whose inputSources excludes literal. Valid roles: button, checkbox, combobox, dialog, field, form, heading, link, listbox, menuitem, option, radio, region, row, tab, table, textbox, text, value. Inspect example: {kind:'inspect',target:{concept:'email',role:'textbox',placeholder:'Email'}}. Fresh-reference example: {kind:'inspect',target:{concept:'observed control',reference:'context-control-<32 lowercase hex>'}}. semanticPageContext.sections contains bounded public factual text grouped by visible heading; use it to reason about relevant documentation without raw DOM or whole-document dumps. wait_for requires state, one of visible, hidden, attached, detached; example: {kind:'wait_for',target:{concept:'login form',role:'form'},state:'visible'}. An activate action must declare semanticEffect: read_context_transition only when its intended effect is proven to be read-only navigation or UI context selection; declare resource_mutation for a product/resource change, or unknown when the effect is not established. Missing or unknown effects fail closed under live_read. A login/authentication submit that only transitions into an authenticated read context uses semanticEffect:'read_context_transition' with authorization:{kind:'live_read'}; authentication authority is for protected input, not admission of that activation. A read-context transition may use a click but never authorizes production mutation. Protected fill example action: {kind:'fill',target:{concept:'password',role:'textbox'},protectedReferenceId:'<credential-uuid>'}; pair it with authorization:{kind:'authentication'}, constraints:{timeoutMs:30000,allowNewPage:false,allowNonExact:true}, expectedEffect:{kind:'none'}, and protectedInputReferences:['<same-credential-uuid>']. Protected acquisition must be atomic with its preparation intents in the same turn; action has no top-level target. Canonical action: {kind:'acquire_protected_outputs',preparationIntentIds:['create-credential'],mutation:{kind:'one_time',target:{concept:'create credential',role:'button',name:'Create'}},outputs:[{reference:'test-api-secret',classification:'protected',target:{concept:'generated API secret',role:'textbox'},storageName:'Test API secret'}]}. Pair it with authorization:{kind:'protected_mutation',authorizationId:'<authorization-uuid>'}, expectedEffect:{kind:'none'}, complete constraints, and protectedInputReferences:[]. outputs must contain 1-8 complete entries; preparationIntentIds must name earlier intents in that same submitted turn. Protected acquisition runs in the current live protected Praxis session. Preparation and mutation targets may use exact context-control references pinned by that same session; cross-session references, selector fallback, and semantic re-resolution are mechanically refused. Read completed[*].mutationOutcome before acting: not_applied permits only the reported prerequisite/revision path, applied may require effect observation, and unknown forbids blind retry. decisionBoundary.safeActions names the permitted continuation; pending returns the only stable turnId to continue. TARGET_NOT_FOUND means the observed target was absent; TARGET_NOT_ACTIONABLE or INSUFFICIENT_EVIDENCE is inconclusive and calls for fresh observation or a revised semantic target. Scry owns resolution, readiness, effect verification, journaling, and safe waiting; do not poll.",
        inputSchema: {
          sessionId: uuid,
          kind: z.enum(["intents", "continue"]),
          intents: z.array(hostAuthoringIntentSchema).min(1).max(20).optional(),
          turnId: uuid.optional(),
          budgets: missionAuthoringTurnBudgetsSchema,
          idempotencyKey: z.string().trim().min(8).max(200).optional(),
          recoveryBinding: agentDecisionBoundarySchema.shape.authoringRecovery.optional(),
        },
        annotations: writes,
      },
      async ({ sessionId, kind, intents, turnId, budgets, idempotencyKey, recoveryBinding }) =>
        withAdaptiveSessionError(async () => {
          await client.requireCurrentRelease();
          const body = advanceAdaptiveSessionSchema.parse(
            kind === "intents"
              ? {
                  kind,
                  intents,
                  budgets,
                  recoveryBinding,
                  idempotencyKey:
                    idempotencyKey ??
                    stableKey("flow-authoring-intents", {
                      sessionId,
                      intents,
                      budgets,
                      recoveryBinding,
                    }),
                }
              : {
                  kind,
                  turnId,
                  budgets,
                  idempotencyKey: idempotencyKey ?? `flow-authoring-continuation-${randomUUID()}`,
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
}
