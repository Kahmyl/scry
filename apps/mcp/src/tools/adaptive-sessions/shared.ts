import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import {
  advanceAdaptiveSessionSchema,
  adaptiveOperationReconciliationResultSchema,
  adaptiveSessionSchema,
  agentDecisionBoundarySchema,
  closeAdaptiveSessionSchema,
  missionAuthoringTurnBudgetsSchema,
  recoverTrustedOriginsSchema,
  startAdaptiveSessionSchema,
  prepareFlowAuthoringSchema,
  preparedFlowAuthoringSchema,
  praxisSessionCloseResultSchema,
  praxisSessionStartResultSchema,
  praxisObservationSchema,
  reconcileAdaptiveOperationSchema,
  agentProviderSchema,
  flowDraftPurposeSchema,
  flowRevisionContentSchema,
} from "@scry/contracts";
import { z } from "zod";

import { apiRejection, ScryApiError, type ScryApiClient } from "../../api-client.js";
import {
  externalFactualRead,
  externalOpenWorldOperation,
  idempotentDurableWrite,
  idempotentExternalOpenWorldOperation,
  idempotentPotentiallyDestructiveExternalOperation,
  potentiallyDestructiveExternalOperation,
  readOnly,
  stableKey,
  toolResult,
  uuid,
  writes,
} from "../../tool-registry.js";
import { publicPlanSchema } from "../authoring/create-flow-draft.tool.js";

export const navigationExpectedEffectGuidance =
  "Expected same-page navigation accepts {kind:'navigation',url:'https://example.test/path',match:'exact'}; urlPattern is also accepted as a host-compatible alias for the same absolute URL, but never provide both url and urlPattern. For a link or control expected to open a new page, declare constraints.allowNewPage:true AND expectedEffect:{kind:'new_page'}; optionally include the known destination origin as origin. allowNewPage alone grants permission but does not arm safe new-page adoption, and expectedEffect:{kind:'none'} keeps authority on the current page. ";

// Keep the host declaration structural. The canonical contract below remains the
// sole runtime authority, including all cross-field and protected-value checks.
export const hostSemanticTargetSchema = z
  .object({
    concept: z.string().trim().min(1).max(500),
    reference: z
      .string()
      .regex(/^context-control-[a-f0-9]{32}$/)
      .optional(),
    role: z
      .enum([
        "button",
        "checkbox",
        "combobox",
        "dialog",
        "field",
        "form",
        "heading",
        "link",
        "listbox",
        "menuitem",
        "option",
        "radio",
        "region",
        "row",
        "tab",
        "table",
        "textbox",
        "text",
        "value",
      ])
      .optional(),
    name: z.string().trim().min(1).max(500).optional(),
    label: z.string().trim().min(1).max(500).optional(),
    placeholder: z.string().trim().min(1).max(500).optional(),
    text: z.string().trim().min(1).max(500).optional(),
    testId: z.string().trim().min(1).max(500).optional(),
    scope: z
      .object({
        kind: z.enum(["page", "dialog", "form", "section", "row", "region", "live_region"]),
        name: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    exact: z.boolean().optional(),
  })
  .strict();

export const hostAuthoringIntentSchema = z
  .object({
    intentId: z.string().trim().min(1).max(200),
    objectiveId: uuid,
    flowDraftId: uuid,
    action: z
      .object({
        kind: z.enum([
          "navigate",
          "activate",
          "fill",
          "select",
          "set_checked",
          "press",
          "wait_for",
          "inspect",
          "acquire_protected_outputs",
          "same_origin_request",
        ]),
        url: z.string().url().optional(),
        target: hostSemanticTargetSchema.optional(),
        semanticEffect: z
          .enum(["read_context_transition", "resource_mutation", "unknown"])
          .optional()
          .describe(
            "Required when kind is activate or press. Use read_context_transition only for a proven read-only navigation or UI-context transition with live_read authority. resource_mutation and unknown remain mutation-capable; use unknown when read-only semantics are not established.",
          ),
        publicValue: z
          .string()
          .max(20_000)
          .optional()
          .describe(
            "Ordinary literal fill source. Never use for a control whose inputSources excludes literal.",
          ),
        protectedReferenceId: uuid
          .optional()
          .describe(
            "Opaque Project credential UUID for protected fill; repeat it exactly in protectedInputReferences.",
          ),
        syntheticProtectedSource: z
          .object({
            semantic: z.string(),
            generatorContract: z.enum([
              "reserved_test_email",
              "synthetic_person_name",
              "sandbox_shipping_address_json",
              "opaque_operation_token",
            ]),
            generatorVersion: z.literal(1),
            purpose: z.literal("test_order_qualification"),
            resourceKind: z.string(),
            operation: z.string(),
          })
          .strict()
          .optional(),
        value: z.string().optional(),
        checked: z.boolean().optional(),
        key: z
          .enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
          .optional(),
        state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        authentication: z.literal("current_browser_session").optional(),
        path: z.string().optional(),
        body: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
        expectedStatus: z
          .object({ min: z.number().int(), max: z.number().int() })
          .strict()
          .optional(),
        preparationIntentIds: z.array(z.string()).optional(),
        syntheticProtectedInputs: z
          .array(
            z
              .object({
                semantic: z.string(),
                generatorContract: z.string(),
                generatorVersion: z.literal(1),
                purpose: z.literal("test_order_qualification"),
                resourceKind: z.literal("order"),
                operation: z.literal("create"),
                target: hostSemanticTargetSchema,
              })
              .strict(),
          )
          .optional(),
        mutation: z
          .object({ kind: z.enum(["one_time", "read_only"]), target: hostSemanticTargetSchema })
          .strict()
          .optional(),
        request: z
          .object({
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
            pathTemplate: z.string(),
            transports: z.array(z.enum(["document", "fetch", "xhr"])),
          })
          .strict()
          .optional(),
        response: z
          .object({ confirmedNotAppliedStatuses: z.array(z.number().int()) })
          .strict()
          .optional(),
        outputs: z
          .array(
            z
              .object({
                reference: z.string(),
                classification: z.enum(["public", "protected"]),
                target: hostSemanticTargetSchema,
                storageName: z.string(),
              })
              .strict(),
          )
          .optional(),
        externalResourceBindings: z
          .array(
            z
              .object({
                status: z.enum(["active", "unavailable"]),
                identityReference: z.string().optional(),
                provider: z.string(),
                resourceKind: z.string(),
                resourceScope: z.string(),
                identityContractVersion: z.number().int(),
                identitySource: z.literal("response").optional(),
                requiredForDestructiveLifecycle: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    expectedEffect: z
      .object({
        kind: z.enum([
          "none",
          "navigation",
          "target_visibility",
          "target_value",
          "target_state",
          "new_page",
        ]),
        url: z.string().url().optional(),
        urlPattern: z.string().url().optional(),
        match: z.enum(["exact", "path", "contains"]).optional(),
        target: hostSemanticTargetSchema.optional(),
        visible: z.boolean().optional(),
        expected: z.string().optional(),
        checked: z.boolean().optional(),
        enabled: z.boolean().optional(),
        origin: z.string().url().optional(),
      })
      .strict(),
    constraints: z
      .object({
        timeoutMs: z.number().int().min(100).max(60_000),
        allowNewPage: z.boolean(),
        allowNonExact: z.boolean(),
      })
      .strict(),
    authorization: z
      .object({
        kind: z.enum([
          "ordinary",
          "authentication",
          "reversible",
          "live_read",
          "live_mutation",
          "protected_mutation",
        ]),
        authorizationId: uuid
          .optional()
          .describe(
            "Use only with live_read, live_mutation, or protected_mutation. Omit for authentication; authentication_calibration grants are not browser-login authority.",
          ),
      })
      .strict(),
    protectedInputReferences: z
      .array(uuid)
      .max(20)
      .optional()
      .describe(
        "For protected fill, exactly [action.protectedReferenceId]; for ordinary literal fill, [].",
      ),
    credentialLifecycle: z
      .object({
        effect: z.literal("revoke"),
        credentialReferenceIds: z.array(uuid).min(1).max(20),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      (intent.action.kind === "activate" || intent.action.kind === "press") &&
      !intent.action.semanticEffect
    )
      context.addIssue({
        code: "custom",
        path: ["action", "semanticEffect"],
        message: "activate and press require an explicit semanticEffect",
      });
  });

export async function withAdaptiveSessionError<T>(
  operation: () => Promise<T>,
  rejectionMessage: string,
) {
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

export {
  randomUUID,
  advanceAdaptiveSessionSchema,
  adaptiveOperationReconciliationResultSchema,
  adaptiveSessionSchema,
  agentDecisionBoundarySchema,
  closeAdaptiveSessionSchema,
  missionAuthoringTurnBudgetsSchema,
  recoverTrustedOriginsSchema,
  startAdaptiveSessionSchema,
  prepareFlowAuthoringSchema,
  preparedFlowAuthoringSchema,
  praxisSessionCloseResultSchema,
  praxisSessionStartResultSchema,
  praxisObservationSchema,
  reconcileAdaptiveOperationSchema,
  agentProviderSchema,
  flowDraftPurposeSchema,
  flowRevisionContentSchema,
  z,
  externalFactualRead,
  externalOpenWorldOperation,
  idempotentDurableWrite,
  idempotentExternalOpenWorldOperation,
  idempotentPotentiallyDestructiveExternalOperation,
  potentiallyDestructiveExternalOperation,
  readOnly,
  stableKey,
  toolResult,
  uuid,
  writes,
  publicPlanSchema,
};
export type { ScryApiClient };
