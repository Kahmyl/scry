import { z } from "zod";

import { nameSchema, uuidSchema } from "./api.js";

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
export const missionActivityTypeSchema = z.enum([
  "mission_created",
  "mission_updated",
  "mission_resumed",
  "mission_cancelled",
  "mission_reopened",
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
  .strict();
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

export const publishMissionReportSchema = missionContextSchema
  .extend({
    overallConclusion: z.string().trim().min(1).max(20_000),
    journeySummary: z.array(z.string().trim().min(1).max(2_000)).min(1).max(500),
    remainingActions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: missionIdempotencyKeySchema,
  })
  .strict();

export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type ObjectiveStatus = z.infer<typeof objectiveStatusSchema>;
export type FlowVisibility = z.infer<typeof flowVisibilitySchema>;
export type FlowPurpose = z.infer<typeof flowPurposeSchema>;
export type RunRole = z.infer<typeof runRoleSchema>;
export type MissionContext = z.infer<typeof missionContextSchema>;
export type ObjectiveContext = z.infer<typeof objectiveContextSchema>;
export type MissionResumePointer = z.infer<typeof missionResumePointerSchema>;
export type CreateMissionInput = z.infer<typeof createMissionSchema>;
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
