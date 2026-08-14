import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  advanceAdaptiveSessionSchema,
  agentDecisionBoundarySchema,
  closeAdaptiveSessionSchema,
  missionAuthoringIntentSchema,
  missionAuthoringTurnBudgetsSchema,
  recoverTrustedOriginsSchema,
  startAdaptiveSessionSchema,
  prepareFlowAuthoringSchema,
  preparedFlowAuthoringSchema,
  agentProviderSchema,
  flowDraftPurposeSchema,
  flowRevisionContentSchema,
} from "@scry/contracts";
import { z } from "zod";

import { apiRejection, ScryApiError, type ScryApiClient } from "../../api-client.js";
import { readOnly, stableKey, toolResult, uuid, writes } from "../../tool-registry.js";
import { publicPlanSchema } from "../authoring/create-flow-draft.tool.js";

const navigationExpectedEffectGuidance =
  "Expected same-page navigation accepts {kind:'navigation',url:'https://example.test/path',match:'exact'}; urlPattern is also accepted as a host-compatible alias for the same absolute URL, but never provide both url and urlPattern. For a link or control expected to open a new page, declare constraints.allowNewPage:true AND expectedEffect:{kind:'new_page'}; optionally include the known destination origin as origin. allowNewPage alone grants permission but does not arm safe new-page adoption, and expectedEffect:{kind:'none'} keeps authority on the current page. ";

export function registerAdaptiveSessionTools(server: McpServer, client: ScryApiClient) {
  server.registerTool("prepare_flow_authoring", {
    title: "Prepare Flow Authoring",
    description: "Atomically create the supplied durable Mission, agent session, first Objective, Flow draft, and provisioning authoring session, then admit browser runtime before returning success. A runtime admission failure preserves the durable lifecycle and returns factual recovery; it is not an atomic browser-side effect. Reuse only an exact active authoringSessionId returned by get_operating_context. This performs no authored browser navigation or product action and never infers equivalence between Missions or Objectives.",
    inputSchema: {
      kind: z.enum(["create", "reuse"]),
      projectId: uuid,
      environmentId: uuid.optional(),
      authoringSessionId: uuid.optional(),
      mission: z.object({
        title: z.string().trim().min(1).max(200),
        originalInstruction: z.string().trim().min(1).max(20_000),
        provider: agentProviderSchema.default("codex"),
        instructionSnapshot: z.string().trim().min(1).max(20_000),
        connectionId: z.string().trim().min(1).max(500).optional(),
        distinctReason: z.string().trim().min(1).max(2_000).optional(),
      }).strict().optional(),
      objective: z.object({
        title: z.string().trim().min(1).max(200), description: z.string().trim().max(2_000).default(""),
        dependencies: z.array(uuid).max(0).default([]),
        completionCriteria: z.array(z.object({ description: z.string().trim().min(1).max(2_000),
          required: z.boolean().default(true) }).strict()).min(1).max(100),
        order: z.number().int().nonnegative(),
      }).strict().optional(),
      draft: z.object({
        name: z.string().trim().min(1).max(200), description: z.string().trim().max(2_000).default(""),
        purpose: flowDraftPurposeSchema.default("primary"), content: flowRevisionContentSchema,
        plan: publicPlanSchema,
      }).strict().optional(),
      authoring: z.object({
        objective: z.string().trim().min(1).max(4_000),
        allowedOrigins: z.array(z.string().url()).min(1).max(20),
        turnBudgets: missionAuthoringTurnBudgetsSchema.default({ maxOperations: 20, maxDurationMs: 60_000 }),
        initialProtectedReferenceIds: z.array(uuid).max(20).default([]),
      }).strict().optional(),
      idempotencyKey: z.string().trim().min(8).max(200).optional(),
    },
    outputSchema: preparedFlowAuthoringSchema.extend({ message: z.string() }),
    annotations: writes,
  }, async (input) => withAdaptiveSessionError(async () => {
    await client.requireCurrentRelease();
    const body = prepareFlowAuthoringSchema.parse(input);
    const prepared = preparedFlowAuthoringSchema.parse(await client.post("/mission-flow-authoring/prepare", body));
    return toolResult(prepared, prepared.reused ? "Existing authoring session is ready." : "Flow authoring lifecycle prepared atomically.");
  }, "Flow authoring preparation was rejected."));

  server.registerTool(
    "start_flow_authoring",
    {
      title: "Start Flow Authoring",
      description: "Start one durable authoring session for an existing Mission-owned Flow draft and approved environment; an exact idempotency replay returns that same session. Scry provisions and verifies the controlled browser runtime before the session becomes active, so a successful response is execution-ready rather than merely a durable environment record. turnBudgets requires maxOperations 1-20 and maxDurationMs 1000-60000. Create the environment first; credentials are needed only for protected fills and must be authorized to that environment.",
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
      description: navigationExpectedEffectGuidance +
        "Execute 1-20 semantic Mission authoring intents within budgets.maxOperations (1-20) and budgets.maxDurationMs (1000-60000), or continue one stable pending turn. For kind=intents provide intents and omit turnId; for kind=continue provide turnId and omit intents. kind=continue is admissible only when the exact returned turn state is pending. A terminal decision_required environment failure may instead expose decisionBoundary.authoringRecovery; follow its exact recoveryTool/recoveryKind. recoveryKind=intents means resubmit the failed intent as a new turn with a fresh idempotency key, omit turnId, and preserve the listed Mission, Objective, Flow, session, and environment. Never reinterpret that descriptor as kind=continue. A stale recovery request returns MISSION_AUTHORING_RECOVERY_STALE with refreshedDecisionBoundary rather than a generic turn error. After process loss, continue is valid only for state=pending. If get_flow_authoring proves a running operation stayed not_dispatched, resubmit the exact original kind=intents payload with its original idempotencyKey after the stale runtime lease expires; Scry recovers that same durable turn rather than creating a new operation. Never do this after dispatch may have occurred. Every intent requires the complete constraints object {timeoutMs:100-60000,allowNewPage:boolean,allowNonExact:boolean}; allowNonExact has no implicit default. Action kinds are navigate, activate, fill, select, set_checked, press, wait_for, inspect, acquire_protected_outputs, and same_origin_request. Authorization kinds are ordinary, authentication, reversible, live_read, live_mutation, and protected_mutation. Every target requires concept plus either reference from the latest semanticPageContext or an observable role/name/label/placeholder/text/testId fact; the public field is reference, never authoritativeReference. Each returned control declares capabilities and, for text entry, inputSources: literal or protected_reference. Ordinary fill example action: {kind:'fill',target:{concept:'credential name',reference:'context-control-<32 lowercase hex>'},publicValue:'Scry Qualification 2026'}; pair it with authorization:{kind:'ordinary'}, constraints:{timeoutMs:30000,allowNewPage:false,allowNonExact:false}, expectedEffect:{kind:'none'}, and protectedInputReferences:[]. Never send publicValue to a control whose inputSources excludes literal. Valid roles: button, checkbox, combobox, dialog, field, form, heading, link, listbox, menuitem, option, radio, region, row, tab, table, textbox, text, value. Inspect example: {kind:'inspect',target:{concept:'email',role:'textbox',placeholder:'Email'}}. Fresh-reference example: {kind:'inspect',target:{concept:'observed control',reference:'context-control-<32 lowercase hex>'}}. semanticPageContext.sections contains bounded public factual text grouped by visible heading; use it to reason about relevant documentation without raw DOM or whole-document dumps. wait_for requires state, one of visible, hidden, attached, detached; example: {kind:'wait_for',target:{concept:'login form',role:'form'},state:'visible'}. An activate action must declare semanticEffect: read_context_transition only when its intended effect is proven to be read-only navigation or UI context selection; declare resource_mutation for a product/resource change, or unknown when the effect is not established. Missing or unknown effects fail closed under live_read. A login/authentication submit that only transitions into an authenticated read context uses semanticEffect:'read_context_transition' with authorization:{kind:'live_read'}; authentication authority is for protected input, not admission of that activation. A read-context transition may use a click but never authorizes production mutation. Protected fill example action: {kind:'fill',target:{concept:'password',role:'textbox'},protectedReferenceId:'<credential-uuid>'}; pair it with authorization:{kind:'authentication'}, constraints:{timeoutMs:30000,allowNewPage:false,allowNonExact:true}, expectedEffect:{kind:'none'}, and protectedInputReferences:['<same-credential-uuid>']. Read completed[*].mutationOutcome before acting: not_applied permits only the reported prerequisite/revision path, applied may require effect observation, and unknown forbids blind retry. decisionBoundary.safeActions names the permitted continuation; pending returns the only stable turnId to continue. TARGET_NOT_FOUND means the observed target was absent; TARGET_NOT_ACTIONABLE or INSUFFICIENT_EVIDENCE is inconclusive and calls for fresh observation or a revised semantic target. Scry owns resolution, readiness, effect verification, journaling, and safe waiting; do not poll.",
      inputSchema: {
        sessionId: uuid,
        kind: z.enum(["intents", "continue"]),
        intents: z.array(missionAuthoringIntentSchema).min(1).max(20).optional(),
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
                  idempotencyKey ?? stableKey("flow-authoring-intents", { sessionId, intents, budgets, recoveryBinding }),
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
    "recover_trusted_script_origins",
    {
      title: "Recover trusted script origins",
      description:
        "Atomically recover an ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED boundary. approvedOrigins must exactly match the safely disclosed missingTrustedScriptOrigins on the source authoring session; this call records explicit approval but never chooses or guesses origins. It creates an immutable replacement environment, cloned Mission-owned Flow draft, and replacement authoring session. Navigation is not performed and remains a separate advance_flow_authoring action.",
      inputSchema: {
        ...recoverTrustedOriginsSchema.omit({ idempotencyKey: true }).shape,
        idempotencyKey: recoverTrustedOriginsSchema.shape.idempotencyKey.optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...input }) =>
      withAdaptiveSessionError(async () => {
        await client.requireCurrentRelease();
        const body = recoverTrustedOriginsSchema.parse({
          ...input,
          idempotencyKey: idempotencyKey ?? stableKey("trusted-origin-recovery", input),
        });
        return toolResult(
          { recovery: await client.post("/mission-flow-authoring/recover-trusted-origins", body) },
          "Trusted-origin recovery lifecycle created atomically; navigation remains pending.",
        );
      }, "Trusted-origin recovery was rejected."),
  );

  server.registerTool(
    "get_flow_authoring",
    {
      title: "Reconnect to Flow Authoring",
      description:
        "Read durable Mission authoring state only after client or worker interruption, stale recovery, or when the user explicitly requests status. latestTurn.continuation exists only for a genuinely pending turn. For terminal environment failures, use decisionBoundary.authoringRecovery exactly; it binds the current Mission, Objective, Flow, session, environment, failed operation, and the admissible intents-vs-continue kind. Do not poll this tool.",
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
