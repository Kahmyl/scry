import { z } from "zod";
import { browserDisclosureModeSchema } from "./browser-execution-v2.js";

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(256);

export const startBrowserMissionV2Schema = z.object({
  projectId: uuid,
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20_000),
  idempotencyKey,
  provider: z.enum(["codex", "claude", "scry_agent", "human"]),
  model: z.string().min(1).max(200).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const createBrowserEnvironmentV2Schema = z.object({
  projectId: uuid,
  name: z.string().min(1).max(200),
  baseOrigin: z
    .string()
    .url()
    .refine((value) => new URL(value).origin === value),
  allowedServiceOrigins: z
    .array(
      z
        .string()
        .url()
        .refine((value) => new URL(value).origin === value),
    )
    .max(20)
    .default([]),
  disclosureMode: browserDisclosureModeSchema,
  idempotencyKey,
});

export const createBrowserObjectiveV2Schema = z.object({
  agentSessionId: uuid,
  title: z.string().min(1).max(200),
  description: z.string().max(4_000).default(""),
  completionCriteria: z.record(z.string(), z.unknown()),
  objectiveOrder: z.number().int().nonnegative(),
  idempotencyKey,
});

export const createBrowserFlowV2Schema = z.object({
  agentSessionId: uuid,
  name: z.string().min(1).max(200),
  purpose: z.string().max(4_000).default(""),
  definition: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey,
});

export const startBrowserRunV2Schema = z.object({
  projectId: uuid,
  missionId: uuid,
  objectiveId: uuid,
  agentSessionId: uuid,
  flowId: uuid,
  flowRevisionId: uuid,
  environmentId: uuid,
  idempotencyKey,
  authenticationCommitLimit: z.number().int().nonnegative().max(20).default(2),
  businessCommitLimit: z.number().int().nonnegative().max(100).default(10),
  protectedInputIds: z.array(uuid).max(50).default([]),
});

export const createBrowserProtectedInputV2Schema = z.object({
  projectId: uuid,
  displayName: z.string().trim().min(1).max(128),
  value: z.string().min(1).max(65_536),
  expiresInSeconds: z.number().int().min(60).max(31_536_000).nullable().default(3_600),
  idempotencyKey,
});

export const bindBrowserProtectedInputsV2Schema = z.object({
  protectedInputIds: z.array(uuid).min(1).max(50),
  userConfirmed: z.literal(true),
});

export const finalizeBrowserRunV2Schema = z.object({
  ownerGeneration: z.number().int().positive(),
  outcome: z.enum(["passed", "application_failure", "environment_failure", "blocked", "cancelled"]),
  conclusion: z.string().min(1).max(4_000),
});

export const publishBrowserMissionReportV2Schema = z.object({
  agentSessionId: uuid,
  summary: z.string().min(1).max(10_000),
  safeReport: z.record(z.string(), z.unknown()),
});

export type StartBrowserMissionV2Input = z.infer<typeof startBrowserMissionV2Schema>;
export type CreateBrowserEnvironmentV2Input = z.infer<typeof createBrowserEnvironmentV2Schema>;
export type CreateBrowserObjectiveV2Input = z.infer<typeof createBrowserObjectiveV2Schema>;
export type CreateBrowserFlowV2Input = z.infer<typeof createBrowserFlowV2Schema>;
export type StartBrowserRunV2Input = z.infer<typeof startBrowserRunV2Schema>;
export type CreateBrowserProtectedInputV2Input = z.infer<
  typeof createBrowserProtectedInputV2Schema
>;
export type BindBrowserProtectedInputsV2Input = z.infer<typeof bindBrowserProtectedInputsV2Schema>;
export type FinalizeBrowserRunV2Input = z.infer<typeof finalizeBrowserRunV2Schema>;
export type PublishBrowserMissionReportV2Input = z.infer<
  typeof publishBrowserMissionReportV2Schema
>;
