import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  dispatchRunOperationBaseSchema,
  dispatchedRunOperationResultSchema,
  publicApiRejectionSchema,
} from "@scry/contracts";
import { z } from "zod";

import { apiRejection, ScryApiError, type ScryApiClient } from "../../api-client.js";
import {
  idempotentPotentiallyDestructiveExternalOperation,
  toolResult,
  uuid,
} from "../../tool-registry.js";

const dispatchRunOperationOutputSchema = z
  .object({
    message: z.string(),
    result: dispatchedRunOperationResultSchema.optional(),
    rejection: publicApiRejectionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.result) === Boolean(value.rejection))
      context.addIssue({
        code: "custom",
        message: "dispatch returns exactly one result or rejection",
      });
  });

export function registerAgentDirectedRunTool(server: McpServer, client: ScryApiClient) {
  server.registerTool(
    "dispatch_run_operation",
    {
      title: "Dispatch one Run operation",
      description:
        "Dispatch exactly one external-agent-selected operation through the Run's currently associated live Praxis session. Every target that exists before dispatch requires an opaque context-control reference from the current observation of that same session/Page/document; semantic-only targets that exist before dispatch, cross-session references, stale documents, and replacement entities refuse mechanically with no selector fallback. The result includes the bounded factual successorObservation captured at this exact dispatch boundary; after a succeeded result, use it for the next semantic decision instead of making an unchanged observe_praxis_session call. A failed result may include an exact decisionBoundary with safe recovery facts; follow it without guessing or reusing stale authority. A missing or failed successor observation never authorizes progression. For an ordinary literal fill, use intent.action.publicValue and intent.protectedInputReferences:[]. For a protected fill when the observed control declares inputSources including protected_reference, use intent.action:{kind:'fill',target:{concept:'<meaning>',reference:'context-control-<32 lowercase hex>'},protectedReferenceId:'<project-credential-uuid>'}, intent.protectedInputReferences:['<same-project-credential-uuid>'], intent.authorization:{kind:'authentication'}, complete constraints, and expectedEffect:{kind:'none'}. Authentication authority never consumes grant_mission_execution_authorization and must omit authorizationId; authentication_calibration is not browser-login authority. Do not send value or valueSource for protected fills, and never expose the protected plaintext. If a pre-dispatch protected-reference refusal returns requiresFreshIntentId=true, first call authorize_environment_credentials, then preserve the semantic action and retry with a fresh intentId; replaying the refused intentId returns its durable refusal. If the objective or current factual UI says a mutation creates, reveals, copies, rotates, or returns any secret, API credential, token, key, password, or other one-time protected value, never dispatch its submit/create action as activate, press, or same_origin_request and never close the secret UI before persistence. First dispatch only the non-mutating navigation/form-preparation operations with ordinary or live_read authority. Then grant protected_mutation authorization for the exact acquisition intentId and live protected praxisSessionId. Finally dispatch action.kind=acquire_protected_outputs with preparationIntentIds naming those earlier successful preparation intentIds, mutation:{kind:'one_time',target:<exact submit/create reference>}, outputs containing typed public/protected entries, authorization:{kind:'protected_mutation',authorizationId:'<exact authorization UUID>'}, complete constraints, expectedEffect:{kind:'none'}, and protectedInputReferences:[]. Outputs created by a one-time mutation are post-dispatch semantic targets: give each a concept plus observable role/name/label and omit reference. Never copy the submit/mutation reference into an output target. Classify safe public identity such as a client ID as public and classify only a secret or otherwise protected value as protected. Example outputs:[{reference:'client_id',classification:'public',target:{concept:'generated client ID',role:'value',name:'Client ID'},storageName:'Generated client ID'},{reference:'client_secret',classification:'protected',target:{concept:'generated client secret',role:'value',name:'Client secret'},storageName:'Generated client secret'}]. That single operation atomically performs the mutation and persists protected outputs; do not submit first and inspect afterward. Before first use of an existing Project credential in a Mission, establish the user's credential choice unless list_project_credentials for that missionId reports usedInMission=true; environment authorization alone is insufficient. Expected effects are mechanical assertions only. Scry records factual uncertainty and never chooses or retries a continuation.",
      inputSchema: { runId: uuid, ...dispatchRunOperationBaseSchema.shape },
      outputSchema: dispatchRunOperationOutputSchema,
      annotations: idempotentPotentiallyDestructiveExternalOperation,
    },
    async ({ runId, ...input }) => {
      try {
        await client.requireCurrentRelease();
        return toolResult(
          { result: await client.post(`/runs/${runId}/operations`, input) },
          "Operation facts recorded; the external agent chooses what happens next.",
        );
      } catch (error) {
        if (!(error instanceof ScryApiError)) throw error;
        return {
          ...toolResult(
            { rejection: apiRejection(error) },
            "Run operation refused before a safe result was recorded.",
          ),
          isError: true,
        };
      }
    },
  );
}
