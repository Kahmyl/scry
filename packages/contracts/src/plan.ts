import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const credentialReference = z.string().uuid();
const nonEmptyText = z.string().trim().min(1).max(2_000);

export const budgetsSchema = z
  .object({
    maxActions: z.number().int().min(1).max(500).default(100),
    maxDurationMs: z.number().int().min(1_000).max(1_800_000).default(120_000),
    maxNavigations: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const locatorSchema = z.discriminatedUnion("strategy", [
  z
    .object({
      strategy: z.literal("role"),
      role: z.enum([
        "button",
        "checkbox",
        "combobox",
        "dialog",
        "heading",
        "link",
        "listbox",
        "menuitem",
        "option",
        "radio",
        "tab",
        "textbox",
      ]),
      name: z.string().trim().min(1).max(500).optional(),
      exact: z.boolean().default(true),
    })
    .strict(),
  z.object({ strategy: z.literal("label"), value: nonEmptyText, exact: z.boolean().default(false) }).strict(),
  z.object({ strategy: z.literal("placeholder"), value: nonEmptyText, exact: z.boolean().default(false) }).strict(),
  z.object({ strategy: z.literal("text"), value: nonEmptyText, exact: z.boolean().default(true) }).strict(),
  z.object({ strategy: z.literal("testId"), value: nonEmptyText }).strict(),
  z
    .object({
      strategy: z.literal("css"),
      value: nonEmptyText,
      justification: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

const timeout = z.number().int().min(100).max(60_000).optional();

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2_048), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("click"), target: locatorSchema, timeoutMs: timeout }).strict(),
  z
    .object({
      type: z.literal("fill"),
      target: locatorSchema,
      value: z.string().max(20_000).optional(),
      secretRef: credentialReference.optional(),
      capturedSecretRef: identifier.optional(),
      capturedValueRef: identifier.optional(),
      timeoutMs: timeout,
    })
    .strict()
    .refine((value) => [value.value, value.secretRef, value.capturedSecretRef, value.capturedValueRef].filter((item) => item !== undefined).length === 1, {
      message: "fill requires exactly one of value, secretRef, capturedSecretRef, or capturedValueRef",
    }),
  z.object({
    type: z.literal("captureSecret"),
    target: locatorSchema,
    reference: identifier,
    credentialName: z.string().trim().min(1).max(200),
    timeoutMs: timeout,
  }).strict(),
  z.object({
    type: z.literal("captureValue"),
    target: locatorSchema,
    reference: identifier,
    timeoutMs: timeout,
  }).strict(),
  z.object({ type: z.literal("select"), target: locatorSchema, value: nonEmptyText, timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("check"), target: locatorSchema, checked: z.boolean(), timeoutMs: timeout }).strict(),
  z
    .object({
      type: z.literal("press"),
      target: locatorSchema.optional(),
      key: z.enum(["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]),
      timeoutMs: timeout,
    })
    .strict(),
  z.object({ type: z.literal("scroll"), target: locatorSchema.optional(), deltaY: z.number().int().min(-10_000).max(10_000) }).strict(),
  z
    .object({
      type: z.literal("waitFor"),
      target: locatorSchema,
      state: z.enum(["visible", "hidden", "attached", "detached"]),
      timeoutMs: timeout,
    })
    .strict(),
  z.object({ type: z.literal("screenshot"), name: identifier, fullPage: z.boolean().default(false) }).strict(),
]);

export const assertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visible"), target: locatorSchema, timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("hidden"), target: locatorSchema, timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("text"), target: locatorSchema, expected: nonEmptyText, exact: z.boolean().default(true), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("value"), target: locatorSchema, expected: z.string().max(20_000), timeoutMs: timeout }).strict(),
  z.object({ type: z.literal("url"), expected: z.string().min(1).max(2_048), match: z.enum(["exact", "path", "contains"]).default("path"), timeoutMs: timeout }).strict(),
]);

const readinessStatusRangeSchema = z
  .object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) })
  .strict()
  .refine((value) => value.min <= value.max, "status range min must not exceed max");

export const readinessConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visible"), target: locatorSchema }).strict(),
  z.object({ type: z.literal("hidden"), target: locatorSchema }).strict(),
  z.object({ type: z.literal("text"), target: locatorSchema, expected: nonEmptyText, exact: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("value"), target: locatorSchema, expected: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal("checked"), target: locatorSchema, expected: z.boolean() }).strict(),
  z.object({ type: z.literal("url"), expected: z.string().min(1).max(2_048), match: z.enum(["exact", "path", "contains"]).default("path") }).strict(),
  z.object({
    type: z.literal("content"),
    target: locatorSchema,
    minimumChildren: z.number().int().min(1).max(10_000).optional(),
    minimumTextLength: z.number().int().min(1).max(1_000_000).optional(),
    requiredText: nonEmptyText.optional(),
  }).strict().refine(
    (value) => value.minimumChildren !== undefined || value.minimumTextLength !== undefined || value.requiredText !== undefined,
    "content readiness requires minimumChildren, minimumTextLength, or requiredText",
  ),
  z.object({
    type: z.literal("request"),
    urlPattern: nonEmptyText,
    method: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()).optional(),
    status: readinessStatusRangeSchema.default({ min: 200, max: 399 }),
  }).strict(),
  z.object({ type: z.literal("domStable"), quietWindowMs: z.number().int().min(100).max(3_000).default(500) }).strict(),
  z.object({
    type: z.literal("networkQuiet"),
    quietWindowMs: z.number().int().min(100).max(3_000).default(500),
    ignoreUrlPatterns: z.array(nonEmptyText).max(50).default([]),
  }).strict(),
  z.object({ type: z.literal("delay"), durationMs: z.number().int().min(100).max(30_000) }).strict(),
]);

export const readinessSchema = z.object({
  mode: z.enum(["all", "any"]).default("all"),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  conditions: z.array(readinessConditionSchema).min(1).max(20),
}).strict();

export const stepSchema = z
  .object({
    id: identifier,
    title: z.string().trim().min(1).max(500),
    action: actionSchema,
    assertions: z.array(assertionSchema).max(20).default([]),
    onFailure: z.enum(["stop", "continue"]).default("stop"),
    evidence: z.array(z.enum(["screenshot", "dom", "network"])).max(3).default([]),
  })
  .strict();

export const stepV2Schema = stepSchema.extend({
  after: readinessSchema.optional(),
  captureIntent: z.enum(["final", "transient"]).default("final"),
  transientJustification: z.string().trim().min(10).max(500).optional(),
}).strict().superRefine((step, context) => {
  if (step.captureIntent === "transient" && !step.transientJustification) {
    context.addIssue({
      code: "custom",
      message: "transient capture requires a justification",
      path: ["transientJustification"],
    });
  }
  if (step.captureIntent === "final" && step.transientJustification) {
    context.addIssue({
      code: "custom",
      message: "transientJustification is only valid for transient capture",
      path: ["transientJustification"],
    });
  }
});

export const testPlanV1Schema = z
  .object({
    protocolVersion: z.literal("1"),
    name: z.string().trim().min(1).max(200),
    objective: nonEmptyText,
    preconditions: z.array(nonEmptyText).max(20).default([]),
    allowedOrigins: z
      .array(
        z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return ["http:", "https:"].includes(url.protocol) && value === url.origin;
          }, "allowed origins must be canonical HTTP(S) origins without a trailing slash"),
      )
      .min(1)
      .max(5),
    budgets: budgetsSchema,
    steps: z.array(stepSchema).min(1).max(500),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.steps.length > plan.budgets.maxActions) {
      context.addIssue({
        code: "custom",
        message: "step count exceeds the plan action budget",
        path: ["budgets", "maxActions"],
      });
    }

    const ids = new Set<string>();
    let navigationCount = 0;
    for (const [index, step] of plan.steps.entries()) {
      if (ids.has(step.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate step id: ${step.id}`,
          path: ["steps", index, "id"],
        });
      }
      ids.add(step.id);

      if (step.action.type === "navigate") {
        navigationCount += 1;
        let target: URL;
        try {
          target = new URL(step.action.url, plan.allowedOrigins[0]);
        } catch {
          context.addIssue({
            code: "custom",
            message: "navigation URL is invalid",
            path: ["steps", index, "action", "url"],
          });
          continue;
        }
        if (!plan.allowedOrigins.includes(target.origin)) {
          context.addIssue({
            code: "custom",
            message: `navigation origin is not allowed: ${target.origin}`,
            path: ["steps", index, "action", "url"],
          });
        }
      }
    }
    if (navigationCount > plan.budgets.maxNavigations) {
      context.addIssue({
        code: "custom",
        message: "navigation count exceeds the plan navigation budget",
        path: ["budgets", "maxNavigations"],
      });
    }
  });

export const testPlanV2Schema = z
  .object({
    protocolVersion: z.literal("2"),
    name: z.string().trim().min(1).max(200),
    objective: nonEmptyText,
    preconditions: z.array(nonEmptyText).max(20).default([]),
    allowedOrigins: testPlanV1Schema.shape.allowedOrigins,
    budgets: budgetsSchema,
    steps: z.array(stepV2Schema).min(1).max(500),
  })
  .strict()
  .superRefine((plan, context) => validatePlanStructure(plan, context));

export const testPlanSchema = z.discriminatedUnion("protocolVersion", [
  testPlanV1Schema,
  testPlanV2Schema,
]);

function validatePlanStructure(
  plan: { allowedOrigins: string[]; budgets: z.infer<typeof budgetsSchema>; steps: Array<z.infer<typeof stepV2Schema>> },
  context: z.RefinementCtx,
) {
  if (plan.steps.length > plan.budgets.maxActions) {
    context.addIssue({ code: "custom", message: "step count exceeds the plan action budget", path: ["budgets", "maxActions"] });
  }
  const ids = new Set<string>();
  let navigationCount = 0;
  for (const [index, step] of plan.steps.entries()) {
    if (ids.has(step.id)) context.addIssue({ code: "custom", message: `duplicate step id: ${step.id}`, path: ["steps", index, "id"] });
    ids.add(step.id);
    if (step.action.type !== "navigate") continue;
    navigationCount += 1;
    try {
      const target = new URL(step.action.url, plan.allowedOrigins[0]);
      if (!plan.allowedOrigins.includes(target.origin)) {
        context.addIssue({ code: "custom", message: `navigation origin is not allowed: ${target.origin}`, path: ["steps", index, "action", "url"] });
      }
    } catch {
      context.addIssue({ code: "custom", message: "navigation URL is invalid", path: ["steps", index, "action", "url"] });
    }
  }
  if (navigationCount > plan.budgets.maxNavigations) {
    context.addIssue({ code: "custom", message: "navigation count exceeds the plan navigation budget", path: ["budgets", "maxNavigations"] });
  }
}

export type TestPlanV1 = z.infer<typeof testPlanV1Schema>;
export type TestPlanV2 = z.infer<typeof testPlanV2Schema>;
export type TestPlan = z.infer<typeof testPlanSchema>;
export type TestStep = z.infer<typeof stepSchema>;
export type TestStepV2 = z.infer<typeof stepV2Schema>;
export type PlanLocator = z.infer<typeof locatorSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
export type ReadinessCondition = z.infer<typeof readinessConditionSchema>;
