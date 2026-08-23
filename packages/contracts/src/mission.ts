import { z } from "zod";

import { nameSchema, uuidSchema } from "./api.js";
import { mutationReceiptSchema } from "./protected-operation.js";

const missionIdempotencyKeySchema = z.string().trim().min(8).max(200);

export const missionStatusSchema = z.enum([
  "planning",
  "running",
  "blocked",
  "awaiting_user",
  "completed",
  "failed",
  "cancelled",
]);
export const objectiveStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
]);
export const agentProviderSchema = z.enum(["codex", "claude", "scry_agent", "human"]);
export const agentSessionStatusSchema = z.enum(["active", "completed", "interrupted", "failed"]);
export const flowVisibilitySchema = z.enum(["reusable", "mission_local", "internal"]);
export const flowPurposeSchema = z.enum([
  "primary",
  "setup",
  "acceptance",
  "diagnostic",
  "calibration",
  "reconciliation",
  "cleanup",
  "verification",
]);
export const runRoleSchema = z.enum([
  "exploratory",
  "diagnostic",
  "calibration",
  "candidate",
  "accepted",
  "superseded",
  "invalidated",
]);
export const reportStatusSchema = z.enum(["published", "superseded"]);
export const missionReadinessResolutionSchema = z.enum([
  "automatic",
  "fresh_observation_required",
  "mutation_reconciliation_required",
  "evidence_selection_required",
  "external_agent_action_required",
  "human_action_required",
]);
export const missionReadinessBlockerSchema = z
  .object({
    code: z.string().trim().min(1).max(200),
    missionId: uuidSchema,
    objectiveId: uuidSchema.optional(),
    runId: uuidSchema.optional(),
    attemptId: uuidSchema.optional(),
    praxisSessionId: uuidSchema.optional(),
    protectedOperationId: uuidSchema.optional(),
    operationId: z.string().trim().min(1).max(200).optional(),
    evidenceId: uuidSchema.optional(),
    evidenceRecommendationId: uuidSchema.optional(),
    recordingId: uuidSchema.optional(),
    artifactId: uuidSchema.optional(),
    evidenceClass: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(200),
    reasonCode: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    resolution: missionReadinessResolutionSchema,
    safeActions: z.array(z.string().trim().min(1).max(200)).max(20),
    nextActions: z.array(z.string().trim().min(1).max(200)).max(20),
  })
  .strict();
export const missionCompletionReadinessSchema = z
  .object({
    ready: z.boolean(),
    missionId: uuidSchema,
    blockers: z.array(missionReadinessBlockerSchema).max(500),
    truncated: z.boolean(),
    totalBlockerCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ready !== (value.totalBlockerCount === 0))
      context.addIssue({
        code: "custom",
        path: ["ready"],
        message: "Mission readiness is true exactly when no blockers remain",
      });
    if (value.totalBlockerCount < value.blockers.length)
      context.addIssue({
        code: "custom",
        path: ["totalBlockerCount"],
        message: "Total blocker count cannot be smaller than the returned blocker count",
      });
    if (value.truncated !== value.totalBlockerCount > value.blockers.length)
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "Truncation must report whether blockers were omitted",
      });
  });
export const resumeActionSchema = z.enum([
  "revise_flow",
  "run_candidate",
  "review_failure",
  "complete_calibration",
  "await_user",
  "publish_report",
]);
export const externalInputConditionSchema = z.enum([
  "USER_INPUT_REQUIRED",
  "USER_AUTHORIZATION_REQUIRED",
  "USER_DECISION_REQUIRED",
]);
export const missionContinuationCapabilitySchema = z.enum([
  "get_operating_context",
  "list_project_credentials",
  "create_project_credential",
  "authorize_environment_credentials",
  "grant_mission_execution_authorization",
  "resume_mission",
  "update_mission_objective",
  "set_mission_resume_pointer",
  "cancel_mission_orchestration",
]);
const humanFulfillmentPathBase = {
  humanAction: z.string().trim().min(1).max(1_000),
  result: z.string().trim().min(1).max(1_000),
  availableCapabilities: z.array(missionContinuationCapabilitySchema).min(1).max(10),
  continuation: z
    .object({
      sameMission: z.literal(true),
      sameObjective: z.literal(true),
      replacementMissionRequired: z.literal(false),
      resumeWith: z.literal("resume_mission"),
    })
    .strict(),
};
export const humanFulfillmentPathSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...humanFulfillmentPathBase,
      kind: z.literal("dashboard_managed"),
      agentExposure: z.literal("none"),
      dashboardPath: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
    })
    .strict(),
  z
    .object({
      ...humanFulfillmentPathBase,
      kind: z.literal("agent_assisted"),
      agentExposure: z.literal("protected_plaintext_before_encrypted_storage"),
      availableCapabilities: z
        .array(missionContinuationCapabilitySchema)
        .min(1)
        .max(10)
        .refine(
          (items) => items.includes("create_project_credential"),
          "Agent-assisted credential input requires create_project_credential",
        ),
    })
    .strict(),
  z
    .object({
      ...humanFulfillmentPathBase,
      kind: z.literal("approval"),
      agentExposure: z.literal("authorization_only"),
    })
    .strict(),
  z
    .object({
      ...humanFulfillmentPathBase,
      kind: z.literal("selection"),
      agentExposure: z.literal("public_input"),
    })
    .strict(),
  z
    .object({
      ...humanFulfillmentPathBase,
      kind: z.literal("public_input"),
      agentExposure: z.literal("public_input"),
    })
    .strict(),
]);
export const awaitingUserLifecycleSchema = z
  .object({
    terminal: z.literal(false),
    taskStillActive: z.literal(true),
    sameMissionResumable: z.literal(true),
    sameObjectiveResumable: z.literal(true),
    shouldFinalize: z.literal(false),
    shouldPublishFinalReport: z.literal(false),
    shouldCreateReplacementMission: z.literal(false),
    requiredNextStep: z.literal("fulfill_human_prerequisite_then_resume"),
  })
  .strict();
export const missionExternalInputSchema = z
  .object({
    condition: externalInputConditionSchema,
    cause: z.string().trim().min(1).max(2_000),
    affectedOperation: z.string().trim().min(1).max(500).optional(),
    affectedResource: z.string().trim().min(1).max(500).optional(),
    effectState: z.enum(["applied", "not_applied", "unknown"]),
    authority: z
      .object({
        required: z.boolean(),
        type: z.enum(["user", "policy", "external", "other"]),
        reason: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    availableCapabilities: z.array(missionContinuationCapabilitySchema).max(20),
    fulfillmentPaths: z.array(humanFulfillmentPathSchema).max(10),
    constraints: z.array(z.string().trim().min(1).max(1_000)).max(50),
    consequences: z.array(z.string().trim().min(1).max(1_000)).max(50),
    continuation: z
      .object({
        retryCurrentOperation: z.boolean(),
        freshObservationRequired: z.boolean(),
        newOperationRequired: z.boolean(),
        newDraftRequired: z.boolean(),
        newSessionRequired: z.boolean(),
      })
      .strict(),
    waiting: z.literal(true),
    terminal: z.literal(false),
    lifecycle: awaitingUserLifecycleSchema,
    resumeRef: uuidSchema,
  })
  .strict();
export const activityRelationSchema = z.enum([
  "caused_by",
  "diagnoses",
  "replaces",
  "depends_on",
  "produced",
  "verified_by",
  "accepted_for",
]);
export const missionPurposeSchema = z.enum(["primary", "diagnostic", "recovery"]);
export const missionRelationKindSchema = z.enum(["diagnoses", "recovery_for", "informs"]);
export const missionActivityTypeSchema = z.enum([
  "mission_created",
  "mission_updated",
  "mission_resumed",
  "mission_cancelled",
  "mission_reopened",
  "mission_related",
  "agent_session_started",
  "agent_session_ended",
  "objective_created",
  "objective_updated",
  "flow_created",
  "flow_attached",
  "flow_revised",
  "flow_promoted",
  "run_started",
  "run_completed",
  "run_classified",
  "diagnostic",
  "calibration",
  "credential_created",
  "decision",
  "resume_pointer_updated",
  "run_accepted",
  "evidence_superseded",
  "evidence_invalidated",
  "objective_completed",
  "recording_selection_updated",
  "report_published",
]);

export const missionContextSchema = z
  .object({
    missionId: uuidSchema,
    agentSessionId: uuidSchema,
  })
  .strict();

export const objectiveContextSchema = missionContextSchema
  .extend({ objectiveId: uuidSchema })
  .strict();

export const missionResumePointerSchema = z
  .object({
    objectiveId: uuidSchema,
    recommendedAction: resumeActionSchema,
    flowId: uuidSchema.optional(),
    revisionId: uuidSchema.optional(),
    runId: uuidSchema.optional(),
    explanation: z.string().trim().min(1).max(2_000),
    externalInput: missionExternalInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.recommendedAction === "await_user" && !value.externalInput)
      context.addIssue({
        code: "custom",
        path: ["externalInput"],
        message: "await_user requires durable external-input context",
      });
    if (value.recommendedAction !== "await_user" && value.externalInput)
      context.addIssue({
        code: "custom",
        path: ["externalInput"],
        message: "external-input context is only valid for await_user",
      });
    if (value.externalInput && value.externalInput.resumeRef !== value.objectiveId)
      context.addIssue({
        code: "custom",
        path: ["externalInput", "resumeRef"],
        message: "resumeRef must identify the durable objective",
      });
  });

export const objectiveCriterionSchema = z
  .object({
    description: z.string().trim().min(1).max(2_000),
    required: z.boolean().default(true),
  })
  .strict();

export const missionUserChoiceSourceSchema = z.enum([
  "current_request_explicit",
  "followup_explicit_choice",
]);

export const missionContinuationAuthoritySchema = z
  .object({
    confirmedUserAuthorized: z.literal(true),
    selection: z.literal("continue_existing_mission"),
    source: missionUserChoiceSourceSchema,
  })
  .strict();

export const missionDistinctWorkAuthoritySchema = z
  .object({
    confirmedUserAuthorized: z.literal(true),
    selection: z.literal("start_distinct_mission"),
    source: missionUserChoiceSourceSchema,
  })
  .strict();

export const createMissionSchema = z
  .object({
    title: nameSchema,
    originalInstruction: z.string().trim().min(1).max(20_000),
    provider: agentProviderSchema.default("codex"),
    instructionSnapshot: z.string().trim().min(1).max(20_000),
    connectionId: z.string().trim().min(1).max(500).optional(),
    purpose: missionPurposeSchema.default("primary"),
    idempotencyKey: missionIdempotencyKeySchema,
    distinctReason: z.string().trim().min(1).max(2_000).optional(),
    distinctAuthority: missionDistinctWorkAuthoritySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.distinctReason && !value.distinctAuthority)
      context.addIssue({
        code: "custom",
        path: ["distinctAuthority"],
        message:
          "Starting distinct work after a Mission collision requires explicit current-user authority.",
      });

    if (!value.distinctReason && value.distinctAuthority)
      context.addIssue({
        code: "custom",
        path: ["distinctAuthority"],
        message: "Distinct-work authority may only accompany an intentional distinctReason.",
      });
  });

export const createMissionRelationSchema = missionContextSchema
  .extend({
    targetMissionId: uuidSchema,
    relation: missionRelationKindSchema,
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: missionIdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetMissionId === value.missionId)
      context.addIssue({
        code: "custom",
        path: ["targetMissionId"],
        message: "A Mission relation requires distinct source and target Missions",
      });
  });

export const missionRelationFactSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    sourceMissionId: uuidSchema,
    targetMissionId: uuidSchema,
    relation: missionRelationKindSchema,
    createdByAgentSessionId: uuidSchema,
    reason: z.string().trim().min(1).max(2_000),
    createdAt: z.string().datetime(),
  })
  .strict();

export const updateMissionSchema = missionContextSchema
  .extend({
    title: nameSchema.optional(),
    originalInstruction: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.originalInstruction !== undefined,
    "At least one Mission field must change",
  );

export const startAgentSessionSchema = z
  .object({
    provider: agentProviderSchema,
    instructionSnapshot: z.string().trim().min(1).max(20_000),
    connectionId: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: missionIdempotencyKeySchema,
    continuationAuthority: missionContinuationAuthoritySchema,
  })
  .strict();

export const endAgentSessionSchema = z
  .object({ status: agentSessionStatusSchema.exclude(["active"]) })
  .strict();

export const finalizeAgentWorkSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terminal_objective"),
      missionId: uuidSchema,
      objectiveId: uuidSchema,
      agentSessionId: uuidSchema,
      objectiveStatus: objectiveStatusSchema.extract(["passed", "failed", "blocked", "skipped"]),
      conclusion: z.string().trim().min(1).max(5_000),
      sessionStatus: agentSessionStatusSchema.extract(["completed", "failed"]),
      expectedMissionRevision: z.number().int().nonnegative(),
      idempotencyKey: missionIdempotencyKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("await_user"),
      missionId: uuidSchema,
      objectiveId: uuidSchema,
      agentSessionId: uuidSchema,
      pointer: missionResumePointerSchema,
      expectedMissionRevision: z.number().int().nonnegative(),
      idempotencyKey: missionIdempotencyKeySchema,
    })
    .strict(),
]);

export const finalizedAgentWorkSchema = z
  .object({
    replayed: z.boolean(),
    missionId: uuidSchema,
    objectiveId: uuidSchema,
    missionStatus: missionStatusSchema,
    objectiveStatus: objectiveStatusSchema,
    agentSessionStatus: agentSessionStatusSchema.exclude(["active"]),
    awaitingUser: awaitingUserLifecycleSchema.optional(),
  })
  .strict();

export const createObjectiveSchema = missionContextSchema
  .extend({
    title: nameSchema,
    description: z.string().trim().max(2_000).default(""),
    dependencies: z.array(uuidSchema).max(100).default([]),
    completionCriteria: z.array(objectiveCriterionSchema).min(1).max(100),
    order: z.number().int().nonnegative(),
  })
  .strict();

export const updateObjectiveSchema = missionContextSchema
  .extend({
    title: nameSchema.optional(),
    description: z.string().trim().max(2_000).optional(),
    dependencies: z.array(uuidSchema).max(100).optional(),
    completionCriteria: z.array(objectiveCriterionSchema).min(1).max(100).optional(),
    order: z.number().int().nonnegative().optional(),
    status: objectiveStatusSchema.optional(),
    conclusion: z.string().trim().min(1).max(5_000).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => !["missionId", "agentSessionId"].includes(key)),
    "At least one objective field must change",
  );

export const updateResumePointerSchema = missionContextSchema
  .extend({ pointer: missionResumePointerSchema.nullable() })
  .strict();
export const missionTransitionSchema = missionContextSchema
  .extend({ explanation: z.string().trim().min(1).max(2_000) })
  .strict();

export const attachFlowSchema = objectiveContextSchema
  .extend({
    flowId: uuidSchema,
    visibility: flowVisibilitySchema,
    purpose: flowPurposeSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const classifyRunSchema = missionContextSchema
  .extend({
    role: runRoleSchema,
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const acceptEvidenceSchema = missionContextSchema
  .extend({
    runId: uuidSchema,
    artifactIds: z.array(uuidSchema).max(500).default([]),
    conclusion: z.string().trim().min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.artifactIds).size !== value.artifactIds.length)
      context.addIssue({
        code: "custom",
        path: ["artifactIds"],
        message: "Evidence selection cannot contain duplicate Artifact IDs",
      });
  });
export const createActivityRelationSchema = missionContextSchema
  .extend({
    fromActivityId: uuidSchema,
    toActivityId: uuidSchema,
    relation: activityRelationSchema,
  })
  .strict();

export const setMissionRecordingSelectionSchema = missionContextSchema
  .extend({
    expectedMissionRevision: z.number().int().nonnegative(),
    orderedRunIds: z.array(uuidSchema).max(500),
    idempotencyKey: missionIdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.orderedRunIds).size !== value.orderedRunIds.length)
      context.addIssue({
        code: "custom",
        path: ["orderedRunIds"],
        message: "Recording selection cannot contain duplicate Run IDs",
      });
  });

export const missionRecordingSelectionResultSchema = z
  .object({
    selectionId: uuidSchema,
    missionId: uuidSchema,
    selectionRevision: z.number().int().positive(),
    sourceMissionRevision: z.number().int().nonnegative(),
    orderedRunIds: z.array(uuidSchema),
    sources: z
      .array(
        z
          .object({
            order: z.number().int().nonnegative(),
            runId: uuidSchema,
            canonicalAttemptId: uuidSchema,
          })
          .strict(),
      )
      .default([]),
    missionRevision: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();

export const publishMissionReportSchema = missionContextSchema
  .extend({
    overallConclusion: z.string().trim().min(1).max(20_000),
    journeySummary: z.array(z.string().trim().min(1).max(2_000)).min(1).max(500),
    remainingActions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: missionIdempotencyKeySchema,
  })
  .strict();

export const missionEvidenceArtifactFactSchema = z
  .object({
    id: uuidSchema,
    attemptId: uuidSchema,
    stepId: z.string().nullable().optional(),
    kind: z.string().trim().min(1).max(100),
    availability: z.string().trim().min(1).max(100),
    privacyClassification: z.string().trim().min(1).max(100),
    contentType: z.string().trim().min(1).max(500),
    sizeBytes: z.string().nullable(),
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    contextId: uuidSchema.nullable(),
    captureEpoch: z.number().int().positive().nullable(),
    retentionUntil: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const missionAcceptedEvidenceFactSchema = z
  .object({
    id: uuidSchema,
    objectiveId: uuidSchema,
    runId: uuidSchema,
    artifactId: uuidSchema.nullable(),
    selectionOrder: z.number().int().nonnegative().optional(),
    acceptanceConclusion: z.string().max(10_000),
    acceptedByAgentSessionId: uuidSchema,
    acceptedAt: z.string().datetime(),
    run: z
      .object({
        id: uuidSchema,
        state: z.string().trim().min(1).max(100),
        outcomeClassification: z.string().trim().min(1).max(200).nullable(),
        resultClassification: z.string().trim().min(1).max(200).nullable(),
        reliabilityEligible: z.boolean(),
        flowRevisionId: uuidSchema,
        environmentId: uuidSchema,
        executionModel: z.string().trim().min(1).max(200).nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
      .strict(),
    canonicalAttempt: z
      .object({
        id: uuidSchema,
        runId: uuidSchema,
        attemptNumber: z.number().int().positive(),
        state: z.string().trim().min(1).max(100),
        startedAt: z.string().datetime().nullable(),
        completedAt: z.string().datetime().nullable(),
      })
      .strict(),
    artifact: missionEvidenceArtifactFactSchema.nullable(),
  })
  .strict();

export const missionEvidenceCompositionSchema = z
  .object({
    schemaVersion: z.literal(1),
    missionId: uuidSchema,
    sourceMissionRevision: z.number().int().nonnegative(),
    objectives: z.array(
      z
        .object({
          objectiveId: uuidSchema,
          order: z.number().int().nonnegative(),
          acceptedRunIds: z.array(uuidSchema),
          acceptedArtifactIds: z.array(uuidSchema),
          acceptedEvidence: z.array(missionAcceptedEvidenceFactSchema),
        })
        .strict(),
    ),
    supersededAttemptCount: z.number().int().nonnegative(),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const missionRecordingSelectionSnapshotSchema = z
  .object({
    id: uuidSchema,
    revision: z.number().int().positive(),
    sourceMissionRevision: z.number().int().nonnegative(),
    selectedByAgentSessionId: uuidSchema,
    createdAt: z.string().datetime(),
    sources: z
      .array(
        z
          .object({
            order: z.number().int().nonnegative(),
            runId: uuidSchema,
            canonicalAttemptId: uuidSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const missionRecordingArtifactFactSchema = missionEvidenceArtifactFactSchema.omit({
  retentionUntil: true,
  stepId: true,
});

const missionRecordingTimelineEntrySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    entryType: z.enum([
      "capture_epoch",
      "video_segment",
      "trace_segment",
      "protected_gap",
      "document_transition_gap",
      "unavailable_interval",
      "quarantine_record",
      "checkpoint_boundary",
    ]),
    operationId: z.string().nullable(),
    channel: z.string().nullable(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    reason: z.string().nullable(),
    status: z.string().nullable(),
    privacyStatus: z.string().nullable(),
    contextId: uuidSchema.nullable(),
    captureEpoch: z.number().int().positive().nullable(),
    checkpointId: z.string().nullable(),
    checkpointBoundary: z.string().nullable(),
    artifactId: uuidSchema.nullable(),
    artifact: missionRecordingArtifactFactSchema.nullable(),
    mediaDisposition: z.enum(["playable", "omitted"]).nullable(),
  })
  .strict();

export const missionRecordingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    missionId: uuidSchema,
    sourceMissionRevision: z.number().int().nonnegative(),
    runs: z.array(
      z
        .object({
          order: z.number().int().nonnegative(),
          run: z
            .object({
              id: uuidSchema,
              objectiveId: uuidSchema,
              state: z.string().trim().min(1).max(100),
              outcomeClassification: z.string().trim().min(1).max(200).nullable(),
              resultClassification: z.string().trim().min(1).max(200).nullable(),
              createdAt: z.string().datetime(),
              completedAt: z.string().datetime().nullable(),
            })
            .strict(),
          canonicalAttempt: z
            .object({
              id: uuidSchema,
              runId: uuidSchema,
              attemptNumber: z.number().int().positive(),
              state: z.string().trim().min(1).max(100),
              startedAt: z.string().datetime().nullable(),
              completedAt: z.string().datetime().nullable(),
            })
            .strict(),
          continuityFromPrevious: z
            .object({
              kind: z.literal("successor_checkpoint"),
              predecessorRunId: uuidSchema,
              checkpointId: uuidSchema,
              restoredByPraxisSessionId: uuidSchema,
            })
            .strict()
            .nullable(),
          timeline: z.array(missionRecordingTimelineEntrySchema),
        })
        .strict(),
    ),
    boundaries: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              order: z.number().int().nonnegative(),
              kind: z.literal("verified_checkpoint"),
              predecessorRunId: uuidSchema,
              successorRunId: uuidSchema,
              checkpointId: uuidSchema,
              restoredByPraxisSessionId: uuidSchema,
            })
            .strict(),
          z
            .object({
              order: z.number().int().nonnegative(),
              kind: z.literal("recording_gap"),
              predecessorRunId: uuidSchema,
              successorRunId: uuidSchema,
              startedAt: z.string().datetime().nullable(),
              endedAt: z.string().datetime().nullable(),
              reason: z.literal("browser_authority_changed_without_verified_continuity"),
            })
            .strict(),
        ]),
      )
      .default([]),
    recordingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const missionRelationDisclosureSchema = z
  .object({
    relationId: uuidSchema,
    relation: missionRelationKindSchema,
    direction: z.enum(["incoming", "outgoing"]),
    reason: z.string().trim().min(1).max(2_000),
    createdAt: z.string().datetime(),
    relatedMission: z
      .object({
        id: uuidSchema,
        purpose: missionPurposeSchema,
        status: missionStatusSchema,
      })
      .strict(),
    unresolvedProtectedOperations: z.array(
      z
        .object({
          protectedOperationId: uuidSchema,
          operationId: z.string().trim().min(1).max(200),
          objectiveId: uuidSchema,
          state: z.string().trim().min(1).max(100),
          mutationOutcome: z.enum(["not_attempted", "not_applied", "applied", "unknown"]),
          recoveryClass: z.string().trim().min(1).max(100).nullable(),
          failureCode: z.string().trim().min(1).max(200).nullable(),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export const missionReportSnapshotSchema = z
  .object({
    mission: z
      .object({
        id: uuidSchema,
        title: z.string().trim().min(1).max(2_000),
        originalInstruction: z.string().max(20_000),
        purpose: missionPurposeSchema.default("primary"),
        status: missionStatusSchema,
        sourceRevision: z.number().int().nonnegative(),
      })
      .strict(),
    overallConclusion: z.string().max(20_000),
    journeySummary: z.array(z.string().max(2_000)).max(500),
    remainingActions: z.array(z.string().max(2_000)).max(100),
    objectiveResults: z.array(
      z
        .object({
          id: uuidSchema,
          title: z.string().max(2_000),
          status: objectiveStatusSchema,
          conclusion: z.string().nullable(),
          acceptedRunIds: z.array(uuidSchema),
          acceptedArtifactIds: z.array(uuidSchema),
        })
        .strict(),
    ),
    evidence: missionEvidenceCompositionSchema,
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    recordingSelection: missionRecordingSelectionSnapshotSchema.nullable(),
    recording: missionRecordingManifestSchema.nullable(),
    recordingDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    mutationReceipts: z.array(mutationReceiptSchema).default([]),
    relatedMissions: z.array(missionRelationDisclosureSchema).default([]),
    compositionDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    supersededAttemptCount: z.number().int().nonnegative(),
    generatedAt: z.string().datetime(),
  })
  .strict();

export const missionReportPreviewSchema = z
  .object({
    completionReadiness: missionCompletionReadinessSchema,
    snapshot: missionReportSnapshotSchema.nullable(),
  })
  .strict();

export const publishedMissionReportSchema = z
  .object({
    id: uuidSchema,
    missionId: uuidSchema,
    revision: z.number().int().positive(),
    status: z.literal("published"),
    snapshot: missionReportSnapshotSchema,
    replayed: z.boolean(),
  })
  .strict();

export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type MissionCompletionReadiness = z.infer<typeof missionCompletionReadinessSchema>;
export type MissionReadinessBlocker = z.infer<typeof missionReadinessBlockerSchema>;
export type ObjectiveStatus = z.infer<typeof objectiveStatusSchema>;
export type FlowVisibility = z.infer<typeof flowVisibilitySchema>;
export type FlowPurpose = z.infer<typeof flowPurposeSchema>;
export type RunRole = z.infer<typeof runRoleSchema>;
export type MissionContext = z.infer<typeof missionContextSchema>;
export type ObjectiveContext = z.infer<typeof objectiveContextSchema>;
export type MissionResumePointer = z.infer<typeof missionResumePointerSchema>;
type ParsedCreateMissionInput = z.infer<typeof createMissionSchema>;
export type CreateMissionInput = Omit<ParsedCreateMissionInput, "purpose"> & {
  purpose?: ParsedCreateMissionInput["purpose"];
};
export type CreateMissionRelationInput = z.infer<typeof createMissionRelationSchema>;
export type MissionRelationFact = z.infer<typeof missionRelationFactSchema>;
export type MissionRelationDisclosure = z.infer<typeof missionRelationDisclosureSchema>;
export type UpdateMissionInput = z.infer<typeof updateMissionSchema>;
export type StartAgentSessionInput = z.infer<typeof startAgentSessionSchema>;
export type EndAgentSessionInput = z.infer<typeof endAgentSessionSchema>;
export type FinalizeAgentWorkInput = z.infer<typeof finalizeAgentWorkSchema>;
export type FinalizedAgentWork = z.infer<typeof finalizedAgentWorkSchema>;
export type CreateObjectiveInput = z.infer<typeof createObjectiveSchema>;
export type UpdateObjectiveInput = z.infer<typeof updateObjectiveSchema>;
export type UpdateResumePointerInput = z.infer<typeof updateResumePointerSchema>;
export type MissionTransitionInput = z.infer<typeof missionTransitionSchema>;
export type AttachFlowInput = z.infer<typeof attachFlowSchema>;
export type ClassifyRunInput = z.infer<typeof classifyRunSchema>;
export type AcceptEvidenceInput = z.infer<typeof acceptEvidenceSchema>;
export type CreateActivityRelationInput = z.infer<typeof createActivityRelationSchema>;
export type SetMissionRecordingSelectionInput = z.infer<typeof setMissionRecordingSelectionSchema>;
export type PublishMissionReportInput = z.infer<typeof publishMissionReportSchema>;
export type PublishedMissionReport = z.infer<typeof publishedMissionReportSchema>;
export type MissionReportPreview = z.infer<typeof missionReportPreviewSchema>;
