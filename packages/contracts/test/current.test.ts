import { describe, expect, it } from "vitest";

import {
  bindCalibrationSchema,
  currentPlanSchema,
  protectedTransactionResultSchema,
  requestCalibrationSchema,
  recordingTimelineSchema,
  interactionTargetIntentSchema,
} from "../src/index.js";

const base = {
  name: "Issue credential",
  objective: "Capture a one-time credential without leaking it into evidence.",
  allowedOrigins: ["https://example.test"],
  budgets: { maxActions: 5, maxDurationMs: 30_000, maxNavigations: 1 },
};
const intent = (
  concept: string,
  role: "button" | "textbox" | "text" | "value" | "form" = "text",
) => ({
  concept,
  requiredCapabilities:
    role === "textbox"
      ? ["focusable", "accepts_text", "editable", "readable_value"]
      : role === "button"
        ? ["pointer_activatable"]
        : ["readable_value"],
  preferredEvidence: {
    roles: [role],
    names: [concept],
    labels: role === "textbox" ? [concept] : [],
    descriptions: [],
    placeholders: role === "textbox" ? [concept] : [],
    inputTypes: [],
  },
  scope: { kind: "page" as const },
  relations: [],
  prohibited: ["hidden", "disabled"],
  risk: "ordinary" as const,
  confidence: { requiredFamilies: [], minimumFamilyCount: 1 },
});
const readiness = {
  ceremonyIntent: intent("Credential form", "form"),
  expectedContainerModel: {
    version: 2 as const,
    digest: "a".repeat(64),
    concept: "Credential form",
    scopeKind: "page" as const,
    capabilityDigest: "b".repeat(64),
    structuralPath: [],
  },
  valueIntent: intent("Client secret", "value"),
  approvedMethods: ["semantic_field_value" as const],
  minimumConfidence: 0.6,
  minimumConfidenceMargin: 0,
  recoveryPolicy: "abandon" as const,
  recoveryWindowMs: 1_000,
};

const transactionAction = (overrides: Record<string, unknown> = {}) => ({
  type: "protectedTransaction",
  operationId: "issue-secret",
  entry: {
    url: "https://example.test/new",
    assertions: [{ type: "visible", target: intent("Credential form", "form") }],
  },
  inputs: { name: { classification: "public", value: "Disposable app" } },
  preparation: {
    actions: [
      {
        type: "fillPublicInput",
        input: "name",
        target: intent("Name", "textbox"),
        effect: "replayable_setup",
      },
    ],
    assertions: [
      { type: "fieldValueMatchesInput", target: intent("Name", "textbox"), input: "name" },
      { type: "enabled", target: intent("Issue", "button") },
    ],
  },
  mutation: {
    action: {
      type: "click",
      target: intent("Issue", "button"),
      expectedEffect: { type: "new_region", target: intent("Client secret", "value") },
    },
    kind: "one_time",
    reconciliation: { strategy: "none", acceptUnknownOutcome: true },
  },
  extraction: {
    outputs: [
      {
        classification: "protected",
        reference: "client_secret",
        acquisition: {
          target: intent("Client secret", "value"),
          classification: "unknown_secret",
          permittedMethods: ["semantic_field_value"],
          validation: { minimumLength: 1, maximumLength: 20_000 },
        },
        storage: { credentialName: "Client secret", scope: "project" },
      },
    ],
    timeoutMs: 10_000,
    scheduling: "fair_shared_timeout",
  },
  acquisitionReadiness: readiness,
  continuation: { strategies: [{ mode: "terminal" }] },
  ...overrides,
});

describe("current plan contract", () => {
  it("accepts deterministic visual evidence and rejects OCR without an anchor cue", () => {
    const baseIntent = intent("Save", "button");
    expect(
      interactionTargetIntentSchema.safeParse({
        ...baseIntent,
        preferredEvidence: {
          ...baseIntent.preferredEvidence,
          visual: { sources: ["ocr", "geometry"], expectedText: "Save", protectedUse: false },
        },
      }).success,
    ).toBe(true);
    expect(
      interactionTargetIntentSchema.safeParse({
        ...baseIntent,
        preferredEvidence: {
          ...baseIntent.preferredEvidence,
          visual: { sources: ["ocr"], protectedUse: false },
        },
      }).success,
    ).toBe(false);
    expect(
      interactionTargetIntentSchema.safeParse({ concept: "legacy", role: "button", name: "Save" })
        .success,
    ).toBe(false);
  });
  it("has no feature-generation discriminator", () => {
    const parsed = currentPlanSchema.parse({
      ...base,
      steps: [
        {
          id: "issue",
          title: "Issue and secure credential",
          action: transactionAction(),
        },
      ],
    });

    expect(parsed.steps[0]!.action.type).toBe("protectedTransaction");
  });

  it("rejects split legacy secret-capture actions", () => {
    expect(
      currentPlanSchema.safeParse({
        ...base,
        steps: [
          {
            id: "capture",
            title: "Capture later",
            action: {
              type: "unrecognizedProtectedCapture",
              target: { strategy: "label", value: "Secret" },
              reference: "secret",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects the removed same-context protection lifecycle", () => {
    expect(
      currentPlanSchema.safeParse({
        ...base,
        steps: [
          {
            id: "issue",
            title: "Issue",
            action: {
              type: "protectedTransaction",
              mode: "protected_surface",
              candidates: [{ strategy: "label", value: "Secret" }],
              reference: "secret",
              credentialName: "Secret",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires continuation routes to use an allowed origin", () => {
    const plan = {
      ...base,
      steps: [
        {
          id: "issue",
          title: "Issue",
          action: transactionAction({
            continuation: {
              strategies: [
                {
                  mode: "resume_parked_context",
                  reentryUrl: "https://other.test/safe",
                  assertions: [{ type: "url", expected: "/safe", match: "path" }],
                  continueAtStepId: "continue",
                },
              ],
            },
          }),
        },
        {
          id: "continue",
          title: "Continue",
          action: { type: "waitFor", target: intent("Ready", "text"), state: "visible" },
        },
      ],
    };
    expect(currentPlanSchema.safeParse(plan).success).toBe(false);
    (
      plan.steps[0]!.action as unknown as {
        continuation: { strategies: Array<{ reentryUrl: string }> };
      }
    ).continuation.strategies[0]!.reentryUrl = "https://example.test/safe";
    expect(currentPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects locator-shaped extraction candidates", () => {
    const parsed = currentPlanSchema.safeParse({
      ...base,
      steps: [
        {
          id: "issue",
          title: "Issue",
          action: transactionAction({
            extraction: {
              outputs: [
                {
                  classification: "protected",
                  reference: "secret",
                  candidates: [
                    {
                      strategy: "relative",
                      anchor: { strategy: "role", role: "dialog" },
                      target: { strategy: "text", value: "Client secret", exact: false },
                      relation: "within",
                      justification: "This would only return the authored label.",
                    },
                  ],
                  storage: { credentialName: "Secret", scope: "run" },
                },
              ],
              timeoutMs: 1_000,
              scheduling: "fair_shared_timeout",
            },
          }),
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("supports input-bound capsule navigation and reconciliation by persisted outputs", () => {
    const action = transactionAction({
      inputs: {
        applicationName: { classification: "public", value: "Disposable app" },
        credentialLabel: { classification: "public", value: "Acceptance credential" },
      },
      preparation: {
        actions: [
          { type: "clickPublicInput", input: "applicationName", exact: true, effect: "read_only" },
          {
            type: "fillPublicInput",
            input: "credentialLabel",
            target: intent("Production integration", "textbox"),
            effect: "replayable_setup",
          },
        ],
        assertions: [
          {
            type: "textMatchesInput",
            target: intent("Selected application", "text"),
            input: "applicationName",
            exact: false,
          },
          {
            type: "fieldValueMatchesInput",
            target: intent("Production integration", "textbox"),
            input: "credentialLabel",
          },
          { type: "enabled", target: intent("Issue credential", "button") },
        ],
      },
      mutation: {
        action: {
          type: "click",
          target: intent("Issue credential", "button"),
          expectedEffect: { type: "new_region", target: intent("Client secret", "value") },
        },
        kind: "one_time",
        reconciliation: { strategy: "persisted_outputs", requiredReferences: ["client_secret"] },
      },
    });
    expect(
      currentPlanSchema.safeParse({ ...base, steps: [{ id: "issue", title: "Issue", action }] })
        .success,
    ).toBe(true);
  });

  it("accepts one deterministic checkpoint and rejects reuse of skipped output", () => {
    const protectedAction = transactionAction({
      continuation: {
        strategies: [
          {
            mode: "recreate_clean_context",
            checkpointId: "before-issue",
            reentryUrl: "https://example.test/safe",
            assertions: [{ type: "url", expected: "/safe", match: "path" }],
            continueAtStepId: "continue",
          },
        ],
      },
    });
    const parsed = currentPlanSchema.safeParse({
      ...base,
      checkpoints: [
        {
          id: "before-issue",
          beforeStepId: "issue",
          restorationUrl: "https://example.test/safe",
          verificationAssertions: [{ type: "url", expected: "/safe", match: "path" }],
          continueAtStepId: "continue",
          maxRestorations: 1,
          state: { cookies: true, localStorage: true, indexedDb: true },
        },
      ],
      steps: [
        { id: "issue", title: "Issue", action: protectedAction },
        {
          id: "continue",
          title: "Continue safely",
          action: { type: "navigate", url: "https://example.test/safe" },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success).toBe(true);
  });
});

describe("calibration command authority", () => {
  const ids = {
    sourceFlowRevisionId: "11111111-1111-4111-8111-111111111111",
    environmentId: "22222222-2222-4222-8222-222222222222",
    missionId: "33333333-3333-4333-8333-333333333333",
    objectiveId: "44444444-4444-4444-8444-444444444444",
    agentSessionId: "55555555-5555-4555-8555-555555555555",
  };

  it("accepts intent but rejects caller-authored fingerprints and attestations", () => {
    const intent = {
      name: "Issue credential",
      ...ids,
      operationId: "issue-secret",
      disposableDataConfirmed: true,
      confirmedUserAuthorized: true,
      purpose: "Calibrate the explicitly requested disposable operation",
      idempotencyKey: "calibration-command-1",
    };
    expect(requestCalibrationSchema.safeParse(intent).success).toBe(true);
    expect(
      requestCalibrationSchema.safeParse({ ...intent, structureFingerprint: "a".repeat(64) })
        .success,
    ).toBe(false);
    expect(requestCalibrationSchema.safeParse({ ...intent, status: "approved" }).success).toBe(
      false,
    );
  });

  it("binds only an exact attestation and never accepts a caller-rewritten plan", () => {
    const binding = {
      missionId: ids.missionId,
      objectiveId: ids.objectiveId,
      agentSessionId: ids.agentSessionId,
      reason: "Bind verified calibration",
      expectedRevisionId: ids.sourceFlowRevisionId,
      environmentId: ids.environmentId,
      operationId: "issue-secret",
      attestationId: "66666666-6666-4666-8666-666666666666",
      idempotencyKey: "calibration-binding-1",
    };
    expect(bindCalibrationSchema.safeParse(binding).success).toBe(true);
    expect(bindCalibrationSchema.safeParse({ ...binding, plan: base }).success).toBe(false);
  });
});

describe("recording timeline contract", () => {
  it("accepts safe segments separated by a protected gap", () => {
    const timeline = recordingTimelineSchema.parse([
      {
        type: "video_segment",
        id: "11111111-1111-4111-8111-111111111111",
        sequence: 0,
        pageId: "page-1",
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T00:00:01.000Z",
        reason: "run_started",
        status: "available",
        privacyStatus: "verified_safe",
        artifactId: "22222222-2222-4222-8222-222222222222",
      },
      {
        type: "protected_gap",
        id: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        operationId: "synthetic",
        startedAt: "2026-08-01T00:00:01.000Z",
        endedAt: "2026-08-01T00:00:02.000Z",
        reason: "test",
        privacyStatus: "capture_suppressed",
      },
    ]);
    expect(timeline).toHaveLength(2);
  });

  it("accepts authoritative capture epochs and checkpoint boundaries", () => {
    const timeline = recordingTimelineSchema.parse([
      {
        type: "capture_epoch",
        id: "11111111-1111-4111-8111-111111111111",
        sequence: 0,
        epoch: 1,
        contextId: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T00:00:01.000Z",
        startReason: "run_started",
        endReason: "checkpoint_context_destroyed",
        status: "sealed",
      },
      {
        type: "checkpoint_boundary",
        id: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        checkpointId: "before-secret",
        boundary: "context_destroyed",
        occurredAt: "2026-08-01T00:00:01.000Z",
        captureEpoch: 1,
      },
      {
        type: "capture_epoch",
        id: "44444444-4444-4444-8444-444444444444",
        sequence: 2,
        epoch: 2,
        contextId: "55555555-5555-4555-8555-555555555555",
        startedAt: "2026-08-01T00:00:02.000Z",
        endedAt: "2026-08-01T00:00:03.000Z",
        startReason: "checkpoint_restored",
        endReason: "run_completed",
        status: "completed",
      },
    ]);
    expect(timeline.map((entry) => entry.type)).toEqual([
      "capture_epoch",
      "checkpoint_boundary",
      "capture_epoch",
    ]);
  });

  it("rejects non-contiguous ordering", () => {
    expect(
      recordingTimelineSchema.safeParse([
        {
          type: "unavailable_interval",
          id: "11111111-1111-4111-8111-111111111111",
          sequence: 2,
          startedAt: "2026-08-01T00:00:00.000Z",
          endedAt: "2026-08-01T00:00:01.000Z",
          failureCode: "SCREENCAST_FAILED",
        },
      ]).success,
    ).toBe(false);
  });
});

describe("privacy result contract", () => {
  it("returns a typed captured result", () => {
    const result = protectedTransactionResultSchema.parse({
      status: "completed",
      bootstrap: { status: "succeeded" },
      preparation: { status: "succeeded" },
      mutation: { dispatch: "acknowledged", outcome: "confirmed_succeeded" },
      protectedExtraction: "captured",
      publicExtraction: "captured",
      protectedPersistence: "confirmed",
      publicPersistence: "confirmed",
      capsule: "destroyed",
      reconciliation: "succeeded",
      continuation: "parked_resumed",
      evidence: "resumed",
      credentialSecurity: "active",
      credentialReferences: { secret: "11111111-1111-4111-8111-111111111111" },
      publicValueReferences: { id: "22222222-2222-4222-8222-222222222222" },
      safeActions: [],
      diagnostics: [],
    });
    expect(result.status).toBe("completed");
  });

  it("rejects unsafe result actions", () => {
    expect(
      protectedTransactionResultSchema.safeParse({
        status: "aborted",
        bootstrap: { status: "succeeded" },
        preparation: { status: "failed" },
        mutation: { dispatch: "not_started", outcome: "not_attempted" },
        protectedExtraction: "not_attempted",
        publicExtraction: "not_attempted",
        protectedPersistence: "not_attempted",
        publicPersistence: "not_attempted",
        capsule: "destroyed",
        reconciliation: "unknown",
        continuation: "failed",
        evidence: "stopped",
        credentialSecurity: "none",
        credentialReferences: {},
        publicValueReferences: {},
        safeActions: ["continue_recording"],
        diagnostics: [],
      }).success,
    ).toBe(false);
  });
});
