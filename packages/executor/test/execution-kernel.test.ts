import { randomUUID } from "node:crypto";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";
import { describe, expect, it, vi } from "vitest";

import {
  createExecutionCapabilityManifest,
  evidenceOutcomeFromReport,
  ExecutionKernel,
  executeInteractionCompatibility,
  isProvenPreDispatchFailure,
  privacyOutcomeFromReport,
} from "../src/execution-kernel.js";
import { openTestBrowser } from "./kernel-harness.js";

const policy = executionPolicySchema.parse({
  allowedOrigins: ["https://example.test"],
  allowPrivateNetwork: false,
});

describe("execution kernel admission", () => {
  it("builds structurally complete manifests for every mode", () => {
    for (const mode of ["observe", "rehearse", "transact", "certify", "run"] as const) {
      const manifest = createExecutionCapabilityManifest({ mode, correlationId: randomUUID() });
      expect(Object.keys(manifest.capabilities).sort()).toEqual([
        "browser",
        "calibration",
        "checkpoint",
        "evidence",
        "journal",
        "praxis",
        "protected_input",
        "protected_operations",
        "veil",
      ]);
    }
  });

  it("admits protected input without full protected-operation machinery", () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({
      mode: "run",
      correlationId,
      states: { protected_operations: "unavailable" },
    });
    const request = {
      sessionId: "session",
      operationId: "protected-fill",
      correlationId,
      mode: "run" as const,
      plan: plan({
        type: "fill" as const,
        target: target(),
        secretRef: "11111111-1111-4111-8111-111111111111",
      }),
      policy,
      capabilityManifestDigest: manifest.digest,
      idempotencyKey: "protected-fill-admission",
      mutationIdentity: "protected-fill-mutation",
    };
    expect(
      new ExecutionKernel().admitOnly({
        request,
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn(), settle: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).toMatchObject({ operationId: "protected-fill" });
  });

  it("does not admit a full protected transaction with protected-input support alone", () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({
      mode: "run",
      correlationId,
      states: { protected_operations: "unavailable" },
    });
    const protectedPlan = currentPlanSchema.parse({
      ...plan({ type: "navigate", url: "https://example.test" }),
      steps: [
        {
          id: "protected",
          title: "Protected",
          action: protectedAction(),
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "transient",
          transientJustification: "Admission-only isolation test.",
        },
      ],
    });
    expect(() =>
      new ExecutionKernel().admitOnly({
        request: {
          sessionId: "session",
          operationId: "protected-transaction",
          correlationId,
          mode: "run",
          plan: protectedPlan,
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "protected-transaction-admission",
          mutationIdentity: "protected-transaction-mutation",
        },
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "EXECUTION_CAPABILITY_INCOMPLETE",
        missingCapabilities: ["protected_operations"],
      }),
    );
  });

  it("rejects an incomplete bundle before journal admission or browser startup", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({
      mode: "run",
      correlationId,
      states: { browser: "unavailable" },
    });
    const begin = vi.fn(async () => undefined);
    const kernel = new ExecutionKernel();
    await expect(
      kernel.execute({
        request: {
          sessionId: "session",
          operationId: "operation",
          correlationId,
          mode: "run",
          plan: plan({ type: "navigate", url: "https://example.test" }),
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "kernel-test-operation",
        },
        capabilities: {
          manifest,
          journal: { begin, complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_CAPABILITY_INCOMPLETE",
      missingCapabilities: ["browser"],
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it("denies non-observational work in observe mode before dispatch", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "observe", correlationId });
    const kernel = new ExecutionKernel();
    await expect(
      kernel.execute({
        request: {
          sessionId: "session",
          operationId: "operation",
          correlationId,
          mode: "observe",
          plan: plan({ type: "fill", target: target(), value: "public-value" }),
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "kernel-observe-operation",
        },
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_MODE_POLICY_DENIED" });
  });

  it("admits read-only waits in observe mode", () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "observe", correlationId });
    const request = {
      sessionId: "session",
      operationId: "observe-wait",
      correlationId,
      mode: "observe" as const,
      plan: plan({
        type: "waitFor" as const,
        target: target(),
        state: "visible" as const,
        timeoutMs: 1_000,
      }),
      policy,
      capabilityManifestDigest: manifest.digest,
      idempotencyKey: "kernel-observe-wait",
    };

    expect(
      new ExecutionKernel().admitOnly({
        request,
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).toMatchObject({ operationId: "observe-wait", mode: "observe" });
  });

  it("admits only explicitly classified read-context gestures in observe mode", () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "observe", correlationId });
    const admit = (action: Record<string, unknown>) =>
      new ExecutionKernel().admitOnly({
        request: {
          sessionId: "session",
          operationId: "observe-transition",
          correlationId,
          mode: "observe",
          plan: plan(action),
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "observe-transition-admission",
        },
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      });
    expect(() =>
      admit({
        type: "click",
        target: target("Live mode", "button", ["focusable", "pointer_activatable"]),
        expectedEffect: { type: "none" },
        dispatchSemantics: "read_only",
        timeoutMs: 1_000,
      }),
    ).not.toThrow();
    for (const action of [
      {
        type: "click",
        target: target("Unknown", "button", ["focusable", "pointer_activatable"]),
        expectedEffect: { type: "none" },
        timeoutMs: 1_000,
      },
      { type: "fill", target: target(), value: "production change", timeoutMs: 1_000 },
    ])
      expect(() => admit(action)).toThrow(
        expect.objectContaining({ code: "EXECUTION_MODE_POLICY_DENIED" }),
      );
  });

  it("gives the kernel sole positive-visibility ownership for non-value-readable links and buttons", async () => {
    const opened = await openTestBrowser();
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "rehearse", correlationId });
    const praxisResults: Array<import("@scry/contracts").PraxisResult> = [];
    const mutationDispatch = vi.fn(async () => undefined);
    const effectVerification = vi.fn();
    const unregister = registerPraxisVeilAuthority(opened.page, {
      authority: new VeilAuthority(
        compileVeilPolicy({
          profile: "balanced",
          allowedOrigins: ["https://example.test"],
        }),
      ),
      userId: "effect-owner-test",
      environmentId: "test",
      browserContextId: "effect-owner-context",
    });
    try {
      for (const effect of [
        {
          role: "link",
          name: "Credentials",
          markup:
            "<a href=&quot;#credentials&quot; aria-label=&quot;Credentials&quot;>Credentials</a>",
        },
        {
          role: "button",
          name: "Add credential",
          markup: "<button aria-label=&quot;Add credential&quot;>Add credential</button>",
        },
      ] as const) {
        await opened.page
          .setContent(`<button aria-label="Launch" onclick="document.body.insertAdjacentHTML('beforeend',
          '${effect.markup}${effect.markup}')">Launch</button>`);
        const outcome = await new ExecutionKernel().interact({
          request: {
            sessionId: "session",
            operationId: `praxis-effect-owner-${effect.role}`,
            correlationId,
            mode: "rehearse",
            policy,
            mutationIdentity: `praxis-effect-owner-${effect.role}-mutation`,
          },
          capabilities: {
            manifest,
            journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn(), settle: vi.fn() },
            mutationFence: {
              claim: vi.fn(async () => ({ state: "planned", fencingToken: 1 })),
              transition: vi.fn(async () => true),
            },
            options: {
              outputDirectory: "/tmp/praxis-effect-owner",
              onPraxisResult: async (result) => {
                praxisResults.push(result);
              },
              onMutationDispatch: mutationDispatch,
              onExpectedEffectVerification: effectVerification,
            },
          },
          page: opened.page,
          action: {
            type: "click",
            target: target("Launch", "button", ["focusable", "pointer_activatable"]),
            expectedEffect: { type: "none" },
          },
          expectedEffect: {
            type: "visibility_change",
            visible: true,
            target: target(effect.name, effect.role, ["observable"]),
          },
          ordinal: 1,
        });
        expect(outcome.functionalResult, JSON.stringify(outcome)).toBe("succeeded");
        expect(await opened.page.getByRole(effect.role, { name: effect.name }).count()).toBe(2);
      }
      expect(praxisResults).toHaveLength(2);
      for (const result of praxisResults) {
        expect(result).toMatchObject({
          status: "succeeded",
          verification: { effect: "not_required", effectType: "none" },
        });
      }
      expect(mutationDispatch).toHaveBeenCalledTimes(2);
      expect(effectVerification).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
      await opened.context.close();
      await opened.browser.close();
    }
  }, 30_000);

  it("crosses the mutation fence immediately before a direct browser dispatch", async () => {
    const calls: string[] = [];
    const outcome = await executeInteractionCompatibility({
      sessionId: "session",
      operationId: "direct-keypress",
      page: {
        keyboard: {
          press: vi.fn(async () => {
            calls.push("browser");
          }),
        },
      } as never,
      action: { type: "press", key: "Enter" },
      ordinal: 1,
      policy,
      options: {
        outputDirectory: "/tmp/unused",
        onMutationDispatch: async () => {
          calls.push("fence");
        },
      },
    });

    expect(calls).toEqual(["fence", "browser"]);
    expect(outcome).toMatchObject({
      functionalResult: "succeeded",
      mutationOutcome: "applied",
    });
  });

  it("projects bounded semantic target evidence for native-resolved controls", async () => {
    const outcome = await executeInteractionCompatibility({
      sessionId: "session", operationId: "native-observation", page: {} as never,
      action: { type: "waitFor", target: target("Account", "region", ["observable"]), state: "visible", timeoutMs: 1_000 },
      ordinal: 1, policy,
      options: { outputDirectory: "/tmp/unused" },
    });

    expect(outcome.resolvedTarget).toMatchObject({
      version: 2, concept: "Account", scopeKind: "page", structuralPath: [],
    });
    expect(outcome.mutationOutcome).toBe("not_applied");
    expect(JSON.stringify(outcome.resolvedTarget).length).toBeLessThan(500);
  });

  it("classifies a Praxis scheduling refusal as proven pre-dispatch", () => {
    expect(isProvenPreDispatchFailure("PRAXIS_VEIL_SCHEDULE_REFUSED")).toBe(true);
    expect(isProvenPreDispatchFailure("PRAXIS_VEIL_INTERACT_REFUSED")).toBe(false);
  });

  it("requires a durable idempotency identity for mutating plans", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "transact", correlationId });
    const begin = vi.fn(async () => undefined);
    const kernel = new ExecutionKernel();
    await expect(
      kernel.execute({
        request: {
          sessionId: "session",
          operationId: "mutation-without-identity",
          correlationId,
          mode: "transact",
          plan: plan({ type: "fill", target: target(), value: "public-value" }),
          policy,
          capabilityManifestDigest: manifest.digest,
        },
        capabilities: {
          manifest,
          journal: { begin, complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_MUTATION_IDENTITY_REQUIRED" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("routes protected authoring interactions through the full kernel executor", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "transact", correlationId });
    const report = {
      ...reportFixture(),
      state: "passed" as const,
      outcomeClassification: "confirmed_success" as const,
      diagnostics: [],
      steps: [],
    };
    const dispatch = vi.fn(async () => report);
    let mutationState = "planned";
    const protectedInteraction = {
      ...protectedAction(),
      continuation: {
        strategies: [
          {
            mode: "resume_parked_context" as const,
            reentryUrl: "https://example.test",
            assertions: [{ type: "visible" as const, target: target() }],
            continueAtStepId: "after-protected",
          },
        ],
      },
    };
    const safeSession = {
      browser: {} as never,
      context: {} as never,
      page: {} as never,
      provenance: {} as never,
    };
    const outcome = await new ExecutionKernel(dispatch as never).interact({
      request: {
        sessionId: "adaptive-session",
        operationId: "protected-interaction",
        correlationId,
        mode: "transact",
        policy,
        mutationIdentity: "protected-interaction-mutation",
      },
      capabilities: {
        manifest,
        journal: {
          begin: vi.fn(async () => undefined),
          complete: vi.fn(async () => undefined),
          fail: vi.fn(async () => undefined),
          settle: vi.fn(async () => undefined),
        },
        mutationFence: {
          claim: vi.fn(async () => ({ state: mutationState, fencingToken: 1 })),
          transition: vi.fn(async ({ expected, next }) => {
            if (mutationState !== expected) return false;
            mutationState = next;
            return true;
          }),
        },
        options: { outputDirectory: "/tmp/unused" },
      },
      page: {} as never,
      safeSession,
      action: protectedInteraction,
      expectedEffect: { type: "none" },
      ordinal: 1,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    const dispatchedOptions = (
      dispatch.mock.calls as unknown as Array<
        [
          {
            plan: { steps: Array<{ id: string }> };
            existingSafeSession?: unknown;
          },
        ]
      >
    )[0]![0];
    const dispatchedPlan = dispatchedOptions.plan;
    expect(dispatchedOptions).toMatchObject({ existingSafeSession: safeSession });
    expect(dispatchedPlan.steps.map((step) => step.id)).toEqual([
      "kernel-interaction",
      "after-protected",
    ]);
    expect(outcome.functionalResult).toBe("succeeded");
  });

  it("preserves protected failure telemetry without treating it as mutation authority", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "transact", correlationId });
    const dispatch = vi.fn(async (options: { onEvent?: (event: unknown) => Promise<void> }) => {
      await options.onEvent?.({
        type: "privacy.operation_completed",
        payload: {
          result: {
            mutation: { outcome: "not_attempted" },
            reasonCode: "ACQUISITION_NOT_READY",
          },
        },
      });
      return reportFixture();
    });
    const outcome = await new ExecutionKernel(dispatch as never).execute({
      request: {
        sessionId: "adaptive-session",
        operationId: "protected-failure",
        correlationId,
        mode: "transact",
        plan: plan(protectedAction()),
        policy,
        capabilityManifestDigest: manifest.digest,
        idempotencyKey: "protected-failure-idempotency",
        mutationIdentity: "protected-failure-mutation",
      },
      capabilities: {
        manifest,
        journal: {
          begin: vi.fn(async () => undefined),
          complete: vi.fn(async () => undefined),
          fail: vi.fn(async () => undefined),
          settle: vi.fn(async () => undefined),
        },
        mutationFence: {
          claim: vi.fn(async () => ({ state: "planned", fencingToken: 1 })),
          transition: vi.fn(async () => true),
        },
        options: { outputDirectory: "/tmp/unused" },
      },
    });

    expect(outcome.outcome).toMatchObject({
      functionalResult: "failed",
      mutationOutcome: "not_applied",
      reasonCode: "ACQUISITION_NOT_READY",
    });
  });

  it("keeps protected completion events as telemetry rather than outcome authority", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "transact", correlationId });
    const credentialId = randomUUID();
    const valueId = randomUUID();
    const dispatch = vi.fn(
      async (options: {
        onEvent?: (event: unknown) => Promise<void>;
        onMutationDispatch?: () => Promise<void>;
      }) => {
        await options.onMutationDispatch?.();
        await options.onEvent?.({
          type: "privacy.operation_completed",
          payload: {
            result: {
              mutation: { outcome: "confirmed_succeeded" },
              credentialReferences: { clientSecret: credentialId },
              publicValueReferences: { clientId: valueId },
            },
          },
        });
        return reportFixture();
      },
    );
    const outcome = (
      await new ExecutionKernel(dispatch as never).execute({
        request: {
          sessionId: "adaptive-session",
          operationId: "protected-output",
          correlationId,
          mode: "transact",
          plan: plan(protectedAction()),
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "protected-output-idempotency",
          mutationIdentity: "protected-output-mutation",
        },
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn(), settle: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      })
    ).outcome;
    expect(outcome.generatedReferences).toBeUndefined();
    expect(outcome.mutationOutcome).toBe("unknown");
    expect(JSON.stringify(outcome)).not.toMatch(
      /plaintext|selector|runtimeId|fingerprint|handle|outerHTML/i,
    );
  });

  it.each([
    "TARGET_NOT_FOUND",
    "TARGET_AMBIGUOUS",
    "NO_CAPABILITY_COMPATIBLE_CONTROL",
    "STALE_OBSERVATION",
    "CAPABILITY_ADMISSION_DENIED",
    "POLICY_DENIED",
    "UNSEEN_FUTURE_RESOLUTION_REJECTION",
  ])("classifies admitted %s failures as proven not-applied", async (reasonCode) => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "run", correlationId });
    const settle = vi.fn();
    const transition = vi.fn(async () => true);
    const kernel = new ExecutionKernel(
      vi.fn(async () => {
        throw new Error(reasonCode);
      }) as never,
    );

    await expect(
      kernel.execute({
        request: {
          sessionId: "mission-authoring-session",
          operationId: `pre-dispatch-${reasonCode}`,
          correlationId,
          mode: "run",
          plan: plan({
            type: "click",
            target: target("Submit", "button", ["pointer_activatable"]),
          }),
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: `pre-dispatch-${reasonCode}`,
          mutationIdentity: `pre-dispatch-${reasonCode}`,
        },
        capabilities: {
          manifest,
          journal: {
            begin: vi.fn(async () => undefined),
            complete: vi.fn(async () => undefined),
            fail: vi.fn(async () => undefined),
            settle,
          },
          mutationFence: {
            claim: vi.fn(async () => ({ state: "planned", fencingToken: 1 })),
            transition,
          },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toThrow(reasonCode);

    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ expected: "planned", next: "dispatching" }),
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode,
        outcome: expect.objectContaining({ mutationOutcome: "not_applied" }),
      }),
    );
  });

  it("binds manifest mode and correlation identity before journal admission", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "run", correlationId });
    const begin = vi.fn();
    await expect(
      new ExecutionKernel().execute({
        request: {
          sessionId: "session",
          operationId: "binding-mismatch",
          correlationId: randomUUID(),
          mode: "run",
          plan: plan({ type: "navigate", url: "https://example.test" }),
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "binding-mismatch-request",
        },
        capabilities: {
          manifest,
          journal: { begin, complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CAPABILITY_BINDING_MISMATCH" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("rejects a policy-denied capability required by a protected plan before dispatch", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({
      mode: "run",
      correlationId,
      states: { protected_operations: "policy_denied" },
    });
    const dispatch = vi.fn();
    const begin = vi.fn();
    const protectedPlan = currentPlanSchema.parse({
      ...plan({ type: "navigate", url: "https://example.test" }),
      steps: [
        {
          id: "protected",
          title: "Protected",
          action: protectedAction(),
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "transient",
          transientJustification: "Admission test does not execute the transaction.",
        },
      ],
    });
    await expect(
      new ExecutionKernel(dispatch as never).execute({
        request: {
          sessionId: "session",
          operationId: "protected-denied",
          correlationId,
          mode: "run",
          plan: protectedPlan,
          policy,
          capabilityManifestDigest: manifest.digest,
          idempotencyKey: "protected-denied-request",
          mutationIdentity: "protected-denied-mutation",
        },
        capabilities: {
          manifest,
          journal: { begin, complete: vi.fn(), fail: vi.fn() },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_CAPABILITY_INCOMPLETE",
      missingCapabilities: ["protected_operations"],
    });
    expect(begin).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists unknown after a worker loss around a real mutating plan and fences retry", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "run", correlationId });
    const dispatch = vi.fn(async (options: { onMutationDispatch?: () => Promise<void> }) => {
      await options.onMutationDispatch?.();
      throw new Error("WORKER_PROCESS_LOST_AFTER_DISPATCH");
    });
    const states = new Map<string, string>();
    const mutationFence = {
      claim: vi.fn(async ({ mutationIdentity }: { mutationIdentity: string }) => ({
        state: states.get(mutationIdentity) ?? "planned",
        fencingToken: 1,
      })),
      transition: vi.fn(
        async (input: { mutationIdentity: string; expected: string; next: string }) => {
          const current = states.get(input.mutationIdentity) ?? "planned";
          if (current !== input.expected) return false;
          states.set(input.mutationIdentity, input.next);
          return true;
        },
      ),
    };
    const fail = vi.fn(async () => undefined);
    const settle = vi.fn(
      async (input: { mutation?: { mutationIdentity: string; next: string } }) => {
        if (input.mutation) states.set(input.mutation.mutationIdentity, input.mutation.next);
      },
    );
    const capabilities = {
      manifest,
      mutationFence,
      journal: { begin: vi.fn(async () => undefined), complete: vi.fn(), fail, settle },
      options: { outputDirectory: "/tmp/unused" },
    };
    const request = {
      sessionId: "logical-run",
      operationId: "attempt-one",
      correlationId,
      mode: "run" as const,
      plan: plan({ type: "fill", target: target(), value: "public-value" }),
      policy,
      capabilityManifestDigest: manifest.digest,
      idempotencyKey: "attempt-one-request",
      mutationIdentity: "logical-run-mutation",
    };
    const kernel = new ExecutionKernel(dispatch as never);
    await expect(kernel.execute({ request, capabilities })).rejects.toThrow(
      "WORKER_PROCESS_LOST_AFTER_DISPATCH",
    );
    expect(states.get("logical-run-mutation")).toBe("outcome_unknown");
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({ mutationOutcome: "unknown" }),
      }),
    );

    await expect(
      kernel.execute({
        request: { ...request, operationId: "attempt-two", idempotencyKey: "attempt-two-request" },
        capabilities,
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not redispatch an action whose browser call failed after possible mutation", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "rehearse", correlationId });
    const states = new Map<string, string>();
    const press = vi.fn(async () => {
      throw new Error("WORKER_PROCESS_LOST_AFTER_DISPATCH");
    });
    const page = { url: () => "https://example.test", keyboard: { press } } as never;
    const capabilities = {
      manifest,
      mutationFence: {
        claim: async ({ mutationIdentity }: { mutationIdentity: string }) => ({
          state: states.get(mutationIdentity) ?? "planned",
          fencingToken: 1,
        }),
        transition: async (input: { mutationIdentity: string; expected: string; next: string }) => {
          const current = states.get(input.mutationIdentity) ?? "planned";
          if (current !== input.expected) return false;
          states.set(input.mutationIdentity, input.next);
          return true;
        },
      },
      journal: {
        begin: vi.fn(async () => undefined),
        complete: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        settle: vi.fn(async (input: { mutation?: { mutationIdentity: string; next: string } }) => {
          if (input.mutation) states.set(input.mutation.mutationIdentity, input.mutation.next);
        }),
      },
      options: { outputDirectory: "/tmp/unused" },
    };
    const kernel = new ExecutionKernel();
    const request = {
      sessionId: "authoring-session",
      operationId: "command-one",
      correlationId,
      mode: "rehearse" as const,
      policy,
      mutationIdentity: "stable-authoring-mutation",
    };
    await expect(
      kernel.interact({
        request,
        capabilities,
        page,
        action: { type: "press", key: "Enter" },
        ordinal: 1,
      }),
    ).resolves.toMatchObject({ functionalResult: "failed", mutationOutcome: "unknown" });
    expect(states.get("stable-authoring-mutation")).toBe("outcome_unknown");

    await expect(
      kernel.interact({
        request: { ...request, operationId: "command-two" },
        capabilities,
        page,
        action: { type: "press", key: "Enter" },
        ordinal: 1,
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
    });
    expect(press).toHaveBeenCalledOnce();
  });

  it("maps quarantined and failed evidence facts without claiming verified privacy", () => {
    const report = reportFixture();
    expect(privacyOutcomeFromReport(report)).toBe("sealed");
    expect(evidenceOutcomeFromReport(report)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "screenshot", state: "failed" }),
        expect.objectContaining({ channel: "trace", state: "quarantined" }),
      ]),
    );
  });

  it("does not claim privacy verification when a successful report has no privacy proof", () => {
    const report = {
      ...reportFixture(),
      state: "passed" as const,
      outcomeClassification: "passed" as const,
      steps: [],
      artifacts: [],
      artifactTimeline: [],
    };
    expect(privacyOutcomeFromReport(report)).toBe("unverified");
    expect(evidenceOutcomeFromReport(report)).toEqual([]);
  });

  it("classifies capture failure independently from functional and quarantine outcomes", () => {
    const report = {
      ...reportFixture(),
      state: "passed" as const,
      outcomeClassification: "passed" as const,
      artifacts: [],
      artifactTimeline: [],
    };
    expect(privacyOutcomeFromReport(report)).toBe("degraded");
    expect(evidenceOutcomeFromReport(report)).toEqual([
      expect.objectContaining({ channel: "screenshot", state: "failed" }),
    ]);
  });

  it("settles a journal failure and mutation fence to one authoritative unknown state", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "run", correlationId });
    let mutationState = "planned";
    let operationState = "admitted";
    let settlementAttempt = 0;
    const settle = vi.fn(async (input: { state: string; mutation?: { next: string } }) => {
      settlementAttempt += 1;
      if (settlementAttempt === 1) throw new Error("JOURNAL_WRITE_FAILED");
      mutationState = input.mutation?.next ?? mutationState;
      operationState = input.state;
    });
    const kernel = new ExecutionKernel(async (options) => {
      await options.onMutationDispatch?.();
      return {
        ...reportFixture(),
        state: "passed",
        outcomeClassification: "passed",
        steps: [],
        artifacts: [],
        artifactTimeline: [],
      };
    });
    const request = {
      sessionId: "atomic-session",
      operationId: "atomic-attempt",
      correlationId,
      mode: "run" as const,
      plan: plan({ type: "fill", target: target(), value: "public-value" }),
      policy,
      capabilityManifestDigest: manifest.digest,
      idempotencyKey: "atomic-attempt-request",
      mutationIdentity: "atomic-logical-mutation",
    };
    await expect(
      kernel.execute({
        request,
        capabilities: {
          manifest,
          journal: { begin: vi.fn(), complete: vi.fn(), fail: vi.fn(), settle },
          mutationFence: {
            claim: async () => ({ state: mutationState, fencingToken: 1 }),
            transition: async ({ expected, next }) => {
              if (mutationState !== expected) return false;
              mutationState = next;
              return true;
            },
          },
          options: { outputDirectory: "/tmp/unused" },
        },
      }),
    ).rejects.toThrow("JOURNAL_WRITE_FAILED");
    expect(settle).toHaveBeenCalledTimes(2);
    expect(mutationState).toBe("outcome_unknown");
    expect(operationState).toBe("failed");
    expect(settle).not.toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        mutation: expect.objectContaining({ next: "reconciled_succeeded" }),
      }),
    );
  });

  it("retries a proven pre-dispatch target change under a stable logical mutation identity", async () => {
    const correlationId = randomUUID();
    const manifest = createExecutionCapabilityManifest({ mode: "run", correlationId });
    let mutationState = "planned";
    let fencingToken = 1;
    const operationIds: string[] = [];
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("PRAXIS_TARGET_CHANGED_BEFORE_ACTION"))
      .mockResolvedValueOnce({
        ...reportFixture(),
        state: "passed",
        outcomeClassification: "passed",
        steps: [],
        artifacts: [],
        artifactTimeline: [],
      });
    const capabilities = {
      manifest,
      journal: {
        begin: vi.fn(async ({ request }: { request: { operationId: string } }) => {
          operationIds.push(request.operationId);
        }),
        complete: vi.fn(),
        fail: vi.fn(),
        settle: vi.fn(async (input: { mutation?: { next: string } }) => {
          if (input.mutation) mutationState = input.mutation.next;
        }),
      },
      mutationFence: {
        claim: vi.fn(async () => {
          if (mutationState === "reconciled_not_applied") {
            mutationState = "planned";
            fencingToken += 1;
          }
          return { state: mutationState, fencingToken };
        }),
        transition: vi.fn(async ({ expected, next }: { expected: string; next: string }) => {
          if (mutationState !== expected) return false;
          mutationState = next;
          return true;
        }),
      },
      options: { outputDirectory: "/tmp/unused" },
    };
    const request = {
      sessionId: "retry-session",
      operationId: "logical-operation-attempt-1",
      correlationId,
      mode: "run" as const,
      plan: plan({ type: "fill", target: target(), value: "public-value" }),
      policy,
      capabilityManifestDigest: manifest.digest,
      idempotencyKey: "retry-attempt-1",
      mutationIdentity: "stable-logical-mutation",
    };
    const kernel = new ExecutionKernel(dispatch as never);
    await expect(kernel.execute({ request, capabilities })).rejects.toThrow(
      "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
    );
    expect(mutationState).toBe("reconciled_not_applied");
    await expect(
      kernel.execute({
        request: {
          ...request,
          operationId: "logical-operation-attempt-2",
          idempotencyKey: "retry-attempt-2",
        },
        capabilities,
      }),
    ).resolves.toMatchObject({ outcome: { mutationOutcome: "not_applied" } });
    expect(operationIds).toEqual(["logical-operation-attempt-1", "logical-operation-attempt-2"]);
    expect(capabilities.mutationFence.claim).toHaveBeenCalledTimes(2);
    expect(mutationState).toBe("reconciled_not_applied");
  });
});

function protectedAction() {
  const button = target("Issue", "button", ["pointer_activatable"]);
  const value = target("Secret", "value", ["readable_value"]);
  return {
    type: "protectedTransaction" as const,
    operationId: "protected-operation",
    entry: {
      url: "https://example.test",
      assertions: [{ type: "visible" as const, target: button }],
    },
    inputs: {},
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [
        {
          type: "assertion" as const,
          assertion: { type: "visible" as const, target: button },
          effect: "read_only" as const,
        },
      ],
      assertions: [{ type: "enabled" as const, target: button }],
    },
    mutation: {
      kind: "one_time" as const,
      action: {
        type: "click" as const,
        target: button,
        expectedEffect: { type: "new_region" as const, target: value },
      },
      reconciliation: { strategy: "none" as const, acceptUnknownOutcome: true },
    },
    extraction: {
      outputs: [
        {
          classification: "protected" as const,
          reference: "issued-secret",
          acquisition: {
            target: value,
            classification: "unknown_secret" as const,
            permittedMethods: ["semantic_field_value" as const],
            validation: { minimumLength: 1, maximumLength: 20_000 },
          },
          storage: { scope: "run" as const, credentialName: "Issued secret" },
        },
      ],
      timeoutMs: 1_000,
      scheduling: "fair_shared_timeout" as const,
    },
    acquisitionReadiness: {
      ceremonyIntent: button,
      expectedContainerModel: {
        version: 2 as const,
        digest: "a".repeat(64),
        concept: "Issue",
        scopeKind: "page" as const,
        capabilityDigest: "b".repeat(64),
        structuralPath: [],
      },
      valueIntent: value,
      approvedMethods: ["semantic_field_value" as const],
      minimumConfidence: 0.6,
      minimumConfidenceMargin: 0,
      recoveryPolicy: "abandon" as const,
      recoveryWindowMs: 1_000,
    },
    continuation: { strategies: [{ mode: "terminal" as const }] },
  };
}

function reportFixture(): import("../src/types.js").ExecutionReport {
  const now = new Date().toISOString();
  return {
    runId: "run",
    attemptId: "attempt",
    planName: "Evidence mapping",
    state: "failed",
    outcomeClassification: "confirmed_product_failure",
    startedAt: now,
    completedAt: now,
    durationMs: 1,
    requiredAssertions: { passed: 0, failed: 1, unevaluated: 0 },
    diagnostics: [],
    policyViolations: [],
    steps: [
      {
        id: "step",
        title: "Step",
        status: "failed",
        action: { status: "failed" },
        assertions: [],
        artifacts: [],
        evidence: [],
        evidenceFailures: [{ kind: "screenshot", error: "SCREENSHOT_CAPTURE_FAILED" }],
      },
    ],
    artifacts: [
      {
        id: "trace",
        kind: "trace",
        availability: "quarantined",
        privacyClassification: "uncertain",
        contentType: "application/zip",
        reasonCode: "TRACE_CLASSIFICATION_UNPROVEN",
      },
    ],
    artifactTimeline: [],
  };
}

function plan(action: Record<string, unknown>) {
  return currentPlanSchema.parse({
    name: "Kernel test",
    objective: "Prove admission",
    preconditions: [],
    allowedOrigins: ["https://example.test"],
    budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "operation",
        title: "Operation",
        action,
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "final",
      },
    ],
  });
}

function target(
  concept = "Email",
  role: import("@scry/contracts").InteractionTargetIntent["preferredEvidence"]["roles"][number] = "textbox",
  requiredCapabilities: import("@scry/contracts").InteractionTargetIntent["requiredCapabilities"] = [
    "accepts_text",
    "focusable",
    "editable",
  ],
): import("@scry/contracts").InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities,
    preferredEvidence: {
      roles: [role],
      names: [concept],
      labels: [concept],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "ordinary",
    confidence: {
      requiredFamilies: [],
      minimum: 0.35,
      minimumMargin: 0,
      minimumFamilyCount: 1,
    },
  };
}
