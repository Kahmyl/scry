import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  flowRevisionContentSchema,
  currentPlanSchema,
  executionPolicySchema,
  requestCalibrationSchema,
  flowPurposeSchema,
  flowVisibilitySchema,
  runRoleSchema,
  missionResumePointerSchema,
  executionBindingSchema,
  authorizationKindSchema,
  protectedRecoveryCommandSchema,
  veilPreferenceUpdateSchema,
  interactionTargetIntentSchema,
  budgetsSchema,
} from "@scry/contracts";
import { z } from "zod";

import type { ScryApiClient } from "../../api-client.js";
import {
  missionContext,
  objectiveContext,
  readOnly,
  stableKey,
  toolResult as result,
  uuid,
  writes,
} from "../../tool-registry.js";

const publicActionType = z.enum([
  "navigate", "sameOriginRequest", "click", "fill", "select", "check", "press", "scroll",
  "waitFor", "screenshot", "protectedTransaction", "capturePublicValue",
]);
const publicPlanActionSchema = z.object({
  type: publicActionType,
  url: z.string().optional(),
  target: interactionTargetIntentSchema.optional(),
  value: z.string().optional(),
  secretRef: uuid.optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().optional(),
  expectedStatus: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
  authentication: z.literal("current_browser_session").optional(),
  checked: z.boolean().optional(),
  key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]).optional(),
  deltaY: z.number().int().optional(),
  state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
  name: z.string().optional(),
  timeoutMs: z.number().int().optional(),
}).passthrough();
export const publicPlanSchema = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1),
  preconditions: z.array(z.string().trim().min(1)).max(20).default([]),
  allowedOrigins: z.array(z.string().url()).min(1).max(5),
  budgets: budgetsSchema,
  checkpoints: z.array(z.object({
    id: z.string(), beforeStepId: z.string(), restorationUrl: z.string().url(),
    verificationAssertions: z.array(z.unknown()).min(1), continueAtStepId: z.string(),
    maxRestorations: z.literal(1),
    state: z.object({ cookies: z.literal(true), localStorage: z.literal(true), indexedDb: z.boolean().optional() }),
  }).strict()).max(20).default([]),
  steps: z.array(z.object({
    id: z.string(), title: z.string(), action: publicPlanActionSchema,
    after: z.unknown().optional(), assertions: z.array(z.unknown()).optional(),
    onFailure: z.enum(["stop", "continue"]).optional(),
    evidence: z.array(z.enum(["screenshot", "dom", "network"])).optional(),
    captureIntent: z.enum(["final", "transient"]).optional(),
    transientJustification: z.string().optional(),
  }).strict()).min(1).max(500),
}).strict();

export function registerCreateFlowDraftTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "create_flow_draft",
    {
      title: "Create Flow draft",
      description: "Create mutable authoring state; this does not publish a Flow revision. plan.steps is required with at least one item. Each step requires {id,title,action}; after, assertions, onFailure, evidence, and captureIntent are optional. action.type is one of navigate, sameOriginRequest, click, fill, select, check, press, scroll, waitFor, screenshot, protectedTransaction, or capturePublicValue. Ordinary required fields by type: navigate+url; sameOriginRequest+method+path+expectedStatus+authentication; click+target; fill+target and exactly one value source; select+target+value; check+target+checked; press+key; scroll+deltaY; waitFor+target+state; screenshot+name. Flow-plan action targets use the compiled InteractionTargetIntent shape, not the simpler advance_flow_authoring semantic target; for ordinary bootstrap use this minimal valid plan exactly: {name:'Observe login',objective:'Find public controls',allowedOrigins:['https://example.test'],budgets:{maxActions:5,maxDurationMs:60000,maxNavigations:1},steps:[{id:'open',title:'Open login',action:{type:'navigate',url:'https://example.test/login'}}]}.",
      inputSchema: {
        ...objectiveContext,
        projectId: uuid,
        environmentId: uuid,
        flowId: uuid.optional(),
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).default(""),
        purpose: flowPurposeSchema.default("primary"),
        content: flowRevisionContentSchema,
        plan: publicPlanSchema,
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...body }) =>
      result(
        {
          draft: await client.post("/flow-drafts", {
            ...body,
            plan: currentPlanSchema.parse(body.plan),
            idempotencyKey: idempotencyKey ?? stableKey("draft", body),
          }),
        },
        "Mutable Flow draft created.",
      ),
  );
}
