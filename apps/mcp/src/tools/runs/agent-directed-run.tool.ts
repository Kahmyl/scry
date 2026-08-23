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
        "Dispatch exactly one external-agent-selected operation through the Run's currently associated live Praxis session. Every target requires an opaque context-control reference from the current observation of that same session/Page/document; semantic-only targets, cross-session references, stale documents, and replacement entities refuse mechanically with no selector fallback. The result includes the bounded factual successorObservation captured at this exact dispatch boundary; after a succeeded result, use it for the next semantic decision instead of making an unchanged observe_praxis_session call. A missing or failed successor observation never authorizes progression. For an ordinary literal fill, use intent.action.publicValue and intent.protectedInputReferences:[]. For a protected fill when the observed control declares inputSources including protected_reference, use intent.action:{kind:'fill',target:{concept:'<meaning>',reference:'context-control-<32 lowercase hex>'},protectedReferenceId:'<project-credential-uuid>'}, intent.protectedInputReferences:['<same-project-credential-uuid>'], intent.authorization:{kind:'authentication'}, complete constraints, and expectedEffect:{kind:'none'}. Do not send value or valueSource for protected fills, and never expose the protected plaintext. Before first use of an existing Project credential in a Mission, establish the user's credential choice unless list_project_credentials for that missionId reports usedInMission=true; environment authorization alone is insufficient. Expected effects are mechanical assertions only. Scry records factual uncertainty and never chooses or retries a continuation.",
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
