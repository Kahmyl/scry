import { describe, expect, it, vi } from "vitest";
import { compileDefaultVeilPolicy } from "@scry/veil";

import { AdaptiveSessionKernelRunner } from "../src/adaptive-sessions/adaptive-session-kernel.runner.js";

describe("AdaptiveSessionKernelRunner timing propagation", () => {
  it("projects the exact safe missing origin and replacement-session recovery", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const environmentId = "22222222-2222-4222-8222-222222222222";
    const policy = { allowedOrigins: ["https://example.test"], trustedScriptOrigins: ["https://wrong.example.test"],
      allowPrivateNetwork: false, allowDownloads: false, allowPopups: false,
      maxActions: 2, maxDurationMs: 30_000, maxNavigations: 1 };
    const sessions = {
      heartbeatRuntimeLease: vi.fn(async () => undefined),
      runtimeContextFor: vi.fn(async () => ({ environmentId, correlationId: "correlation", policy })),
      recordVerifiedObservation: vi.fn(async () => undefined),
    };
    const runner = new AdaptiveSessionKernelRunner(
      {} as never,
      { createSession: vi.fn(() => ({ manifest: { digest: "a".repeat(64) } })) } as never,
      sessions as never,
      {} as never,
    );
    const outcome = { operationId: "inspect", functionalResult: "failed" as const,
      mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1,
      reasonCode: "ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED",
      environmentFailure: { missingTrustedScriptOrigins: ["https://scripts.example.test"],
        missingOriginClassification: "public" as const } };
    (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
      session: { interact: vi.fn(async () => ({ documentEpoch: 1, url: "https://example.test", outcome })) },
      fencingToken: 1, tail: Promise.resolve(),
    });

    const result = await runner.execute(sessionId, { operationId: "inspect",
      idempotencyKey: "inspect-idempotency", mode: "observe", action: { type: "waitFor" },
      expectedEffect: { type: "none" }, protectedInputReferences: [] } as never);

    expect(result.decisionBoundary).toMatchObject({
      safeActions: ["recover_trusted_script_origins"],
      environmentRecovery: {
        environmentId,
        missingTrustedScriptOrigins: ["https://scripts.example.test"],
        currentTrustedScriptOrigins: ["https://wrong.example.test"],
        requiresNewFlowDraftAndAuthoringSession: true,
      },
    });
  });

  it("projects a rejected popup origin as factual document-policy recovery", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const environmentId = "44444444-4444-4444-8444-444444444444";
    const policy = { allowedOrigins: ["https://app.example.test"], trustedScriptOrigins: [],
      allowPrivateNetwork: false, allowDownloads: false, allowPopups: true,
      maxActions: 2, maxDurationMs: 30_000, maxNavigations: 1 };
    const sessions = {
      heartbeatRuntimeLease: vi.fn(async () => undefined),
      runtimeContextFor: vi.fn(async () => ({ environmentId, correlationId: "correlation", policy })),
      recordVerifiedObservation: vi.fn(async () => undefined),
    };
    const runner = new AdaptiveSessionKernelRunner(
      {} as never,
      { createSession: vi.fn(() => ({ manifest: { digest: "a".repeat(64) } })) } as never,
      sessions as never,
      {} as never,
    );
    const outcome = { operationId: "docs", functionalResult: "failed" as const,
      mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1,
      reasonCode: "EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED",
      navigationEnvironmentFailure: { missingAllowedOrigin: "https://docs.example.test" } };
    (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
      session: { interact: vi.fn(async () => ({ documentEpoch: 1, url: "https://app.example.test", outcome })) },
      fencingToken: 1, tail: Promise.resolve(),
    });

    const result = await runner.execute(sessionId, { operationId: "docs",
      idempotencyKey: "docs-idempotency", mode: "observe", action: { type: "waitFor" },
      expectedEffect: { type: "new_page" }, protectedInputReferences: [] } as never);

    expect(result.decisionBoundary).toEqual({
      type: "environment_unavailable",
      reasonCode: "EXPECTED_NEW_PAGE_ORIGIN_NOT_ALLOWED",
      safeActions: ["create_test_environment", "create_flow_draft", "start_flow_authoring"],
      navigationRecovery: {
        environmentId,
        missingAllowedOrigin: "https://docs.example.test",
        currentAllowedOrigins: ["https://app.example.test"],
        recoveryTools: ["create_test_environment", "create_flow_draft", "start_flow_authoring"],
        requiresNewFlowDraftAndAuthoringSession: true,
      },
    });
  });

  it("bounds a pending operation tail, cancels the browser, and releases its lease", async () => {
    const sessionId = "99999999-9999-4999-8999-999999999999";
    const cancelActiveOperation = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const releaseRuntimeLease = vi.fn().mockResolvedValue(undefined);
    const runner = new AdaptiveSessionKernelRunner(
      {} as never,
      {} as never,
      { releaseRuntimeLease } as never,
      {} as never,
    );
    (runner as unknown as { runtimeCloseTimeoutMs: number }).runtimeCloseTimeoutMs = 10;
    (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
      session: { cancelActiveOperation, close },
      fencingToken: 17,
      tail: new Promise<void>(() => undefined),
    });

    await expect(runner.close(sessionId)).resolves.toBeUndefined();

    expect(cancelActiveOperation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      fencingToken: 17,
    }));
    expect((runner as unknown as { runtimes: Map<string, unknown> }).runtimes.has(sessionId))
      .toBe(false);
  });

  it("evicts a cancelled runtime so a continuation cannot reuse the closed browser", async () => {
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const cancelActiveOperation = vi.fn().mockResolvedValue(undefined);
    const runner = new AdaptiveSessionKernelRunner({} as never, {} as never, {} as never, {} as never);
    (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, {
      session: { cancelActiveOperation }, fencingToken: 3, tail: Promise.resolve(),
    });

    await runner.cancelActiveOperation(sessionId);

    expect(cancelActiveOperation).toHaveBeenCalledOnce();
    expect((runner as unknown as { runtimes: Map<string, unknown> }).runtimes.has(sessionId))
      .toBe(false);
  });

  it("retains the original fenced lease across resolution through mutation dispatch", async () => {
    vi.useFakeTimers();
    try {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const leaseDurationMs = 900;
      let lastHeartbeatAt = Date.now();
      const mutationDispatch = vi.fn();
      const leaseOwners = new Set<unknown>();
      const fencingTokens = new Set<unknown>();
      const lifecycle: string[] = [];
      const sessions = {
        heartbeatRuntimeLease: vi.fn(async (input: Record<string, unknown>) => {
          if (Date.now() - lastHeartbeatAt > leaseDurationMs) throw new Error("RUNTIME_LEASE_EXPIRED");
          lastHeartbeatAt = Date.now();
          leaseOwners.add(input.ownerId);
          fencingTokens.add(input.fencingToken);
          lifecycle.push("heartbeat");
          expect(input).toMatchObject({ sessionId, fencingToken: 7, leaseDurationMs });
        }),
        markOperationDispatching: vi.fn(async () => {
          if (Date.now() - lastHeartbeatAt > leaseDurationMs) throw new Error("RUNTIME_LEASE_EXPIRED");
          lifecycle.push("mark-dispatching");
        }),
        runtimeContextFor: vi.fn().mockResolvedValue({
          environmentId: "environment", correlationId: "correlation",
          policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
            allowDownloads: false, allowPopups: false, maxActions: 2,
            maxDurationMs: 30_000, maxNavigations: 1 },
        }),
        recordVerifiedObservation: vi.fn(),
      };
      const outcome = { operationId: "long-resolution", functionalResult: "succeeded" as const,
        mutationOutcome: "applied" as const, privacyResult: "unverified" as const,
        evidenceResult: [], qualityFindings: [], durationMs: 1 };
      const kernel = {
        interact: vi.fn(async ({ capabilities }: { capabilities: { options: {
          onMutationDispatch: () => Promise<void>;
        } } }) => {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          await capabilities.options.onMutationDispatch();
          lifecycle.push("mutation");
          mutationDispatch();
          return outcome;
        }),
      };
      const capabilities = { createSession: vi.fn((input: { options: unknown }) =>
        ({ manifest: { digest: "a".repeat(64) }, options: input.options })) };
      const runner = new AdaptiveSessionKernelRunner(
        kernel as never, capabilities as never, sessions as never, {} as never,
      );
      (runner as unknown as { leaseDurationMs: number }).leaseDurationMs = leaseDurationMs;
      const ownedSession = {
        interact: vi.fn(async (action: never, context: Record<string, unknown>) => ({
          documentEpoch: 2, url: "https://example.test/app",
          outcome: await (runner as unknown as { executeInteraction(input: unknown): Promise<typeof outcome> })
            .executeInteraction({ sessionId, environmentId: "environment",
              policy: (await sessions.runtimeContextFor()).policy, mode: "rehearse",
              fencingToken: 7, browser: {}, context: {}, provenance: {}, page: {}, action,
              ordinal: 1, operationId: context.operationId, correlationId: context.correlationId,
              mutationIdentity: context.mutationIdentity, privacyGate: {} }),
        })),
      };
      (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId,
        { session: ownedSession, fencingToken: 7, tail: Promise.resolve() });

      const execution = runner.execute(sessionId, {
        operationId: "long-resolution", idempotencyKey: "long-resolution-key", mode: "rehearse",
        action: { type: "click", target: {} }, expectedEffect: { type: "none" },
        protectedInputReferences: [],
      } as never);
      await vi.advanceTimersByTimeAsync(1_200);

      await expect(execution).resolves.toMatchObject({ outcome: { functionalResult: "succeeded" } });
      expect(sessions.heartbeatRuntimeLease).toHaveBeenCalledTimes(6);
      expect(leaseOwners.size).toBe(1);
      expect([...fencingTokens]).toEqual([7]);
      expect(sessions.markOperationDispatching).toHaveBeenCalledOnce();
      expect(mutationDispatch).toHaveBeenCalledOnce();
      expect(lifecycle.slice(-3)).toEqual(["heartbeat", "mark-dispatching", "mutation"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels before dispatch when periodic renewal loses ownership", async () => {
    vi.useFakeTimers();
    try {
      const sessionId = "33333333-3333-4333-8333-333333333333";
      const sessions = {
        heartbeatRuntimeLease: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("RUNTIME_LEASE_OWNERSHIP_LOST")),
        markOperationDispatching: vi.fn(),
        runtimeContextFor: vi.fn().mockResolvedValue({ environmentId: "environment",
          correlationId: "correlation", policy: { allowedOrigins: ["https://example.test"],
            allowPrivateNetwork: false, allowDownloads: false, allowPopups: false,
            maxActions: 2, maxDurationMs: 30_000, maxNavigations: 1 } }),
        recordVerifiedObservation: vi.fn(),
      };
      const kernel = { interact: vi.fn(({ capabilities }: { capabilities: { options: {
        signal: AbortSignal;
      } } }) => new Promise((_resolve, reject) => {
        capabilities.options.signal.addEventListener("abort", () =>
          reject(capabilities.options.signal.reason), { once: true });
      })) };
      const capabilities = { createSession: vi.fn((input: { options: unknown }) =>
        ({ manifest: { digest: "a".repeat(64) }, options: input.options })) };
      const runner = new AdaptiveSessionKernelRunner(
        kernel as never, capabilities as never, sessions as never, {} as never,
      );
      (runner as unknown as { leaseDurationMs: number }).leaseDurationMs = 900;
      const ownedSession = { interact: vi.fn(async (action: never, context: Record<string, unknown>) => ({
        documentEpoch: 1, url: "https://example.test",
        outcome: await (runner as unknown as { executeInteraction(input: unknown): Promise<never> })
          .executeInteraction({ sessionId, environmentId: "environment",
            policy: (await sessions.runtimeContextFor()).policy, mode: "rehearse",
            fencingToken: 9, browser: {}, context: {}, provenance: {}, page: {}, action,
            ordinal: 1, operationId: context.operationId, correlationId: context.correlationId,
            privacyGate: {} }),
      })) };
      (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId,
        { session: ownedSession, fencingToken: 9, tail: Promise.resolve() });
      const execution = runner.execute(sessionId, { operationId: "pre-dispatch-loss",
        idempotencyKey: "pre-dispatch-loss-key", mode: "rehearse",
        action: { type: "click", target: {} }, expectedEffect: { type: "none" },
        protectedInputReferences: [] } as never);
      const settled = execution.then(() => undefined, (error) => error);

      await vi.advanceTimersByTimeAsync(300);

      await expect(settled).resolves.toMatchObject({ message: "RUNTIME_LEASE_OWNERSHIP_LOST" });
      expect(sessions.markOperationDispatching).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      const heartbeats = sessions.heartbeatRuntimeLease.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessions.heartbeatRuntimeLease).toHaveBeenCalledTimes(heartbeats);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves unknown mutation after ownership is lost beyond dispatch", async () => {
    vi.useFakeTimers();
    try {
      const sessionId = "44444444-4444-4444-8444-444444444444";
      const mutation = vi.fn();
      const sessions = {
        heartbeatRuntimeLease: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("RUNTIME_LEASE_OWNERSHIP_LOST")),
        markOperationDispatching: vi.fn(async () => undefined),
        runtimeContextFor: vi.fn().mockResolvedValue({ environmentId: "environment",
          correlationId: "correlation", policy: { allowedOrigins: ["https://example.test"],
            allowPrivateNetwork: false, allowDownloads: false, allowPopups: false,
            maxActions: 2, maxDurationMs: 30_000, maxNavigations: 1 } }),
        recordVerifiedObservation: vi.fn(),
      };
      const outcome = { operationId: "post-dispatch-loss", functionalResult: "failed" as const,
        mutationOutcome: "unknown" as const, privacyResult: "unverified" as const,
        evidenceResult: [], qualityFindings: [], durationMs: 1,
        reasonCode: "RUNTIME_LEASE_OWNERSHIP_LOST" };
      const kernel = { interact: vi.fn(async ({ capabilities }: { capabilities: { options: {
        signal: AbortSignal; onMutationDispatch: () => Promise<void>;
      } } }) => {
        await capabilities.options.onMutationDispatch();
        mutation();
        await new Promise<void>((resolve) => capabilities.options.signal.addEventListener(
          "abort", () => resolve(), { once: true }));
        return outcome;
      }) };
      const capabilities = { createSession: vi.fn((input: { options: unknown }) =>
        ({ manifest: { digest: "a".repeat(64) }, options: input.options })) };
      const runner = new AdaptiveSessionKernelRunner(
        kernel as never, capabilities as never, sessions as never, {} as never,
      );
      (runner as unknown as { leaseDurationMs: number }).leaseDurationMs = 900;
      const ownedSession = { interact: vi.fn(async (action: never, context: Record<string, unknown>) => ({
        documentEpoch: 3, url: "https://example.test/app",
        outcome: await (runner as unknown as { executeInteraction(input: unknown): Promise<typeof outcome> })
          .executeInteraction({ sessionId, environmentId: "environment",
            policy: (await sessions.runtimeContextFor()).policy, mode: "rehearse",
            fencingToken: 11, browser: {}, context: {}, provenance: {}, page: {}, action,
            ordinal: 1, operationId: context.operationId, correlationId: context.correlationId,
            privacyGate: {} }),
      })) };
      (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId,
        { session: ownedSession, fencingToken: 11, tail: Promise.resolve() });
      const execution = runner.execute(sessionId, { operationId: "post-dispatch-loss",
        idempotencyKey: "post-dispatch-loss-key", mode: "rehearse",
        action: { type: "click", target: {} }, expectedEffect: { type: "none" },
        protectedInputReferences: [] } as never);
      await vi.advanceTimersByTimeAsync(300);
      const result = await execution;

      expect(sessions.markOperationDispatching).toHaveBeenCalledOnce();
      expect(mutation).toHaveBeenCalledOnce();
      expect(result.outcome.mutationOutcome).toBe("unknown");
      expect(result.decisionBoundary.type).toBe("mutation_reconciliation_required");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits an in-flight renewal before successful settlement cleanup", async () => {
    vi.useFakeTimers();
    try {
      let releaseRenewal!: () => void;
      const pendingRenewal = new Promise<void>((resolve) => { releaseRenewal = resolve; });
      const sessions = { heartbeatRuntimeLease: vi.fn()
        .mockResolvedValueOnce(undefined).mockReturnValueOnce(pendingRenewal) };
      const runner = new AdaptiveSessionKernelRunner(
        {} as never, {} as never, sessions as never, {} as never,
      );
      (runner as unknown as { leaseDurationMs: number }).leaseDurationMs = 900;
      const guard = await (runner as unknown as {
        startOperationLeaseGuard(sessionId: string, runtime: { fencingToken: number }): Promise<{
          stop(): Promise<void>;
        }>;
      }).startOperationLeaseGuard("cleanup-session", { fencingToken: 13 });
      await vi.advanceTimersByTimeAsync(300);
      let stopped = false;
      const stopping = guard.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      releaseRenewal();
      await stopping;
      expect(stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessions.heartbeatRuntimeLease).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("composes Mission authoring with native-first fallback and the unchanged Veil policy", () => {
    const policy = {
      allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
      allowDownloads: false as const, allowPopups: false as const, maxActions: 2,
      maxDurationMs: 30_000, maxNavigations: 1,
    };
    const capabilities = {
      createSession: vi.fn((input: { options: Record<string, unknown> }) => ({
        manifest: { digest: "a".repeat(64) }, options: input.options,
      })),
    };
    const runner = new AdaptiveSessionKernelRunner(
      {} as never,
      capabilities as never,
      { resolveCredential: vi.fn() } as never,
      {} as never,
    );

    const capability = (runner as unknown as {
      createCapabilities(input: Record<string, unknown>): { options: Record<string, unknown> };
    }).createCapabilities({
      sessionId: "session", environmentId: "environment", correlationId: "correlation",
      operationId: "operation", mode: "rehearse", policy,
    });

    expect(capability.options.nativeResolutionPolicy).toBeUndefined();
    expect(capability.options.veilPolicySnapshot).toEqual(compileDefaultVeilPolicy(policy));
  });

  it("collects native resolution and expected-effect timings from the capability that executes the interaction", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const operation = {
      operationId: "m2-timed-operation", idempotencyKey: "m2-timed-operation-key",
      mode: "rehearse" as const,
      action: { type: "waitFor" as const, target: {} as never, state: "visible" as const },
      expectedEffect: { type: "none" as const }, protectedInputReferences: [],
    };
    const outcome = {
      operationId: operation.operationId, functionalResult: "succeeded" as const,
      mutationOutcome: "not_applied" as const, privacyResult: "unverified" as const,
      evidenceResult: [], qualityFindings: [], durationMs: 1,
    };
    const kernel = {
      interact: vi.fn(async ({ capabilities }: { capabilities: { options: {
        onNativeResolution?: (input: { durationMs: number; status: "resolved" }) => Promise<void>;
        onExpectedEffectVerification?: (input: { durationMs: number; status: "succeeded" }) => Promise<void>;
      } } }) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await capabilities.options.onNativeResolution?.({ status: "resolved", durationMs: 7 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await capabilities.options.onExpectedEffectVerification?.({ status: "succeeded", durationMs: 11 });
        return outcome;
      }),
    };
    const capabilities = { createSession: vi.fn((input: { options: unknown }) => ({ manifest: { digest: "a".repeat(64) }, options: input.options })) };
    const sessions = {
      heartbeatRuntimeLease: vi.fn(),
      runtimeContextFor: vi.fn().mockResolvedValue({
        environmentId: "environment", correlationId: "correlation",
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 2, maxDurationMs: 30_000, maxNavigations: 1 },
      }),
      recordVerifiedObservation: vi.fn(),
    };
    const runner = new AdaptiveSessionKernelRunner(kernel as never, capabilities as never, sessions as never, {} as never);
    const page = { url: () => "https://example.test/account" };
    const ownedSession = {
      interact: vi.fn(async (action: never, context: { operationId: string; correlationId: string; mutationIdentity: string; expectedEffect: never }) =>
        ({
          documentEpoch: 4, url: page.url(),
          outcome: await (runner as unknown as { executeInteraction(input: unknown): Promise<typeof outcome> }).executeInteraction({
            sessionId, environmentId: "environment", policy: (await sessions.runtimeContextFor()).policy,
            mode: "rehearse", fencingToken: 1, browser: {} as never, context: {} as never,
            provenance: {} as never, page: page as never, action, ordinal: 1,
            operationId: context.operationId, correlationId: context.correlationId,
            mutationIdentity: context.mutationIdentity, expectedEffect: context.expectedEffect,
            privacyGate: {} as never,
          }),
        })),
    };
    (runner as unknown as { runtimes: Map<string, unknown> }).runtimes.set(sessionId, { session: ownedSession, fencingToken: 1, tail: Promise.resolve() });

    const result = await runner.execute(sessionId, operation as never);

    expect(kernel.interact).toHaveBeenCalledOnce();
    expect(result.timings).toMatchObject({ resolveMs: 7, verifyMs: 11 });
    expect(result.timings.executeMs).toBeGreaterThan(0);
  });
});
