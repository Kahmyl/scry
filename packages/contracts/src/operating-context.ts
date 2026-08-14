import { z } from "zod";
import { missionResumePointerSchema } from "./mission.js";
import { agentDecisionBoundarySchema } from "./execution-kernel.js";

const uuid = z.string().uuid();

export const getOperatingContextSchema = z.object({
  projectId: uuid.optional(),
  missionId: uuid.optional(),
  requiredOrigin: z.string().url().transform((value) => new URL(value).origin).optional(),
  requiredCredentialReferences: z.array(uuid).max(20).default([]),
  authorizeDistinctMissionForReadOnlyUnknown: z.boolean().default(false),
}).strict();

const boundedCollection = <T extends z.ZodTypeAny>(item: T, maximum: number) => z.object({
  items: z.array(item).max(maximum),
  truncated: z.boolean(),
}).strict();

export const operatingContextSchema = z.object({
  selection: z.object({
    project: z.object({ id: uuid, name: z.string() }).strict().nullable(),
    requiresProjectSelection: z.boolean(),
    projectCandidates: boundedCollection(
      z.object({ id: uuid, name: z.string(), description: z.string() }).strict(),
      5,
    ),
  }).strict(),
  missions: z.object({
    selectedMissionId: uuid.optional(),
    candidates: boundedCollection(z.object({
      id: uuid,
      title: z.string(),
      status: z.enum(["planning", "running", "blocked", "awaiting_user"]),
      revision: z.number().int().nonnegative(),
      currentObjectiveId: uuid.nullable(),
      resumePointer: missionResumePointerSchema.nullable(),
    }).strict(), 5),
  }).strict(),
  credentials: boundedCollection(z.object({
    referenceId: uuid,
    name: z.string(),
    securityStatus: z.enum(["active", "compromised", "revoked"]),
    eligibleForAuthorization: z.boolean(),
    authorizedEnvironmentIds: z.array(uuid).max(20),
    authorizedEnvironmentIdsTruncated: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(), 20),
  environments: boundedCollection(z.object({
    id: uuid,
    name: z.string(),
    baseOrigin: z.string().url(),
    resourceExists: z.literal(true),
    policyValid: z.boolean(),
    executionReadiness: z.enum(["runtime_required", "runtime_admitted", "recovery_required"]),
    compatible: z.boolean(),
    incompatibilities: z.array(z.enum(["origin_not_allowed", "credential_not_authorized"])),
    credentialReferenceIds: z.array(uuid).max(20),
  }).strict(), 10),
  authoring: z.object({
    reusable: boundedCollection(z.object({
      sessionId: uuid,
      missionId: uuid,
      objectiveId: uuid,
      flowDraftId: uuid,
      environmentId: uuid,
      state: z.literal("active"),
    }).strict(), 5),
    recoverable: boundedCollection(z.object({
      sessionId: uuid,
      missionId: uuid,
      objectiveId: uuid,
      flowDraftId: uuid,
      environmentId: uuid,
      turnId: uuid,
      turnState: z.literal("decision_required"),
      mutationOutcome: z.literal("not_applied"),
      recoveryTool: z.literal("advance_flow_authoring"),
      recoveryKind: z.literal("intents"),
      requiresPendingTurn: z.literal(false),
      recoveryBinding: agentDecisionBoundarySchema.shape.authoringRecovery,
    }).strict(), 5),
    uncertain: boundedCollection(z.object({
      sessionId: uuid,
      missionId: uuid,
      objectiveId: uuid,
      flowDraftId: uuid,
      environmentId: uuid,
      operationId: z.string().trim().min(1).max(200),
      originalMutationOutcome: z.literal("unknown"),
      redispatchAllowed: z.literal(false),
      inspectionTool: z.literal("get_flow_authoring"),
      reconciliationAvailable: z.boolean(),
      distinctMissionAlternative: z.object({
        available: z.literal(true),
        tool: z.literal("start_mission"),
        requiresExplicitUserAuthority: z.literal(true),
        preservesCurrentMissionFence: z.literal(true),
        basis: z.literal("uncertain_operation_declared_read_only"),
      }).strict().optional(),
    }).strict(), 5),
    ready: z.boolean(),
    missing: z.array(z.enum([
      "project", "mission", "objective", "environment", "flow_draft", "authoring_session",
    ])),
  }).strict(),
  continuation: z.object({
    deterministicPreparationAvailable: z.boolean(),
    userAuthorityRequired: z.boolean(),
    safeActions: z.array(z.string()).max(10),
    blockerCode: z.enum([
      "NO_PROJECT", "PROJECT_SELECTION_REQUIRED", "MISSION_SELECTION_REQUIRED",
      "REQUIREMENTS_UNSATISFIED",
    ]).optional(),
  }).strict(),
}).strict();

export type GetOperatingContextInput = z.infer<typeof getOperatingContextSchema>;
export type OperatingContext = z.infer<typeof operatingContextSchema>;
