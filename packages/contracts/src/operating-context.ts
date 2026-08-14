import { z } from "zod";
import { missionResumePointerSchema } from "./mission.js";

const uuid = z.string().uuid();

export const getOperatingContextSchema = z.object({
  projectId: uuid.optional(),
  missionId: uuid.optional(),
  requiredOrigin: z.string().url().transform((value) => new URL(value).origin).optional(),
  requiredCredentialReferences: z.array(uuid).max(20).default([]),
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
  }).strict(), 20),
  environments: boundedCollection(z.object({
    id: uuid,
    name: z.string(),
    baseOrigin: z.string().url(),
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
