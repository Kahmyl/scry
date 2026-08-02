import { z } from "zod";

import { nameSchema, uuidSchema } from "./api.js";

const missionIdempotencyKeySchema = z.string().trim().min(8).max(200);

export const missionStatusSchema = z.enum(["planning", "running", "blocked", "awaiting_user", "completed", "failed", "cancelled"]);
export const objectiveStatusSchema = z.enum(["pending", "running", "passed", "failed", "blocked", "skipped"]);
export const agentProviderSchema = z.enum(["codex", "claude", "scry_agent", "human"]);
export const agentSessionStatusSchema = z.enum(["active", "completed", "interrupted", "failed"]);
export const flowVisibilitySchema = z.enum(["reusable", "mission_local", "internal"]);
export const flowPurposeSchema = z.enum(["primary", "setup", "acceptance", "diagnostic", "calibration", "reconciliation", "cleanup", "verification"]);
export const runRoleSchema = z.enum(["exploratory", "diagnostic", "calibration", "candidate", "accepted", "superseded", "invalidated"]);
export const reportStatusSchema = z.enum(["published", "superseded"]);
export const resumeActionSchema = z.enum(["revise_flow", "run_candidate", "review_failure", "complete_calibration", "await_user", "publish_report"]);
export const activityRelationSchema = z.enum(["caused_by", "diagnoses", "replaces", "depends_on", "produced", "verified_by", "accepted_for"]);
export const missionActivityTypeSchema = z.enum([
  "mission_created", "mission_updated", "mission_resumed", "mission_cancelled", "mission_reopened", "agent_session_started", "agent_session_ended",
  "objective_created", "objective_updated", "flow_created", "flow_attached", "flow_revised", "flow_promoted", "run_started",
  "run_completed", "run_classified", "diagnostic", "calibration", "credential_created", "decision", "resume_pointer_updated",
  "run_accepted", "evidence_superseded", "evidence_invalidated", "objective_completed", "report_published",
]);

export const missionContextSchema = z.object({
  missionId: uuidSchema,
  agentSessionId: uuidSchema,
}).strict();

export const objectiveContextSchema = missionContextSchema.extend({ objectiveId: uuidSchema }).strict();

export const missionResumePointerSchema = z.object({
  objectiveId: uuidSchema,
  recommendedAction: resumeActionSchema,
  flowId: uuidSchema.optional(),
  revisionId: uuidSchema.optional(),
  runId: uuidSchema.optional(),
  explanation: z.string().trim().min(1).max(2_000),
}).strict();

export const objectiveCriterionSchema = z.object({
  description: z.string().trim().min(1).max(2_000),
  required: z.boolean().default(true),
}).strict();

export const createMissionSchema = z.object({
  title: nameSchema,
  originalInstruction: z.string().trim().min(1).max(20_000),
  provider: agentProviderSchema.default("codex"),
  instructionSnapshot: z.string().trim().min(1).max(20_000),
  connectionId: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: missionIdempotencyKeySchema,
  distinctReason: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const updateMissionSchema = missionContextSchema.extend({
  title: nameSchema.optional(),
  originalInstruction: z.string().trim().min(1).max(20_000).optional(),
}).strict().refine((value) => value.title !== undefined || value.originalInstruction !== undefined, "At least one Mission field must change");

export const startAgentSessionSchema = z.object({
  provider: agentProviderSchema,
  instructionSnapshot: z.string().trim().min(1).max(20_000),
  connectionId: z.string().trim().min(1).max(500).optional(),
  idempotencyKey: missionIdempotencyKeySchema,
}).strict();

export const endAgentSessionSchema = z.object({ status: agentSessionStatusSchema.exclude(["active"]) }).strict();

export const createObjectiveSchema = missionContextSchema.extend({
  title: nameSchema,
  description: z.string().trim().max(2_000).default(""),
  dependencies: z.array(uuidSchema).max(100).default([]),
  completionCriteria: z.array(objectiveCriterionSchema).min(1).max(100),
  order: z.number().int().nonnegative(),
}).strict();

export const updateObjectiveSchema = missionContextSchema.extend({
  title: nameSchema.optional(),
  description: z.string().trim().max(2_000).optional(),
  dependencies: z.array(uuidSchema).max(100).optional(),
  completionCriteria: z.array(objectiveCriterionSchema).min(1).max(100).optional(),
  order: z.number().int().nonnegative().optional(),
  status: objectiveStatusSchema.optional(),
  conclusion: z.string().trim().min(1).max(5_000).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => !["missionId", "agentSessionId"].includes(key)), "At least one objective field must change");

export const updateResumePointerSchema = missionContextSchema.extend({ pointer: missionResumePointerSchema.nullable() }).strict();
export const missionTransitionSchema = missionContextSchema.extend({ explanation: z.string().trim().min(1).max(2_000) }).strict();

export const attachFlowSchema = objectiveContextSchema.extend({
  flowId: uuidSchema,
  visibility: flowVisibilitySchema,
  purpose: flowPurposeSchema,
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const classifyRunSchema = missionContextSchema.extend({
  role: runRoleSchema,
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const acceptEvidenceSchema = missionContextSchema.extend({
  runId: uuidSchema,
  artifactIds: z.array(uuidSchema).max(500).default([]),
  conclusion: z.string().trim().min(1).max(10_000),
}).strict();
export const createActivityRelationSchema=missionContextSchema.extend({fromActivityId:uuidSchema,toActivityId:uuidSchema,relation:activityRelationSchema}).strict();

export const publishMissionReportSchema = missionContextSchema.extend({
  overallConclusion: z.string().trim().min(1).max(20_000),
  journeySummary: z.array(z.string().trim().min(1).max(2_000)).min(1).max(500),
  remainingActions: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

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
export type CreateObjectiveInput = z.infer<typeof createObjectiveSchema>;
export type UpdateObjectiveInput = z.infer<typeof updateObjectiveSchema>;
export type UpdateResumePointerInput = z.infer<typeof updateResumePointerSchema>;
export type MissionTransitionInput = z.infer<typeof missionTransitionSchema>;
export type AttachFlowInput = z.infer<typeof attachFlowSchema>;
export type ClassifyRunInput = z.infer<typeof classifyRunSchema>;
export type AcceptEvidenceInput = z.infer<typeof acceptEvidenceSchema>;
export type CreateActivityRelationInput=z.infer<typeof createActivityRelationSchema>;
export type PublishMissionReportInput = z.infer<typeof publishMissionReportSchema>;
