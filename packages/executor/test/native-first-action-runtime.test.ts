import { describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";

import { executeAction } from "../src/action-runtime.js";
import { executeInteractionCompatibility } from "../src/execution-kernel.js";

const target = {
  concept: "sign in",
  requiredCapabilities: ["pointer_activatable" as const],
  preferredEvidence: {
    roles: ["button" as const], names: ["Sign in"], labels: [], descriptions: [],
    placeholders: [], inputTypes: [],
  },
  scope: { kind: "page" as const }, relations: [], prohibited: ["hidden" as const, "disabled" as const],
  risk: "authentication" as const, confidence: { requiredFamilies: [] },
};

describe("native-first action runtime", () => {
  it("dispatches a standard control through one native resolution with zero Praxis results", async () => {
    const click = vi.fn(async () => undefined);
    const executeNativeControl = vi.fn(async (_page, _target, operation, beforeDispatch) => {
      await beforeDispatch?.();
      if (operation.type === "click") await click();
    });
    const onPraxisResult = vi.fn();
    const onMutationDispatch = vi.fn(async () => undefined);
    await executeAction(
      {} as never,
      { type: "click", target, expectedEffect: { type: "none" } },
      {
        plan: {
          name: "native auth", objective: "sign in", preconditions: [],
          allowedOrigins: ["https://example.test"],
          budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
          checkpoints: [], steps: [],
        },
        policy: {
          allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
          allowDownloads: false, allowPopups: false, maxActions: 1,
          maxDurationMs: 30_000, maxNavigations: 1,
        },
        outputDirectory: "/tmp/native-first-test",
        executeNativeControl,
        onPraxisResult,
        onMutationDispatch,
      },
      new AbortController().signal,
      new SecretRedactor(),
      new Map(),
      new Map(),
    );
    expect(executeNativeControl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(onMutationDispatch).toHaveBeenCalledOnce();
    expect(onPraxisResult).not.toHaveBeenCalled();
  });

  it("does not invoke Praxis when M2 native-only resolution misses", async () => {
    const praxisSpy = vi.fn();
    await expect(executeAction(
      {} as never,
      { type: "click", target, expectedEffect: { type: "none" } },
      {
        plan: { name: "native only", objective: "resolve", preconditions: [], allowedOrigins: ["https://example.test"], budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 }, checkpoints: [], steps: [] },
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
        outputDirectory: "/tmp/native-only-test", nativeResolutionPolicy: "native_only",
        executeNativeControl: vi.fn(async () => { throw new Error("NATIVE_TARGET_NOT_FOUND"); }),
        onPraxisResult: praxisSpy,
      }, new AbortController().signal, new SecretRedactor(), new Map(), new Map(),
    )).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
    expect(praxisSpy).not.toHaveBeenCalled();
  });

  it("contains current-browser-session tokens inside a Veil protected interval", async () => {
    const tokenCanary = "bearer-token-must-never-serialize";
    const lifecycle: string[] = [];
    const callbackValues: unknown[] = [];
    const privacyGate = {
      prepare: vi.fn(async () => { lifecycle.push("prepare"); }),
      beginProtected: vi.fn(async () => { lifecycle.push("protected"); }),
      markCaptured: vi.fn(async () => { lifecycle.push("captured"); }),
      beginSafeBoundary: vi.fn(async () => { lifecycle.push("safe-boundary"); }),
      confirmSafeBoundary: vi.fn(async () => { lifecycle.push("confirmed"); }),
      seal: vi.fn(async () => { lifecycle.push("sealed"); }),
    };
    const artifacts: unknown[] = [];
    const events: unknown[] = [];
    const outcome = await executeInteractionCompatibility({
      sessionId: "session", operationId: "operation", ordinal: 1,
      page: { url: () => "https://example.test/account" } as never,
      action: {
        type: "sameOriginRequest", method: "DELETE", path: "/users/me",
        expectedStatus: { min: 200, max: 204 }, authentication: "current_browser_session",
      },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
      privacyGate: privacyGate as never,
      options: {
        outputDirectory: "/tmp/native-request-test",
        executeSameOriginRequest: vi.fn(async (_page, request, _origins, beforeDispatch) => {
          callbackValues.push(request, false);
          await beforeDispatch?.();
          return { status: 204, classification: "expected" as const };
        }),
      },
    });
    expect(lifecycle).toEqual(["prepare", "protected", "captured", "safe-boundary", "confirmed"]);
    expect(outcome.privacyResult).toBe("verified");
    expect(JSON.stringify({ events, artifacts, callbackValues, outcome })).not.toContain(tokenCanary);
  });

  it("seals the protected interval when a same-origin request fails", async () => {
    const lifecycle: string[] = [];
    const privacyGate = {
      prepare: vi.fn(async () => { lifecycle.push("prepare"); }),
      beginProtected: vi.fn(async () => { lifecycle.push("protected"); }),
      markCaptured: vi.fn(async () => { lifecycle.push("captured"); }),
      beginSafeBoundary: vi.fn(async () => { lifecycle.push("safe-boundary"); }),
      confirmSafeBoundary: vi.fn(async () => { lifecycle.push("confirmed"); }),
      seal: vi.fn(async () => { lifecycle.push("sealed"); }),
    };
    const outcome = await executeInteractionCompatibility({
      sessionId: "session", operationId: "operation", ordinal: 1, page: { url: () => "https://example.test" } as never,
      action: { type: "sameOriginRequest", method: "DELETE", path: "/users/me", expectedStatus: { min: 204, max: 204 }, authentication: "current_browser_session" },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
      privacyGate: privacyGate as never,
      options: { outputDirectory: "/tmp/native-request-failure", executeSameOriginRequest: vi.fn(async () => { throw new Error("NATIVE_SAME_ORIGIN_STATUS_UNEXPECTED"); }) },
    });
    expect(lifecycle).toEqual(["prepare", "protected", "sealed"]);
    expect(outcome.privacyResult).toBe("sealed");
  });
});
