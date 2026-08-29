import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { NativeControlResolutionError } from "@scry/executor";
import { GroundingError } from "@scry/praxis";
import { errors as playwrightErrors } from "playwright";
import {
  analyzeDescriptors,
  credentialRouteMatches,
  descriptorFromAccessibilitySnapshot,
  emptyNativePraxisTelemetry,
  emptyTelemetry,
  formatEmailGroundingDiagnostics,
  formatObservationOutput,
  loginGroundingUnavailable,
  resolveNativeThenPraxis,
  safeFailureCode,
  safeGroundingDiagnostic,
  settleVisibleRevokeCandidates,
  runPreparation,
} from "../scripts/vitract-revoke-target-rehearsal.js";

const refs = ["045970aa-9210-47e7-bafa-18ce4da5089c", "6547b053-f2b8-420c-91c0-bb4e1c7ae2a6"];
const preparedId = "11111111-1111-4111-8111-111111111111";
const authority = {
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  clientIdReference: "44444444-4444-4444-8444-444444444444",
  clientSecretReference: "55555555-5555-4555-8555-555555555555",
  originProtectedOperationId: "66666666-6666-4666-8666-666666666666",
};
const productionPolicy = {
  allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
  trustedScriptOrigins: ["https://maps.googleapis.com", "https://js.stripe.com"],
  allowPrivateNetwork: false,
  allowDownloads: false as const,
  allowPopups: false as const,
  maxActions: 100,
  maxDurationMs: 120_000,
  maxNavigations: 10,
};
function dependencies(overrides: Partial<Parameters<typeof runPreparation>[0]> = {}) {
  return {
    authority,
    loadEnvironmentPolicy: vi.fn(async () => productionPolicy),
    create: vi.fn(
      async ({
        initialProtectedReferenceIds,
      }: {
        initialProtectedReferenceIds: string[];
        allowedOrigins: string[];
      }) => {
        if (initialProtectedReferenceIds.length !== 2)
          throw coded("MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED");
        return { id: preparedId, replayed: false };
      },
    ),
    resolvePreparedSession: vi.fn(async (id: string) => ({
      id,
      state: "active",
      projectId: authority.projectId,
      environmentId: authority.environmentId,
      missionId: "8c0a9e3a-56a7-4286-a331-1e73c0129533",
      objectiveId: "e5c0f365-d373-4375-9005-38a16bce770c",
      flowDraftId: "e5d6971e-320e-4c61-83dc-b3c7c2839ce7",
      agentSessionId: "925f7e55-1562-411a-8a62-c7b0434fe36c",
      idempotencyKey: "vitract-revoke-target-rehearsal-v3-production-policy-preparation",
      correlationId: "23dff597-c0d7-4ba7-94b5-959c04daa17b",
      protectedAllowlist: refs,
    })),
    loadRuntimePolicy: vi.fn(async () => productionPolicy),
    admit: vi.fn(async () => undefined),
    resolve: vi.fn(async (_session, reference) => `secret-${reference}`),
    revalidateTargetPair: vi.fn(async () => undefined),
    launchBrowser: vi.fn(async () => undefined),
    ...overrides,
  };
}
function coded(code: string) {
  return { response: { code } };
}

describe("Vitract revoke-target rehearsal preparation", () => {
  it("creates a session with both initial protected references", async () => {
    const deps = dependencies();
    const result = await runPreparation(deps, { mode: "prepare" });
    expect(result.sessionId).toBeTruthy();
    expect(deps.create).toHaveBeenCalledWith({
      initialProtectedReferenceIds: refs,
      allowedOrigins: productionPolicy.allowedOrigins,
    });
  });
  it("models repeated preparation as replay of the same v3 identity without browser", async () => {
    const create = vi.fn(async () => ({ id: preparedId, replayed: true }));
    const deps = dependencies({ create });
    const result = await runPreparation(deps, { mode: "prepare" });
    expect(result).toMatchObject({
      sessionId: preparedId,
      preparationDisposition: "replayed",
      safeCode: "PREPARATION_COMPLETE",
      browserLaunchAttempted: false,
    });
    expect(deps.resolvePreparedSession).toHaveBeenCalledWith(preparedId);
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it("accepts the exact protected allowlist in either order", async () => {
    for (const protectedAllowlist of [refs, [...refs].reverse()]) {
      const baseline = await dependencies().resolvePreparedSession!(preparedId);
      const deps = dependencies({
        resolvePreparedSession: vi.fn(async () => ({ ...baseline, protectedAllowlist })),
      });
      const result = await runPreparation(deps, { mode: "prepare" });
      expect(result.safeCode).toBe("PREPARATION_COMPLETE");
      expect(deps.launchBrowser).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["extra", [...refs, "33333333-3333-4333-8333-333333333333"]],
    ["duplicate email", [refs[0]!, refs[0]!, refs[1]!]],
    ["duplicate password", [refs[0]!, refs[1]!, refs[1]!]],
    ["missing email", [refs[1]!]],
    ["missing password", [refs[0]!]],
    ["empty", []],
    ["replacement", [refs[0]!, "33333333-3333-4333-8333-333333333333"]],
  ] as const)(
    "rejects %s protected allowlist before browser",
    async (_label, protectedAllowlist) => {
      const baseline = await dependencies().resolvePreparedSession!(preparedId);
      const deps = dependencies({
        resolvePreparedSession: vi.fn(async () => ({
          ...baseline,
          protectedAllowlist: [...protectedAllowlist],
        })),
      });
      const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
      expect(result.safeCode).toBe("REHEARSAL_PREPARED_SESSION_MISMATCH");
      expect(deps.launchBrowser).not.toHaveBeenCalled();
    },
  );
  it.each(["wrong correlation", "extra allowlist"])(
    "rejects replayed preparation with %s",
    async (kind) => {
      const baseline = await dependencies().resolvePreparedSession!(preparedId);
      const persisted =
        kind === "wrong correlation"
          ? { ...baseline, correlationId: "wrong" }
          : { ...baseline, protectedAllowlist: [...refs, "33333333-3333-4333-8333-333333333333"] };
      const deps = dependencies({
        create: vi.fn(async () => ({ id: preparedId, replayed: true })),
        resolvePreparedSession: vi.fn(async () => persisted),
      });
      const result = await runPreparation(deps, { mode: "prepare" });
      expect(result.safeCode).toBe("REHEARSAL_PREPARED_SESSION_MISMATCH");
      expect(deps.resolvePreparedSession).toHaveBeenCalledWith(preparedId);
      expect(deps.launchBrowser).not.toHaveBeenCalled();
    },
  );
  it("passes the production-derived runtime policy to the live continuation", async () => {
    const runLive = vi.fn(async () => undefined);
    const deps = dependencies({ runLive });
    const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
    expect(result.safeCode).toBe("LIVE_INSPECTION_COMPLETE");
    expect(runLive).toHaveBeenCalledWith(expect.objectContaining({ policy: productionPolicy }));
  });
  it.each(["environment", "runtime"])(
    "fails closed before browser when %s policy is unavailable",
    async (kind) => {
      const failure = coded(
        kind === "environment"
          ? "REHEARSAL_ENVIRONMENT_POLICY_UNAVAILABLE"
          : "REHEARSAL_RUNTIME_POLICY_UNAVAILABLE",
      );
      const deps = dependencies(
        kind === "environment"
          ? {
              loadEnvironmentPolicy: vi.fn(async () => {
                throw failure;
              }),
            }
          : {
              loadRuntimePolicy: vi.fn(async () => {
                throw failure;
              }),
            },
      );
      const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
      expect(result.safeCode).toBe(
        kind === "environment"
          ? "REHEARSAL_ENVIRONMENT_POLICY_UNAVAILABLE"
          : "REHEARSAL_RUNTIME_POLICY_UNAVAILABLE",
      );
      expect(deps.launchBrowser).not.toHaveBeenCalled();
    },
  );
  it("fails closed when a replayed session narrows the environment policy", async () => {
    const deps = dependencies({
      loadRuntimePolicy: vi.fn(async () => ({
        ...productionPolicy,
        allowedOrigins: [productionPolicy.allowedOrigins[0]!],
      })),
    });
    const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
    expect(result.safeCode).toBe("REHEARSAL_RUNTIME_POLICY_MISMATCH");
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it("does not emit policy origins or provider values in rehearsal telemetry", async () => {
    const canary = "https://private-policy-canary.invalid";
    const result = await runPreparation(
      dependencies({
        loadRuntimePolicy: vi.fn(async () => ({
          ...productionPolicy,
          trustedScriptOrigins: [canary],
        })),
      }),
      { mode: "prepare" },
    );
    expect(JSON.stringify(result)).not.toContain(canary);
  });
  it("fails before browser when initial references are missing", async () => {
    const deps = dependencies();
    const result = await runPreparation(deps, {
      mode: "prepare",
      initialProtectedReferenceIds: [],
    });
    expect(result.safeCode).toBe("MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED");
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it.each(["ADAPTIVE_CREDENTIAL_INACTIVE", "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED"])(
    "fails before browser for rejected reference: %s",
    async (code) => {
      const deps = dependencies({
        create: vi.fn(async () => {
          throw coded(code);
        }),
      });
      const result = await runPreparation(deps, { mode: "prepare" });
      expect(result.safeCode).toBe(code);
      expect(deps.launchBrowser).not.toHaveBeenCalled();
    },
  );
  it("preserves credential resolution failure stage and code", async () => {
    const deps = dependencies({
      resolve: vi.fn(async () => {
        throw coded("ADAPTIVE_CREDENTIAL_UNAVAILABLE");
      }),
    });
    const result = await runPreparation(deps, { mode: "prepare" });
    expect(result.safeCode).toBe("ADAPTIVE_CREDENTIAL_UNAVAILABLE");
    expect(result.telemetry.EMAIL_REFERENCE_RESOLUTION).toEqual({
      status: "failed",
      code: "ADAPTIVE_CREDENTIAL_UNAVAILABLE",
    });
  });
  it("successful local resolution stops before browser launch", async () => {
    const deps = dependencies();
    const result = await runPreparation(deps, { mode: "prepare" });
    expect(result.safeCode).toBe("PREPARATION_COMPLETE");
    expect(result.telemetry.BROWSER_LAUNCH.status).toBe("not_started");
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it("never collapses a typed failure to AUTHENTICATION_UNAVAILABLE", async () => {
    const result = await runPreparation(
      dependencies({
        admit: vi.fn(async () => {
          throw new Error("admission broke");
        }),
      }),
      { mode: "prepare" },
    );
    expect(result.safeCode).toBe("REHEARSAL_REFERENCE_ADMISSION_FAILED");
    expect(JSON.stringify(result)).not.toContain("AUTHENTICATION_UNAVAILABLE");
  });
  it("preserves direct Praxis-style error codes", () => {
    expect(safeFailureCode("EMAIL_GROUNDING", { code: "CONTROL_INVENTORY_EMPTY" })).toBe(
      "CONTROL_INVENTORY_EMPTY",
    );
    expect(safeFailureCode("EMAIL_GROUNDING", { code: "TARGET_AMBIGUOUS" })).toBe(
      "TARGET_AMBIGUOUS",
    );
  });
  it("preserves response codes and falls back for unknown exceptions", () => {
    expect(safeFailureCode("EMAIL_GROUNDING", coded("PRAXIS_ORIGIN_NOT_ALLOWED"))).toBe(
      "PRAXIS_ORIGIN_NOT_ALLOWED",
    );
    expect(safeFailureCode("EMAIL_GROUNDING", new Error("opaque"))).toBe(
      "REHEARSAL_EMAIL_GROUNDING_FAILED",
    );
  });
  it("serializes only sanctioned grounding diagnostics", () => {
    const canary = "secret-canary-value";
    const safe = safeGroundingDiagnostic({
      diagnostic: {
        candidateCount: 2,
        eligibleCount: 1,
        confidence: 0.8,
        confidenceMargin: 0.2,
        rejectedConstraints: ["capability:editable", canary],
        scope: { kind: "page", name: canary },
        observation: { status: "succeeded" },
        candidateDistinctions: [{ label: canary }],
      },
    });
    expect(safe).toMatchObject({ candidateCount: 2, eligibleCount: 1, scopeKind: "page" });
    expect(JSON.stringify(safe)).not.toContain(canary);
  });
  it("email grounding failure is neither authentication success nor provider rejection", async () => {
    const result = await runPreparation(
      dependencies({
        runLive: vi.fn(async ({ stage }) => {
          await stage("EMAIL_GROUNDING", async () => {
            throw {
              code: "CONTROL_INVENTORY_EMPTY",
              diagnostic: {
                candidateCount: 0,
                eligibleCount: 0,
                confidence: 0,
                confidenceMargin: 0,
                rejectedConstraints: [],
                scope: { kind: "page" },
                observation: { status: "succeeded" },
              },
            };
          });
        }),
      }),
      { mode: "live", preparedSessionId: preparedId },
    );
    expect(result.safeCode).toBe("CONTROL_INVENTORY_EMPTY");
    expect(result.telemetry.LOGIN_DISPATCH.status).toBe("not_started");
    expect(
      formatObservationOutput({
        result: "LOGIN_TARGET_UNAVAILABLE",
        providerRejectedCredentials: "not_proven",
      }),
    ).toEqual(
      expect.arrayContaining([
        "result: LOGIN_TARGET_UNAVAILABLE",
        "providerRejectedCredentials: not_proven",
      ]),
    );
  });
  it("native success resolves without Praxis fallback", async () => {
    const praxis = vi.fn(async () => "praxis");
    const telemetry = emptyNativePraxisTelemetry();
    expect(await resolveNativeThenPraxis(async () => "native", praxis, telemetry)).toBe("native");
    expect(praxis).not.toHaveBeenCalled();
    expect(telemetry).toEqual({
      nativeAttempted: "yes",
      nativeSucceeded: "yes",
      nativeFailureCode: "unavailable",
      praxisFallbackAttempted: "no",
      praxisSucceeded: "no",
      praxisFailureCode: "unavailable",
    });
  });
  it.each(["NATIVE_TARGET_NOT_FOUND", "NATIVE_TARGET_AMBIGUOUS", "NATIVE_SCOPE_UNSAFE"])(
    "%s records native failure and Praxis fallback",
    async (code) => {
      const praxis = vi.fn(async () => "praxis");
      const telemetry = emptyNativePraxisTelemetry();
      expect(
        await resolveNativeThenPraxis(
          async () => {
            throw new NativeControlResolutionError(code);
          },
          praxis,
          telemetry,
        ),
      ).toBe("praxis");
      expect(telemetry).toEqual({
        nativeAttempted: "yes",
        nativeSucceeded: "no",
        nativeFailureCode: code,
        praxisFallbackAttempted: "yes",
        praxisSucceeded: "yes",
        praxisFailureCode: "unavailable",
      });
    },
  );
  it("unrelated native resolution code propagates without Praxis", async () => {
    const praxis = vi.fn(async () => "praxis");
    const failure = new NativeControlResolutionError("NATIVE_DRIVER_CORRUPT");
    await expect(
      resolveNativeThenPraxis(async () => {
        throw failure;
      }, praxis),
    ).rejects.toBe(failure);
    expect(praxis).not.toHaveBeenCalled();
  });
  it("unrelated ordinary error propagates without Praxis", async () => {
    const praxis = vi.fn(async () => "praxis");
    const failure = new Error("UNRELATED_RUNTIME_FAILURE");
    await expect(
      resolveNativeThenPraxis(async () => {
        throw failure;
      }, praxis),
    ).rejects.toBe(failure);
    expect(praxis).not.toHaveBeenCalled();
  });
  it("terminal Praxis error preserves its production code after native miss", async () => {
    const telemetry = emptyNativePraxisTelemetry();
    await expect(
      resolveNativeThenPraxis(
        async () => {
          throw new NativeControlResolutionError("NATIVE_TARGET_NOT_FOUND");
        },
        async () => {
          throw { code: "NO_CAPABILITY_COMPATIBLE_CONTROL" };
        },
        telemetry,
      ),
    ).rejects.toMatchObject({ code: "NO_CAPABILITY_COMPATIBLE_CONTROL" });
    expect(telemetry.praxisFailureCode).toBe("NO_CAPABILITY_COMPATIBLE_CONTROL");
  });
  it("reads only the production rejected-capability diagnostic field", () => {
    const canary = "PRIVATE-CANDIDATE-CANARY";
    const safe = safeGroundingDiagnostic({
      diagnostic: {
        candidateCount: 1,
        eligibleCount: 0,
        confidence: 0,
        confidenceMargin: 0,
        rejectedConstraints: ["hidden"],
        scope: { kind: "page" },
        observation: { status: "succeeded" },
        rejectedCapabilitySignatures: [
          {
            count: 1,
            nativeKindClass: "input",
            computedRoleClass: "textbox",
            visible: "no",
            enabled: "yes",
            readonly: "no",
            acceptsText: "yes",
            focusable: "yes",
            editable: "yes",
            rawCanary: canary,
          },
        ],
      },
      candidates: [{ meta: { name: canary, capabilities: { nativeKind: "provider-raw-kind" } } }],
    });
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toMatch(/selector|fingerprint|bounds|runtimeId|candidateIndex|"index"/i);
    expect(safe?.rejectedCapabilitySignatures).toEqual([
      expect.objectContaining({ nativeKindClass: "input", visible: "no" }),
    ]);
  });
  it("consumes the real GroundingError diagnostic while candidates remain empty", () => {
    const diagnostic = {
      candidateCount: 2,
      eligibleCount: 0,
      confidence: 0,
      confidenceMargin: 0,
      scope: { kind: "page" },
      rejectedConstraints: ["accepts_text", "editable"],
      rejectedCapabilitySignatures: [
        {
          count: 2,
          nativeKindClass: "input",
          computedRoleClass: "textbox",
          visible: "no",
          enabled: "yes",
          readonly: "no",
          acceptsText: "yes",
          focusable: "yes",
          editable: "yes",
        },
      ],
      drift: "unchanged",
      safeActions: ["revise_intent", "narrow_scope"],
      resolutionSource: "unified",
      visualCandidateCount: 0,
      escalationLevel: 0,
      observation: { status: "succeeded" },
    } as ConstructorParameters<typeof GroundingError>[1];
    // This is the exact constructor arity used by resolveTarget's
    // NO_CAPABILITY_COMPATIBLE_CONTROL reject call: no candidates argument.
    const error = new GroundingError(
      "NO_CAPABILITY_COMPATIBLE_CONTROL",
      diagnostic,
      "safe-intent-digest",
    );
    const safe = safeGroundingDiagnostic(error);
    expect(error.candidates).toEqual([]);
    expect(safe?.rejectedCapabilitySignatures).toEqual(diagnostic.rejectedCapabilitySignatures);
    expect(safe?.rejectedCapabilitySignatures.reduce((total, item) => total + item.count, 0)).toBe(
      safe?.candidateCount,
    );
    expect(safe?.candidateCount).toBe(2);
  });
  it("formats the complete privacy-safe EMAIL grounding characterization", () => {
    const telemetry = emptyTelemetry();
    telemetry.EMAIL_GROUNDING = {
      status: "failed",
      code: "NO_CAPABILITY_COMPATIBLE_CONTROL",
      resolution: {
        nativeAttempted: "yes",
        nativeSucceeded: "no",
        nativeFailureCode: "NATIVE_TARGET_NOT_FOUND",
        praxisFallbackAttempted: "yes",
        praxisSucceeded: "no",
        praxisFailureCode: "NO_CAPABILITY_COMPATIBLE_CONTROL",
      },
      grounding: {
        candidateCount: 4,
        eligibleCount: 0,
        confidence: 0,
        confidenceMargin: 0,
        rejectedConstraints: ["hidden", "editable"],
        scopeKind: "page",
        observationStatus: "succeeded",
        rejectedCapabilitySignatures: [],
      },
    };
    expect(formatEmailGroundingDiagnostics(telemetry)).toEqual(
      expect.arrayContaining([
        "emailGrounding.nativeFailureCode: NATIVE_TARGET_NOT_FOUND",
        "emailGrounding.praxisFailureCode: NO_CAPABILITY_COMPATIBLE_CONTROL",
        "emailGrounding.praxisCandidateCount: 4",
        "emailGrounding.praxisEligibleCount: 0",
        'emailGrounding.rejectedConstraints: ["hidden","editable"]',
      ]),
    );
  });
  it.each(["EMAIL_GROUNDING", "PASSWORD_GROUNDING", "LOGIN_GROUNDING"] as const)(
    "%s failure classifies login target unavailable",
    (stage) => {
      const telemetry = emptyTelemetry();
      telemetry[stage] = { status: "failed", code: "CONTROL_INVENTORY_EMPTY" };
      expect(loginGroundingUnavailable(telemetry)).toBe(true);
      expect(
        formatObservationOutput({
          result: "LOGIN_TARGET_UNAVAILABLE",
          providerRejectedCredentials: "not_proven",
        }),
      ).toEqual(
        expect.arrayContaining([
          "result: LOGIN_TARGET_UNAVAILABLE",
          "providerRejectedCredentials: not_proven",
        ]),
      );
    },
  );
  it("does not return resolved secret values in telemetry or diagnostics", async () => {
    const canary = "private-canary-never-emit";
    const result = await runPreparation(dependencies({ resolve: vi.fn(async () => canary) }), {
      mode: "prepare",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
  it.each(["malformed", "5dd44124-8bb6-4f13-8fd3-524bf9b268b7"])(
    "rejects invalid or stale prepared session before browser: %s",
    async (sessionId) => {
      const deps = dependencies(
        sessionId === "malformed"
          ? {}
          : {
              resolvePreparedSession: vi.fn(async (id) => ({
                ...(await dependencies().resolvePreparedSession!(id)),
                idempotencyKey: "vitract-revoke-target-rehearsal-v2-local-preparation",
              })),
            },
      );
      const result = await runPreparation(deps, { mode: "live", preparedSessionId: sessionId });
      expect([
        "REHEARSAL_PREPARED_SESSION_ID_INVALID",
        "REHEARSAL_PREPARED_SESSION_MISMATCH",
      ]).toContain(result.safeCode);
      expect(deps.create).not.toHaveBeenCalled();
      expect(deps.launchBrowser).not.toHaveBeenCalled();
    },
  );
  it("valid target pair may reach browser boundary", async () => {
    const deps = dependencies();
    const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
    expect(result.telemetry.TARGET_CREDENTIAL_PAIR_REVALIDATION.status).toBe("succeeded");
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.launchBrowser).toHaveBeenCalledOnce();
  });
  it("rejects a nonexistent prepared session before browser", async () => {
    const deps = dependencies({
      resolvePreparedSession: vi.fn(async () => {
        throw coded("REHEARSAL_PREPARED_SESSION_UNAVAILABLE");
      }),
    });
    const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
    expect(result.safeCode).toBe("REHEARSAL_PREPARED_SESSION_UNAVAILABLE");
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it.each([
    "projectId",
    "environmentId",
    "missionId",
    "objectiveId",
    "flowDraftId",
    "agentSessionId",
    "idempotencyKey",
    "correlationId",
    "protectedAllowlist",
    "state",
  ] as const)("rejects prepared-session %s mismatch before browser", async (field) => {
    const baseline = await dependencies().resolvePreparedSession!(preparedId);
    const wrong = field === "protectedAllowlist" ? [] : field === "state" ? "completed" : "wrong";
    const deps = dependencies({
      resolvePreparedSession: vi.fn(async () => ({ ...baseline, [field]: wrong })),
    });
    const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
    expect(result.safeCode).toBe("REHEARSAL_PREPARED_SESSION_MISMATCH");
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it.each([
    "REHEARSAL_TARGET_CREDENTIAL_PAIR_INACTIVE",
    "REHEARSAL_TARGET_CREDENTIAL_ISSUANCE_MISMATCH",
    "REHEARSAL_TARGET_CREDENTIAL_ENVIRONMENT_MISMATCH",
  ])("target pair mismatch fails before browser: %s", async (code) => {
    const deps = dependencies({
      revalidateTargetPair: vi.fn(async () => {
        throw coded(code);
      }),
    });
    const result = await runPreparation(deps, { mode: "live", preparedSessionId: preparedId });
    expect(result.safeCode).toBe(code);
    expect(deps.launchBrowser).not.toHaveBeenCalled();
  });
  it("does not infer uniqueness from one safe node in each row", () => {
    const rows = [0, 1].map(() => ({
      kind: "row",
      components: [{ class: "status", value: "active", independentlyPublic: true }],
    }));
    expect(analyzeDescriptors(rows, rows)).toMatchObject({
      available: true,
      unique: false,
      distinguishable: false,
    });
  });
  it("distinguishes only distinct stable public descriptors", () => {
    const rows = ["Alpha", "Beta"].map((value) => ({
      kind: "row",
      components: [{ class: "provider_record_label", value, independentlyPublic: true }],
    }));
    expect(analyzeDescriptors(rows, rows)).toMatchObject({
      stable: true,
      unique: true,
      distinguishable: true,
    });
    expect(analyzeDescriptors(rows, [...rows].reverse())).toMatchObject({
      stable: true,
      distinguishable: true,
    });
    const drift = [
      rows[0]!,
      {
        ...rows[1]!,
        components: [{ class: "provider_record_label", value: "Gamma", independentlyPublic: true }],
      },
    ];
    expect(analyzeDescriptors(rows, drift)).toMatchObject({
      stable: false,
      distinguishable: false,
    });
  });
  it("reports metadata classes without exposing raw values", () => {
    const descriptor = descriptorFromAccessibilitySnapshot(
      "row",
      '- text: "Created on: 2026-08-09"\n- text: "Status: Active"',
    );
    expect(descriptor.potentialMetadataClasses).toEqual(["creation_time", "status"]);
    expect(JSON.stringify(descriptor.potentialMetadataClasses)).not.toContain("2026-08-09");
  });
  it("excludes protected-looking and unknown accessibility values", () => {
    const descriptor = descriptorFromAccessibilitySnapshot(
      "row",
      '- text: "Credential name: 045970aa-9210-47e7-bafa-18ce4da5089c"\n- text: "Unclassified words"',
    );
    expect(descriptor.components).toEqual([]);
    expect(descriptor.potentialMetadataClasses).toEqual(["provider_record_label"]);
  });
  it("distinguishable rows do not create issuance binding", () => {
    const formatted = formatObservationOutput({
      intendedCredentialToExternalRecordBinding: "not_proven",
      result: "INSUFFICIENT_SAFE_IDENTITY",
    } as never);
    expect(formatted).toContain("intendedCredentialToExternalRecordBinding: not_proven");
    expect(formatted).toContain("result: INSUFFICIENT_SAFE_IDENTITY");
  });
  it("formatter emits the required observation fields", () => {
    const formatted = formatObservationOutput().join("\n");
    expect(formatted).toContain("credentialPairProvenanceResolved:");
    expect(formatted).toContain("revokeBrowserDispatchCount: 0");
  });
  it("contains no revoke dispatch path and does not gate readiness on a generic provider response", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-revoke-target-rehearsal.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/(?:candidate|groundedRevoke)[\w.]*\.click\s*\(/);
    expect(source).not.toContain("Confirm revoke");
    expect(source).not.toContain("waitForResponse(");
    expect(source).toContain('stage("AUTHENTICATED_READINESS"');
  });
  it("uses no invented marker or raw DOM identity discovery", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-revoke-target-rehearsal.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("data-scry-public-record-label");
    for (const forbidden of [".evaluate(", ".closest(", "querySelectorAll(", "xpath="])
      expect(source).not.toContain(forbidden);
    expect(source).toContain("ariaSnapshot(");
    expect(source).toContain("getByRole(");
  });
  it("only Login has a click dispatch path", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-revoke-target-rehearsal.ts", import.meta.url),
      "utf8",
    );
    const clicks = source.match(/\.click\s*\(/g) ?? [];
    expect(clicks).toHaveLength(1);
    expect(source).toMatch(/stage\("LOGIN_DISPATCH"[\s\S]*?loginTarget![\s\S]*?\.click\s*\(/);
  });
  it("accepts only canonicalization-equivalent credential routes", () => {
    const route =
      "https://preview.vitract.com/partner/developer/applications/vtr_app_sandbox_c76f2735-de94-f111-9b33-00224854e25a/credentials";
    expect(credentialRouteMatches(`${route}/`)).toBe(true);
    expect(credentialRouteMatches(route.replace("c76f2735", "aaaaaaaa"))).toBe(false);
  });
  it("waits for semantic Revoke availability before enumerating", async () => {
    const order: string[] = [];
    const locators = [
      {
        isVisible: vi.fn(async () => {
          order.push("enumerate");
          return true;
        }),
      },
    ];
    const candidates = {
      first: () => ({
        waitFor: vi.fn(async () => {
          order.push("wait");
        }),
      }),
      count: vi.fn(async () => locators.length),
      nth: (index: number) => locators[index],
    };
    const visible = await settleVisibleRevokeCandidates(candidates as never, 5_000);
    expect(visible).toHaveLength(1);
    expect(order).toEqual(["wait", "enumerate"]);
  });
  it("supports bounded zero candidates after semantic timeout", async () => {
    const candidates = {
      first: () => ({
        waitFor: vi.fn(async () => {
          throw new playwrightErrors.TimeoutError("bounded zero");
        }),
      }),
      count: vi.fn(async () => 0),
      nth: vi.fn(),
    };
    expect(await settleVisibleRevokeCandidates(candidates as never, 5_000)).toEqual([]);
    expect(candidates.count).toHaveBeenCalledOnce();
  });
  it("keeps multiple visible Revoke candidates observational", async () => {
    const locators = [
      { isVisible: vi.fn(async () => true) },
      { isVisible: vi.fn(async () => true) },
    ];
    const candidates = {
      first: () => ({ waitFor: vi.fn(async () => undefined) }),
      count: vi.fn(async () => 2),
      nth: (index: number) => locators[index],
    };
    expect(await settleVisibleRevokeCandidates(candidates as never)).toHaveLength(2);
  });
  it("uses production navigation seam for both login and credential pages", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-revoke-target-rehearsal.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/navigateAndWaitNative\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/goto\(EXPECTED\.credentialUrl/);
    expect(source).toContain("policy.trustedScriptOrigins ?? []");
    expect(source).toContain("allowedOrigins: policy.allowedOrigins");
    expect(source).not.toContain('allowedOrigins: ["https://preview.vitract.com"]');
  });
  it("structurally prevents live mode from invoking session creation", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-revoke-target-rehearsal.ts", import.meta.url),
      "utf8",
    );
    const liveBranch = source.slice(
      source.indexOf(": await runPreparation({ ...common, resolvePreparedSession"),
    );
    expect(liveBranch).not.toContain("sessions.create(");
    expect(source).toContain(
      'idempotencyKey: "vitract-revoke-target-rehearsal-v3-production-policy-preparation"',
    );
    expect(source).toContain('correlationId: "23dff597-c0d7-4ba7-94b5-959c04daa17b"');
    expect(source).not.toContain("5dd44124-8bb6-4f13-8fd3-524bf9b268b7");
    expect(source).not.toContain("freshInspectionSessionCreated");
  });
  it("keeps policy loading bound to the validated project and environment", async () => {
    const source = await readFile(
      new URL("../scripts/vitract-revoke-target-rehearsal.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('projectId: "6b3b5011-0f41-430c-a8a2-d4abfd9ff3f1"');
    expect(source).not.toContain('environmentId: "9a581bb0-2276-4888-9ddb-07b2485cddc3"');
    expect(source).toContain("FROM q5_prepared_scopes scope");
    expect(source).toMatch(/WHERE project\.id=\$1 AND environment\.id=\$2/);
    expect(source).toMatch(
      /runtime\.projectId !== authority\.projectId\s*\|\|\s*runtime\.environmentId !== authority\.environmentId/,
    );
  });
});
