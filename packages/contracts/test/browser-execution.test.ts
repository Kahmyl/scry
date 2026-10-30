import { describe, expect, it } from "vitest";
import {
  browserCaptureReceiptSchema,
  browserCommitIntentSchema,
  browserEffectTruthSchema,
} from "../src/browser-execution.js";
import { browserCommandSchema } from "../src/browser-command.js";
import {
  bindBrowserProtectedInputsSchema,
  createBrowserProtectedInputSchema,
  createBrowserEnvironmentSchema,
  startBrowserMissionSchema,
  startBrowserRunSchema,
} from "../src/browser-lifecycle.js";

describe("browser execution baseline contracts", () => {
  it("represents content-aware response evidence and safe redirect provenance", () => {
    const receipt = browserCaptureReceiptSchema.parse({
      captureId: "00000000-0000-4000-8000-000000000010",
      runId: "00000000-0000-4000-8000-000000000011",
      effectId: "00000000-0000-4000-8000-000000000012",
      phase: "captured",
      status: 303,
      contentType: "text/html",
      contentClass: "http_text",
      bodyBytes: 0,
      redirectChain: [{ status: 303, sameOrigin: true, targetDigest: "a".repeat(64) }],
      capturedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2026-09-02T00:15:00.000Z",
      structuralIndex: [],
    });
    expect(receipt).toMatchObject({ contentClass: "http_text", bodyBytes: 0 });
    expect(
      browserCaptureReceiptSchema.parse({
        ...receipt,
        captureId: "00000000-0000-4000-8000-000000000013",
        contentType: "application/vnd.scry.dom+json",
        contentClass: "dom_region",
      }).contentClass,
    ).toBe("dom_region");
  });

  it("accepts a generic agent-declared commit intent", () => {
    expect(
      browserCommitIntentSchema.parse({
        runId: "00000000-0000-4000-8000-000000000001",
        browserSessionId: "00000000-0000-4000-8000-000000000002",
        ownerGeneration: 3,
        documentEpoch: 9,
        idempotencyKey: "fixture-create-001",
        authorization: "business",
        intentSummary: "Submit the visible create form once",
        expectedOrigin: "https://fixture.example",
        target: { frameId: "main", elementReference: "button-17" },
      }),
    ).toMatchObject({ authorization: "business", ownerGeneration: 3 });
  });

  it("rejects impossible public effect truth", () => {
    expect(() =>
      browserEffectTruthSchema.parse({
        dispatch: "not_started",
        capture: "not_started",
        publication: "not_started",
        outcome: "unknown",
      }),
    ).toThrow(/undispatched mutation is not unknown/);

    expect(() =>
      browserEffectTruthSchema.parse({
        dispatch: "acknowledged",
        capture: "not_started",
        publication: "published",
        outcome: "applied",
      }),
    ).toThrow(/settled output requires durable capture/);
  });

  it("accepts an operation-owned DOM result capture without raw extraction arguments", () => {
    expect(
      browserCommandSchema.parse({
        kind: "capture_dom",
        effectId: "00000000-0000-4000-8000-000000000003",
        reference: "00000000-0000-4000-8000-000000000004",
      }),
    ).toEqual({
      kind: "capture_dom",
      effectId: "00000000-0000-4000-8000-000000000003",
      reference: "00000000-0000-4000-8000-000000000004",
    });
  });

  it("accepts explicit irreversible settlement when a capture has no needed outputs", () => {
    expect(
      browserCommandSchema.parse({
        kind: "discard_capture",
        effectId: "00000000-0000-4000-8000-000000000003",
        captureId: "00000000-0000-4000-8000-000000000005",
      }),
    ).toMatchObject({ kind: "discard_capture" });
  });

  it("binds opaque user inputs when a Run starts without exposing their values", () => {
    const protectedValueId = "00000000-0000-4000-8000-000000000006";
    expect(
      startBrowserRunSchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        missionId: "00000000-0000-4000-8000-000000000002",
        objectiveId: "00000000-0000-4000-8000-000000000003",
        agentSessionId: "00000000-0000-4000-8000-000000000004",
        flowId: "00000000-0000-4000-8000-000000000005",
        flowRevisionId: "00000000-0000-4000-8000-000000000007",
        environmentId: "00000000-0000-4000-8000-000000000008",
        idempotencyKey: "protected-run-1",
        protectedInputIds: [protectedValueId],
      }).protectedInputIds,
    ).toEqual([protectedValueId]);
    expect(
      createBrowserProtectedInputSchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        displayName: "login_password",
        value: "secret-value",
        expiresInSeconds: 600,
        idempotencyKey: "protected-input-1",
      }).displayName,
    ).toBe("login_password");
  });

  it("requires explicit user confirmation when credentials are bound after Run start", () => {
    const protectedValueId = "00000000-0000-4000-8000-000000000006";
    expect(
      bindBrowserProtectedInputsSchema.parse({
        protectedInputIds: [protectedValueId],
        userConfirmed: true,
      }),
    ).toEqual({ protectedInputIds: [protectedValueId], userConfirmed: true });
    expect(() =>
      bindBrowserProtectedInputsSchema.parse({
        protectedInputIds: [protectedValueId],
        userConfirmed: false,
      }),
    ).toThrow();
    expect(
      createBrowserProtectedInputSchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        displayName: "Vitract test password",
        value: "secret-value",
        expiresInSeconds: null,
        idempotencyKey: "persistent-input-1",
      }).expiresInSeconds,
    ).toBeNull();
    expect(
      createBrowserProtectedInputSchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        displayName: "Ephemeral input",
        value: "secret-value",
        idempotencyKey: "ephemeral-input-1",
      }).expiresInSeconds,
    ).toBe(3_600);
  });

  it("binds an explicit generic disclosure mode to an environment", () => {
    const environment = createBrowserEnvironmentSchema.parse({
      projectId: "00000000-0000-4000-8000-000000000001",
      name: "fixture",
      baseOrigin: "https://fixture.example",
      allowedServiceOrigins: [],
      disclosureMode: "trusted_application_output",
      idempotencyKey: "environment-policy-1",
    });
    expect(environment).toMatchObject({
      disclosureMode: "trusted_application_output",
    });
    expect(environment).not.toHaveProperty("fieldPaths");
  });
});
