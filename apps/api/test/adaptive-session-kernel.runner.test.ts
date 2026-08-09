import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionKernelRunner } from "../src/adaptive-sessions/adaptive-session-kernel.runner.js";

describe("AdaptiveSessionKernelRunner timing propagation", () => {
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
