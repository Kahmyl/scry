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
const reportEvidenceReferenceSchema = z.strictObject({
  runId: uuid,
  artifactId: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Application expectations, never browser-tool or infrastructure verdicts. */
export const applicationTestCheckSchema = z
  .strictObject({
    title: z.string().min(1).max(200),
    expected: z.string().min(1).max(4000).optional(),
    actual: z.string().min(1).max(4000),
    status: z.enum([
      "matched_expectation",
      "different_from_expectation",
      "inconclusive",
      "not_tested",
    ]),
    evidence: z.array(reportEvidenceReferenceSchema).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      ["matched_expectation", "different_from_expectation"].includes(value.status) &&
      !value.expected
    )
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "An application expectation is required for this comparison",
      });
  });
export const applicationReportPresentationSchema = missionReportPresentationSchema.extend({
  subject: z.literal("application"),
  scope: z.array(z.string().min(1).max(4000)).max(100).default([]),
  checks: z.array(applicationTestCheckSchema).min(1).max(200),
});
export type ApplicationReportPresentation = z.infer<typeof applicationReportPresentationSchema>;
export const publishBrowserMissionReportSchema = z.object({
  agentSessionId: uuid,
  summary: z.string().min(1).max(10_000),
  safeReport: z
    .object({
      presentation: z
        .union([applicationReportPresentationSchema, missionReportPresentationSchema])
        .optional(),
    })
    .catchall(z.unknown())
    .describe(
      "Customer reports describe the tested application. Include presentation: {subject: 'application', scope: string[], checks: [{title, expected?, actual, status: 'matched_expectation'|'different_from_expectation'|'inconclusive'|'not_tested', evidence?: [{runId,artifactId}]}], observations: [{title,detail,suggestion?,evidence?}], limitations: string[]}. Comparisons require an explicit application expectation. Report actual verified outcomes after recovery; never grade browser-tool success, Scry capabilities or infrastructure as application findings. Describe unreached checks as not_tested/inconclusive without internal error details. Historical formats are retained for operator review, not automatically promoted to customer findings.",
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
export type PublishBrowserMissionReportInput = z.input<typeof publishBrowserMissionReportSchema>;
