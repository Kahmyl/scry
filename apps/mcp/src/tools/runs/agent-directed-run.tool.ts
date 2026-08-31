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
        "Dispatch one agent-selected navigation, observation, or form-preparation operation through the Run's current Praxis session. Existing targets require exact context-control references from that same current page/document; stale owners, references and replacement entities refuse mechanically. Use successorObservation when available, or observe again after a recoverable failure. For activate/press, declare semanticEffect:'read_context_transition' with intent.authorization:{kind:'live_read'} only when the observed action is a read-only context transition. The action classification 'unknown' expresses uncertainty about effect type; it is not an external-effect UNKNOWN result. Ordinary fills use action.publicValue. Protected login fills use action.protectedReferenceId, the same UUID in protectedInputReferences, authorization:{kind:'authentication'}, and expectedEffect:{kind:'none'}; never expose plaintext or send value/valueSource. Configured login references remain subject to server scope and Veil presentation checks. For an observed business mutation or protected acquisition, use observe_operation_contracts, reserve_prepared_protected_operation, then dispatch_prepared_protected_operation. Do not submit the mutation first or construct an approval, grant, binding or separate resume call. Generated values use opaque same-Mission value references; a read-only continuation uses continuationReference at reservation. No second owner approval is required. Expected effects assert mechanical observations. Interpret factual results, recover semantic navigation yourself, and never replay an applied or possibly applied effect.",
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
