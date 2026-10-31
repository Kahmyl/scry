import { z } from "zod";
import { browserDisclosureModeSchema } from "./browser-execution.js";

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(256);

export const startBrowserMissionSchema = z.object({
  projectId: uuid,
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20_000),
  idempotencyKey,
  provider: z.enum(["codex", "claude", "scry_agent", "human"]),
  model: z.string().min(1).max(200).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const createBrowserEnvironmentSchema = z.object({
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

export const createBrowserObjectiveSchema = z.object({
  agentSessionId: uuid,
  title: z.string().min(1).max(200),
  description: z.string().max(4_000).default(""),
  completionCriteria: z.record(z.string(), z.unknown()),
  objectiveOrder: z.number().int().nonnegative(),
  idempotencyKey,
});

export const createBrowserFlowSchema = z.object({
  agentSessionId: uuid,
  name: z.string().min(1).max(200),
  purpose: z.string().max(4_000).default(""),
  definition: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey,
});

export const startBrowserRunSchema = z.object({
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

export const createBrowserProtectedInputSchema = z.object({
  projectId: uuid,
  displayName: z.string().trim().min(1).max(128),
  value: z.string().min(1).max(65_536),
  expiresInSeconds: z.number().int().min(60).max(31_536_000).nullable().default(3_600),
  idempotencyKey,
});

export const bindBrowserProtectedInputsSchema = z.object({
  protectedInputIds: z.array(uuid).min(1).max(50),
  userConfirmed: z.literal(true),
});

export const finalizeBrowserRunSchema = z.object({
  ownerGeneration: z.number().int().positive(),
  outcome: z.enum(["passed", "application_failure", "environment_failure", "blocked", "cancelled"]),
  conclusion: z.string().min(1).max(4_000),
});

export const missionReportPresentationSchema = z.strictObject({
  verified: z.array(z.string().min(1).max(4000)).max(200).default([]),
  observations: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(200),
        detail: z.string().min(1).max(4000),
        suggestion: z.string().max(2000).optional(),
        evidence: z
          .array(z.strictObject({ runId: uuid, artifactId: z.string().regex(/^[a-f0-9]{64}$/) }))
          .max(50)
          .default([]),
      }),
    )
    .max(200)
    .default([]),
  limitations: z.array(z.string().min(1).max(4000)).max(100).default([]),
});
export const publishBrowserMissionReportSchema = z.object({
  agentSessionId: uuid,
  summary: z.string().min(1).max(10_000),
  safeReport: z
    .record(z.string(), z.unknown())
    .superRefine((value, ctx) => {
      if (value.presentation !== undefined) {
        const result = missionReportPresentationSchema.safeParse(value.presentation);
        if (!result.success)
          ctx.addIssue({
            code: "custom",
            message: "Invalid report presentation",
            path: ["presentation"],
          });
      }
    })
    .describe(
      "For a readable report include presentation: {verified: string[], observations: [{title, detail, suggestion?, evidence?: [{runId,artifactId}]}], limitations: string[]}. Keep recovered failures visible. Additional domain details remain available for diagnostics.",
    ),
});

export type StartBrowserMissionInput = z.infer<typeof startBrowserMissionSchema>;
export type CreateBrowserEnvironmentInput = z.infer<typeof createBrowserEnvironmentSchema>;
export type CreateBrowserObjectiveInput = z.infer<typeof createBrowserObjectiveSchema>;
export type CreateBrowserFlowInput = z.infer<typeof createBrowserFlowSchema>;
export type StartBrowserRunInput = z.infer<typeof startBrowserRunSchema>;
export type CreateBrowserProtectedInputInput = z.infer<typeof createBrowserProtectedInputSchema>;
export type BindBrowserProtectedInputsInput = z.infer<typeof bindBrowserProtectedInputsSchema>;
export type FinalizeBrowserRunInput = z.infer<typeof finalizeBrowserRunSchema>;
export type PublishBrowserMissionReportInput = z.infer<typeof publishBrowserMissionReportSchema>;
