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
        plan: currentPlanSchema,
        idempotencyKey: z.string().min(8).max(200).optional(),
      },
      annotations: writes,
    },
    async ({ idempotencyKey, ...body }) =>
      result(
        {
          draft: await client.post("/flow-drafts", {
            ...body,
            idempotencyKey: idempotencyKey ?? stableKey("draft", body),
          }),
        },
        "Mutable Flow draft created.",
      ),
  );
}
