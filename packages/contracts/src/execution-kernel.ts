import { z } from "zod";

import { currentActionSchema, currentPlanSchema } from "./current.js";
import {
  expectedEffectSchema,
  semanticFingerprintSchema,
  semanticScopeKindSchema,
} from "./grounding.js";
import { executionPolicySchema } from "./policy.js";

const uuid = z.string().uuid();

export const executionKernelModeSchema = z.enum([
  "observe",
  "rehearse",
  "transact",
  "certify",
  "run",
]);

export const executionCapabilityNameSchema = z.enum([
  "browser",
  "praxis",
  "veil",
  "evidence",
  "journal",
  "protected_input",
  "protected_operations",
  "checkpoint",
  "calibration",
]);

export const executionCapabilityStateSchema = z.enum(["available", "policy_denied", "unavailable"]);

export const executionCapabilityManifestSchema = z
  .object({
    version: z.literal(1),
    mode: executionKernelModeSchema,
    correlationId: uuid,
    capabilities: z.record(
      executionCapabilityNameSchema,
      z
        .object({
          state: executionCapabilityStateSchema,
          reasonCode: z.string().trim().min(1).max(120).optional(),
        })
        .strict(),
    ),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const executionAdmissionFailureCodeSchema = z.enum([
  "EXECUTION_CAPABILITY_INCOMPLETE",
  "EXECUTION_CAPABILITY_BINDING_MISMATCH",
  "EXECUTION_CAPABILITY_DIGEST_MISMATCH",
  "EXECUTION_MODE_POLICY_DENIED",
  "EXECUTION_REQUEST_INVALID",
  "EXECUTION_MUTATION_IDENTITY_REQUIRED",
  "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
]);

export const executionAdmissionFailureSchema = z
  .object({
    code: executionAdmissionFailureCodeSchema,
    mode: executionKernelModeSchema,
    missingCapabilities: z.array(executionCapabilityNameSchema).default([]),
    safeActions: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict();

export const evidenceChannelOutcomeSchema = z
  .object({
    channel: z.enum(["screenshot", "video", "trace", "dom", "network", "console", "report"]),
    state: z.enum(["available", "suppressed", "quarantined", "failed"]),
    reasonCode: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const agentDecisionBoundarySchema = z
  .object({
    type: z.enum([
      "ambiguous_candidate",
      "authorization_required",
      "protected_input_required",
      "mutation_reconciliation_required",
      "effect_observation_required",
      "policy_refused",
      "environment_unavailable",
      "objective_completed",
      "turn_budget_exhausted",
    ]),
    reasonCode: z.string().trim().min(1).max(120),
    safeActions: z.array(z.string().trim().min(1).max(120)).default([]),
    requiresFreshIntentId: z.literal(true).optional(),
    candidateDistinctions: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(240),
            distinction: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    environmentRecovery: z
      .object({
        environmentId: z.string().uuid(),
        missingTrustedScriptOrigins: z.array(z.string().url()).max(20).default([]),
        missingOriginClassification: z.enum(["public", "redacted"]),
        currentTrustedScriptOrigins: z.array(z.string().url()).max(20).default([]),
        recoveryTool: z.enum(["recover_trusted_script_origins", "create_test_environment"]),
        requiresNewFlowDraftAndAuthoringSession: z.literal(true),
      })
      .strict()
      .optional(),
    navigationRecovery: z
      .object({
        environmentId: z.string().uuid(),
        missingAllowedOrigin: z.string().url(),
        currentAllowedOrigins: z.array(z.string().url()).max(20),
        recoveryTools: z.tuple([
          z.literal("create_test_environment"),
          z.literal("create_flow_draft"),
        ]),
        requiresNewFlowDraftAndAuthoringSession: z.literal(true),
      })
      .strict()
      .optional(),
    popupRecovery: z
      .object({
        environmentId: z.string().uuid(),
        currentAllowPopups: z.literal(false),
        requiredAllowPopups: z.literal(true),
        currentAllowedOrigins: z.array(z.string().url()).max(20),
        recoveryTools: z.tuple([
          z.literal("create_test_environment"),
          z.literal("create_flow_draft"),
        ]),
        requiresNewFlowDraftAndAuthoringSession: z.literal(true),
      })
      .strict()
      .optional(),
    authoringRecovery: z
      .object({
        sessionId: z.string().uuid(),
        missionId: z.string().uuid(),
        objectiveId: z.string().uuid(),
        flowDraftId: z.string().uuid(),
        environmentId: z.string().uuid(),
        failedOperationId: z.string().trim().min(1).max(200),
        sourceTurnId: z.string().uuid().optional(),
        environmentResourceExists: z.literal(true),
        executionReadiness: z.literal("runtime_reprovision_required"),
        preservesCurrentFlow: z.literal(true),
        recoveryTool: z.literal("advance_flow_authoring"),
        recoveryKind: z.literal("intents"),
        requiresPendingTurn: z.literal(false),
        requiresFreshIdempotencyKey: z.literal(true),
      })
      .strict()
      .optional(),
    policyContext: z
      .object({
        governingMode: executionKernelModeSchema,
        requestedSemanticEffect: z.enum([
          "read_context_transition",
          "resource_mutation",
          "unknown",
        ]),
        gesture: z.string().trim().min(1).max(120),
        effectApplied: z.literal(false),
        strongerAuthorityCouldPermit: z.boolean(),
        recoverable: z.boolean(),
        explanation: z.string().trim().min(1).max(1_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const operationOutcomeSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
    functionalResult: z.enum(["succeeded", "failed", "inconclusive"]),
    mutationOutcome: z.enum(["not_applied", "applied", "unknown"]),
    privacyResult: z.enum(["verified", "unverified", "degraded", "sealed"]),
    evidenceResult: z.array(evidenceChannelOutcomeSchema),
    qualityFindings: z.array(z.record(z.string(), z.unknown())),
    durationMs: z.number().nonnegative(),
    reasonCode: z.string().trim().min(1).max(120).optional(),
    environmentFailure: z
      .object({
        missingTrustedScriptOrigins: z.array(z.string().url()).max(20).default([]),
        missingOriginClassification: z.enum(["public", "redacted"]),
      })
      .strict()
      .optional(),
    navigationEnvironmentFailure: z
      .object({ missingAllowedOrigin: z.string().url() })
      .strict()
      .optional(),
    resolvedTarget: semanticFingerprintSchema.optional(),
    semanticPageContext: z
      .object({
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        authority: z
          .object({
            pageId: z.string().trim().min(1).max(120),
            documentEpoch: z.number().int().nonnegative(),
            url: z.string().url().max(2_000),
            title: z.string().max(200),
            readiness: z.literal("stable"),
          })
          .strict(),
        completeness: z
          .object({
            kind: z.literal("bounded"),
            observed: z.number().int().nonnegative(),
            returned: z.number().int().nonnegative().max(64),
            truncated: z.boolean(),
          })
          .strict(),
        controls: z
          .array(
            z
              .object({
                reference: z.string().regex(/^context-control-[a-f0-9]{32}$/),
                role: z.string().trim().min(1).max(40),
                name: z.string().trim().min(1).max(160),
                semanticPurpose: z
                  .string()
                  .regex(/^[a-z][a-z0-9_]{0,63}$/)
                  .optional(),
                valueProtected: z.boolean().optional(),
                group: z.string().trim().min(1).max(120).optional(),
                boundary: z
                  .object({
                    kind: semanticScopeKindSchema,
                    name: z.string().trim().min(1).max(120).optional(),
                  })
                  .strict()
                  .optional(),
                capabilities: z
                  .array(z.enum(["observe", "activate", "enter_text", "toggle", "select_option"]))
                  .max(5),
                inputSources: z
                  .array(z.enum(["literal", "protected_reference"]))
                  .max(2)
                  .optional(),
                selected: z.boolean().optional(),
                expanded: z.boolean().optional(),
                pressed: z.boolean().optional(),
                checked: z.boolean().optional(),
                disabled: z.boolean().optional(),
                current: z.boolean().optional(),
                containerReferences: z
                  .array(z.string().regex(/^context-container-[a-f0-9]{32}$/))
                  .max(4)
                  .optional(),
              })
              .strict(),
          )
          .max(64),
        readableValues: z
          .array(
            z
              .object({
                reference: z.string().regex(/^context-value-[a-f0-9]{32}$/),
                kind: z.enum(["code", "pre", "output", "annotated"]),
                classification: z.enum(["public", "protected", "unknown"]),
                context: z.string().trim().min(1).max(160).optional(),
              })
              .strict(),
          )
          .max(24)
          .default([]),
        readableValueCompleteness: z
          .object({
            kind: z.literal("bounded"),
            observed: z.number().int().nonnegative(),
            returned: z.number().int().nonnegative().max(24),
            truncated: z.boolean(),
          })
          .strict()
          .default({
            kind: "bounded",
            observed: 0,
            returned: 0,
            truncated: false,
          }),
        browserSensor: z
          .object({
            kind: z.literal("chromium_read_only"),
            authority: z
              .object({
                frameId: z.string().trim().min(1).max(200),
                loaderId: z.string().trim().min(1).max(200),
                previousLoaderId: z.string().trim().min(1).max(200).optional(),
                loaderChanged: z.boolean(),
                loaderTransitionsObserved: z.number().int().nonnegative(),
              })
              .strict(),
            network: z
              .object({
                observedRequests: z.number().int().nonnegative(),
                recentRequests: z
                  .array(
                    z
                      .object({
                        requestId: z.string().trim().min(1).max(200),
                        loaderId: z.string().trim().min(1).max(200),
                        frameId: z.string().trim().min(1).max(200).optional(),
                        type: z.string().trim().min(1).max(40).optional(),
                        monotonicTimestamp: z.number().nonnegative(),
                      })
                      .strict(),
                  )
                  .max(12),
                observedFailures: z.number().int().nonnegative(),
                recentFailures: z
                  .array(
                    z
                      .object({
                        requestId: z.string().trim().min(1).max(200),
                        type: z.string().trim().min(1).max(40).optional(),
                        monotonicTimestamp: z.number().nonnegative(),
                        reasonCode: z.string().regex(/^(?:NET::[A-Z0-9_]+|NETWORK_FAILURE)$/),
                        canceled: z.boolean(),
                        blockedReason: z.string().trim().min(1).max(80).optional(),
                      })
                      .strict(),
                  )
                  .max(6),
                truncated: z.boolean(),
              })
              .strict(),
            layout: z
              .object({
                clientWidth: z.number().nonnegative(),
                clientHeight: z.number().nonnegative(),
              })
              .strict(),
          })
          .strict()
          .optional(),
        containers: z
          .array(
            z
              .object({
                reference: z.string().regex(/^context-container-[a-f0-9]{32}$/),
                kind: z.enum(["row", "list_item", "card", "group"]),
                parentReference: z
                  .string()
                  .regex(/^context-container-[a-f0-9]{32}$/)
                  .optional(),
                controlReferences: z
                  .array(z.string().regex(/^context-control-[a-f0-9]{32}$/))
                  .max(64),
              })
              .strict(),
          )
          .max(64)
          .default([]),
        containerCompleteness: z
          .object({
            kind: z.literal("bounded"),
            observed: z.number().int().nonnegative(),
            returned: z.number().int().nonnegative().max(64),
            truncated: z.boolean(),
          })
          .strict()
          .default({ kind: "bounded", observed: 0, returned: 0, truncated: false }),
        sections: z
          .array(
            z
              .object({
                heading: z.string().trim().min(1).max(200),
                content: z.string().trim().min(1).max(4_000),
              })
              .strict(),
          )
          .max(12)
          .optional(),
        sectionCompleteness: z
          .object({
            kind: z.literal("bounded"),
            observed: z.number().int().nonnegative(),
            returned: z.number().int().nonnegative().max(12),
            truncated: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((context, refinement) => {
        const controls = new Map(context.controls.map((control) => [control.reference, control]));
        const containers = new Map(
          context.containers.map((container) => [container.reference, container]),
        );
        if (
          context.containerCompleteness.returned !== context.containers.length ||
          context.containerCompleteness.observed < context.containerCompleteness.returned
        )
          refinement.addIssue({
            code: "custom",
            path: ["containerCompleteness"],
            message: "container completeness must match the bounded projection",
          });
        if (controls.size !== context.controls.length)
          refinement.addIssue({
            code: "custom",
            path: ["controls"],
            message: "control references must be unique",
          });
        if (containers.size !== context.containers.length)
          refinement.addIssue({
            code: "custom",
            path: ["containers"],
            message: "container references must be unique",
          });
        for (const [index, container] of context.containers.entries()) {
          if (new Set(container.controlReferences).size !== container.controlReferences.length)
            refinement.addIssue({
              code: "custom",
              path: ["containers", index, "controlReferences"],
              message: "container control references must be unique",
            });
          if (container.parentReference && !containers.has(container.parentReference))
            refinement.addIssue({
              code: "custom",
              path: ["containers", index, "parentReference"],
              message: "container parent must be in the same snapshot",
            });
          for (const controlReference of container.controlReferences) {
            const control = controls.get(controlReference);
            if (!control?.containerReferences?.includes(container.reference))
              refinement.addIssue({
                code: "custom",
                path: ["containers", index, "controlReferences"],
                message: "container membership must be symmetric",
              });
          }
        }
        for (const [index, control] of context.controls.entries())
          for (const containerReference of control.containerReferences ?? [])
            if (!containers.get(containerReference)?.controlReferences.includes(control.reference))
              refinement.addIssue({
                code: "custom",
                path: ["controls", index, "containerReferences"],
                message: "control membership must be symmetric",
              });
        for (const container of context.containers) {
          const visited = new Set<string>([container.reference]);
          let parent = container.parentReference;
          while (parent) {
            if (visited.has(parent)) {
              refinement.addIssue({
                code: "custom",
                path: ["containers"],
                message: "container ancestry must be acyclic",
              });
              break;
            }
            visited.add(parent);
            parent = containers.get(parent)?.parentReference;
          }
        }
      })
      .optional(),
    nextDecisionBoundary: agentDecisionBoundarySchema.optional(),
    generatedReferences: z
      .array(
        z
          .object({
            reference: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
            classification: z.enum(["public", "protected"]),
            credentialId: z.string().uuid().optional(),
            valueId: z.string().uuid().optional(),
            scope: z.literal("project"),
          })
          .strict()
          .superRefine((value, context) => {
            if (
              (value.classification === "protected") !== Boolean(value.credentialId) ||
              (value.classification === "public") !== Boolean(value.valueId)
            )
              context.addIssue({
                code: "custom",
                message: "generated reference ID does not match classification",
              });
          }),
      )
      .max(8)
      .optional(),
  })
  .strict();

export const readPraxisPublicValueInputSchema = z
  .object({
    reference: z.string().regex(/^context-value-[a-f0-9]{32}$/),
    offset: z.number().int().min(0).max(2_097_152).default(0),
    maxBytes: z.number().int().min(1).max(4_096).default(2_048),
  })
  .strict();

export const readPraxisPublicValueResultSchema = z
  .object({
    reference: z.string().regex(/^context-value-[a-f0-9]{32}$/),
    classification: z.literal("public"),
    provenance: z
      .object({
        referenceVersion: z.literal(1),
        pageId: z.string().trim().min(1).max(120),
        frameId: z.string().trim().min(1).max(120),
        documentEpoch: z.number().int().nonnegative(),
        documentIdentity: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    element: z
      .object({
        kind: z.enum(["code", "pre", "output", "annotated"]),
        context: z.string().trim().min(1).max(160).optional(),
      })
      .strict(),
    text: z.string().max(4_096),
    offset: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative().max(4_096),
    totalBytes: z.number().int().nonnegative().max(2_097_152),
    truncated: z.boolean(),
    nextOffset: z.number().int().positive().max(2_097_152).optional(),
    admission: z
      .object({
        admissionRevision: z.number().int().min(1),
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
        admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export const inspectPraxisRegionInputSchema = z
  .object({
    contextControlReference: z.string().regex(/^context-control-[a-f0-9]{32}$/),
  })
  .strict();

export const inspectPraxisRegionResultSchema = z
  .object({
    contextControlReference: z.string().regex(/^context-control-[a-f0-9]{32}$/),
    authority: z
      .object({
        referenceVersion: z.literal(1),
        pageId: z.string().trim().min(1).max(120),
        frameId: z.string().trim().min(1).max(120),
        documentEpoch: z.number().int().nonnegative(),
        documentIdentity: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    region: z
      .object({
        kind: z.enum(["dialog", "region", "form", "section", "article", "main", "aside"]),
      })
      .strict(),
    readableValues: z
      .array(
        z
          .object({
            reference: z.string().regex(/^context-value-[a-f0-9]{32}$/),
            kind: z.enum(["code", "pre", "output", "annotated"]),
            classification: z.enum(["public", "protected", "unknown"]),
            context: z.string().trim().min(1).max(160).optional(),
          })
          .strict(),
      )
      .max(32),
    readableValueCompleteness: z
      .object({
        kind: z.literal("bounded"),
        observed: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative().max(32),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.readableValueCompleteness.returned !== result.readableValues.length ||
      result.readableValueCompleteness.observed < result.readableValueCompleteness.returned
    )
      context.addIssue({
        code: "custom",
        path: ["readableValueCompleteness"],
        message: "readable value completeness must match the bounded region projection",
      });
    if (
      new Set(result.readableValues.map((value) => value.reference)).size !==
      result.readableValues.length
    )
      context.addIssue({
        code: "custom",
        path: ["readableValues"],
        message: "region readable value references must be unique",
      });
  });

export type ReadPraxisPublicValueInput = z.infer<typeof readPraxisPublicValueInputSchema>;
export type ReadPraxisPublicValueResult = z.infer<typeof readPraxisPublicValueResultSchema>;
export type InspectPraxisRegionInput = z.infer<typeof inspectPraxisRegionInputSchema>;
export type InspectPraxisRegionResult = z.infer<typeof inspectPraxisRegionResultSchema>;

export const executionRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    operationId: z.string().trim().min(1).max(200),
    correlationId: uuid,
    mode: executionKernelModeSchema,
    plan: currentPlanSchema,
    policy: executionPolicySchema,
    capabilityManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
    mutationIdentity: z.string().trim().min(8).max(200).optional(),
    semanticContext: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

const authoringTurnOperationSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
    action: currentActionSchema,
    expectedEffect: expectedEffectSchema,
  })
  .strict();

export const advanceAuthoringTurnPayloadSchema = z
  .object({
    correlationId: uuid.optional(),
    objectiveDelta: z.string().trim().min(1).max(4_000),
    operations: z.array(authoringTurnOperationSchema).min(1).max(20),
    authorization: z
      .object({
        mutationAllowed: z.boolean(),
        protectedOperationAllowed: z.boolean(),
      })
      .strict(),
    budgets: z
      .object({
        maxOperations: z.number().int().min(1).max(20),
        maxDurationMs: z.number().int().min(1_000).max(300_000),
        maxPreDispatchRetries: z.number().int().min(0).max(3).default(1),
      })
      .strict(),
    protectedInputReferences: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict()
  .superRefine((payload, context) => {
    const supplied = new Set(payload.protectedInputReferences);
    if (supplied.size !== payload.protectedInputReferences.length) {
      context.addIssue({
        code: "custom",
        path: ["protectedInputReferences"],
        message: "protected input references must be unique",
      });
    }
    const referenced = new Set<string>();
    for (const operation of payload.operations) {
      if (operation.action.type === "fill" && operation.action.secretRef) {
        referenced.add(operation.action.secretRef);
      }
      if (operation.action.type === "protectedTransaction") {
        for (const input of Object.values(operation.action.inputs)) {
          if (input.classification === "known_secret") referenced.add(input.credentialRef);
        }
      }
    }
    for (const reference of supplied) {
      if (!referenced.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["protectedInputReferences"],
          message: "unused protected input reference",
        });
      }
    }
    for (const reference of referenced) {
      if (!supplied.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["protectedInputReferences"],
          message: "operation protected reference must be declared",
        });
      }
    }
  });

export const advanceAuthoringTurnResultSchema = z
  .object({
    correlationId: uuid,
    operationsCompleted: z.array(operationOutcomeSchema),
    safeState: z
      .object({
        documentEpoch: z.number().int().nonnegative(),
        url: z.string().url(),
      })
      .strict(),
    decisionBoundary: agentDecisionBoundarySchema,
    timings: z.record(z.string(), z.number().nonnegative()),
    bytesReturned: z.number().int().nonnegative(),
  })
  .strict();

export const advanceAuthoringTurnCommandSchema = z
  .object({
    missionId: uuid,
    agentSessionId: uuid,
    payload: advanceAuthoringTurnPayloadSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export type ExecutionMode = z.infer<typeof executionKernelModeSchema>;
export type ExecutionCapabilityName = z.infer<typeof executionCapabilityNameSchema>;
export type ExecutionCapabilityManifest = z.infer<typeof executionCapabilityManifestSchema>;
export type ExecutionCapabilityBundle = ExecutionCapabilityManifest["capabilities"];
export type ExecutionAdmissionFailure = z.infer<typeof executionAdmissionFailureSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>;
export type AgentDecisionBoundary = z.infer<typeof agentDecisionBoundarySchema>;
export type AdvanceAuthoringTurnPayload = z.infer<typeof advanceAuthoringTurnPayloadSchema>;
export type AdvanceAuthoringTurnResult = z.infer<typeof advanceAuthoringTurnResultSchema>;
export type AdvanceAuthoringTurnCommand = z.infer<typeof advanceAuthoringTurnCommandSchema>;
