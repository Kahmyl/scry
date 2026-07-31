import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  analyzePlanRisks,
  executionPolicyV1Schema,
  readinessConditionSchema,
  testPlanSchema,
  testPlanV1Schema,
  testPlanV2Schema,
  validatePlanAgainstPolicy,
} from "../src/index.js";

const validPlan = {
  protocolVersion: "1",
  name: "Signup validation",
  objective: "Verify that a user can create an account.",
  preconditions: ["The staging application is available."],
  allowedOrigins: ["https://staging.example.com"],
  budgets: { maxActions: 20, maxDurationMs: 60_000, maxNavigations: 3 },
  steps: [
    {
      id: "open-signup",
      title: "Open signup",
      action: { type: "navigate", url: "/signup" },
      assertions: [
        {
          type: "visible",
          target: { strategy: "role", role: "heading", name: "Create account" },
        },
      ],
    },
  ],
};

describe("protocol v1", () => {
  it("parses the checked-in valid example", () => {
    const path = fileURLToPath(
      new URL("../../../examples/plans/signup.valid.json", import.meta.url),
    );
    expect(testPlanV1Schema.parse(JSON.parse(readFileSync(path, "utf8"))).protocolVersion).toBe(
      "1",
    );
  });

  it("accepts a deterministic same-origin plan", () => {
    expect(testPlanV1Schema.parse(validPlan).steps).toHaveLength(1);
  });

  it("rejects cross-origin navigation", () => {
    const candidate = structuredClone(validPlan);
    candidate.steps[0]!.action.url = "https://attacker.example/collect";
    expect(testPlanV1Schema.safeParse(candidate).success).toBe(false);
  });

  it("rejects unknown arbitrary-code actions", () => {
    const candidate = structuredClone(validPlan) as unknown as Record<string, unknown>;
    const steps = candidate.steps as Array<Record<string, unknown>>;
    steps[0]!.action = { type: "evaluate", script: "process.env" };
    expect(testPlanV1Schema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a named credential reference instead of a credential UUID", () => {
    const candidate = structuredClone(validPlan) as unknown as Record<string, unknown>;
    const steps = candidate.steps as Array<Record<string, unknown>>;
    steps.push({
      id: "email",
      title: "Enter email",
      action: {
        type: "fill",
        target: { strategy: "placeholder", value: "Email" },
        secretRef: "vitract_email",
      },
    });
    expect(testPlanV1Schema.safeParse(candidate).success).toBe(false);
  });

  it("defaults label and placeholder locators to partial matching", () => {
    const candidate = structuredClone(validPlan) as unknown as Record<string, unknown>;
    const steps = candidate.steps as Array<Record<string, unknown>>;
    steps.push({
      id: "email",
      title: "Enter email",
      action: {
        type: "fill",
        target: { strategy: "placeholder", value: "Email" },
        value: "safe@example.test",
      },
    });
    const parsed = testPlanV1Schema.parse(candidate);
    const action = parsed.steps[1]!.action;
    expect(action.type === "fill" && action.target.strategy === "placeholder" && action.target.exact)
      .toBe(false);
  });

  it("rejects duplicate step identifiers", () => {
    const candidate = structuredClone(validPlan) as typeof validPlan & {
      steps: Array<(typeof validPlan.steps)[number]>;
    };
    candidate.steps.push(structuredClone(candidate.steps[0]!));
    expect(testPlanV1Schema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a valid plan when project policy is narrower", () => {
    const plan = testPlanV1Schema.parse(validPlan);
    const policy = executionPolicyV1Schema.parse({
      policyVersion: "1",
      allowedOrigins: ["https://different.example.com"],
      maxActions: 10,
      maxDurationMs: 30_000,
      maxNavigations: 1,
    });
    expect(validatePlanAgainstPolicy(plan, policy).map((item) => item.code)).toEqual([
      "ORIGIN_NOT_ALLOWED",
      "ACTION_BUDGET_EXCEEDED",
      "DURATION_BUDGET_EXCEEDED",
      "NAVIGATION_BUDGET_EXCEEDED",
    ]);
  });
});

describe("protocol v2 observation readiness", () => {
  const validPlanV2 = {
    ...validPlan,
    protocolVersion: "2",
    steps: [
      {
        ...validPlan.steps[0],
        after: {
          mode: "all",
          timeoutMs: 15_000,
          conditions: [
            {
              type: "visible",
              target: { strategy: "role", role: "heading", name: "Create account" },
            },
          ],
        },
        assertions: [],
        evidence: ["screenshot"],
        captureIntent: "final",
      },
    ],
  } as const;

  it("authors v2 while continuing to read v1", () => {
    expect(testPlanV2Schema.parse(validPlanV2).protocolVersion).toBe("2");
    expect(testPlanSchema.parse(validPlan).protocolVersion).toBe("1");
  });

  it.each([
    { type: "visible", target: { strategy: "text", value: "Ready" } },
    { type: "hidden", target: { strategy: "text", value: "Loading" } },
    { type: "text", target: { strategy: "text", value: "Status" }, expected: "Ready" },
    { type: "value", target: { strategy: "label", value: "Email" }, expected: "a@b.test" },
    { type: "checked", target: { strategy: "label", value: "Accept" }, expected: true },
    { type: "url", expected: "/dashboard" },
    { type: "content", target: { strategy: "css", value: "#root", justification: "Application mount point" }, minimumChildren: 1 },
    { type: "request", urlPattern: "/api/orders", method: "GET", status: { min: 200, max: 299 } },
    { type: "domStable", quietWindowMs: 500 },
    { type: "networkQuiet", quietWindowMs: 500 },
    { type: "delay", durationMs: 250 },
  ])("accepts readiness condition $type", (condition) => {
    expect(readinessConditionSchema.safeParse(condition).success).toBe(true);
  });

  it("blocks reaction-to-final-evidence without readiness", () => {
    const plan = testPlanV2Schema.parse({
      ...validPlanV2,
      steps: [{
        id: "click",
        title: "Open results",
        action: { type: "click", target: { strategy: "role", role: "button", name: "Open" } },
        assertions: [],
        evidence: ["screenshot"],
        captureIntent: "final",
      }],
    });
    expect(analyzePlanRisks(plan).errors.map((item) => item.code)).toContain(
      "FINAL_EVIDENCE_WITHOUT_READINESS",
    );
  });

  it("permits intentional transient evidence but prevents it from proving correctness", () => {
    const plan = testPlanV2Schema.parse({
      ...validPlanV2,
      steps: [{
        id: "capture-loading",
        title: "Capture loading state",
        action: { type: "click", target: { strategy: "role", role: "button", name: "Open" } },
        assertions: [{ type: "visible", target: { strategy: "text", value: "Ready" } }],
        evidence: ["screenshot"],
        captureIntent: "transient",
        transientJustification: "Document the intended loading treatment.",
      }],
    });
    expect(analyzePlanRisks(plan).errors.map((item) => item.code)).toContain(
      "TRANSIENT_CAPTURE_USED_AS_PROOF",
    );
  });

  it("supports protected capture and same-run secret reuse without literal values", () => {
    const plan = testPlanV2Schema.parse({
      ...validPlanV2,
      steps: [
        {
          id: "capture-generated-secret",
          title: "Protect generated API secret",
          action: {
            type: "captureSecret",
            target: { strategy: "label", value: "Client secret" },
            reference: "generated_api_secret",
            credentialName: "Generated API secret",
          },
        },
        {
          id: "reuse-generated-secret",
          title: "Authenticate API console",
          action: {
            type: "fill",
            target: { strategy: "label", value: "API secret" },
            capturedSecretRef: "generated_api_secret",
          },
        },
      ],
    });
    expect(plan.steps[0]!.action.type).toBe("captureSecret");
    expect(JSON.stringify(plan)).not.toContain("actual-secret-value");
  });

  it("allows visually redacted screenshot evidence in generated-secret capture runs", () => {
    const plan = testPlanV2Schema.parse({
      ...validPlanV2,
      steps: [{
        id: "capture-generated-secret",
        title: "Protect generated API secret",
        action: {
          type: "captureSecret",
          target: { strategy: "label", value: "Client secret" },
          reference: "generated_api_secret",
          credentialName: "Generated API secret",
        },
        evidence: ["screenshot"],
      }],
    });
    expect(analyzePlanRisks(plan).errors.map((item) => item.code)).not.toContain("SECRET_CAPTURE_SCREENSHOT_RISK");
  });

  it("allows visually redacted screenshot evidence when a stored protected value is filled", () => {
    const plan = testPlanV2Schema.parse({
      ...validPlanV2,
      steps: [{
        id: "enter-protected-value",
        title: "Enter protected API secret",
        action: {
          type: "fill",
          target: { strategy: "label", value: "API secret" },
          secretRef: "11111111-1111-4111-8111-111111111111",
        },
        evidence: ["screenshot"],
      }],
    });
    expect(analyzePlanRisks(plan).errors.map((item) => item.code)).not.toContain("SECRET_CAPTURE_SCREENSHOT_RISK");
  });

  it("requires generated-secret capture to immediately follow its reveal action", () => {
    const plan = testPlanV2Schema.parse({
      ...validPlanV2,
      steps: [
        validPlanV2.steps[0]!,
        {
          id: "intervening-observation",
          title: "Observe unrelated content",
          action: { type: "waitFor", target: { strategy: "text", value: "Credential created" }, state: "visible" },
        },
        {
          id: "capture-generated-secret",
          title: "Protect generated API secret",
          action: { type: "captureSecret", target: { strategy: "label", value: "Client secret" }, reference: "api_secret", credentialName: "API secret" },
        },
      ],
    });
    expect(analyzePlanRisks(plan).errors.map((item) => item.code)).toContain(
      "SECRET_CAPTURE_WITHOUT_PROTECTED_BOUNDARY",
    );
  });
});
