import { randomUUID } from "node:crypto";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { ExecutionCapabilityFactory, ExecutionKernelService } from "../src/runtime/index.js";

describe("execution capability factory", () => {
  it("supplies the complete protected and recovery infrastructure to rehearse", () => {
    const kernelRepository = {
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      settle: vi.fn(),
      appendEvent: vi.fn(),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(),
      claimMutation: vi.fn(),
      transitionMutation: vi.fn(),
      recordMutation: vi.fn(),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never);
    const capabilities = factory.createSession({
      sessionId: "probe-session",
      operationId: "probe-operation",
      correlationId: randomUUID(),
      mode: "rehearse",
      options: {
        outputDirectory: "/tmp/probe",
        browserChannel: "chrome",
        environmentId: "environment",
        veilAdmissionKey: "test-key",
        veilPolicySnapshot: {} as never,
        secretResolver: vi.fn(),
      },
    });
    expect(capabilities.options.protectedTransactionStore).toBeDefined();
    expect(capabilities.options.checkpointStore).toBeDefined();
    expect(capabilities.options.atomicSecretCapture).toBeDefined();
    expect(capabilities.options.publicValueCapture).toBeDefined();
    expect(capabilities.compatibilityOptions?.protectedTransactionStore).toBeDefined();
    for (const name of [
      "browser",
      "praxis",
      "veil",
      "evidence",
      "journal",
      "protected_operations",
      "checkpoint",
    ] as const) {
      expect(capabilities.manifest.capabilities[name].state).toBe("available");
    }
    expect(capabilities.manifest.capabilities.calibration.state).toBe("unavailable");
  });

  it("keeps compatibility events outside the kernel journal wrapper", async () => {
    const originalEvent = vi.fn(async () => undefined);
    const kernelRepository = {
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      appendEvent: vi.fn(async () => undefined),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(),
      claimMutation: vi.fn(),
      transitionMutation: vi.fn(),
      recordMutation: vi.fn(),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never);
    const capabilities = factory.createSession({
      sessionId: "compatibility-session",
      operationId: "compatibility-operation",
      correlationId: randomUUID(),
      mode: "run",
      options: { outputDirectory: "/tmp/compatibility", onEvent: originalEvent },
    });
    const event = {
      sequence: 1,
      runId: "run",
      attemptId: "attempt",
      type: "attempt.started" as const,
      occurredAt: new Date().toISOString(),
      payload: {},
    };

    await capabilities.compatibilityOptions?.onEvent?.(event);
    expect(originalEvent).toHaveBeenCalledOnce();
    expect(kernelRepository.appendEvent).not.toHaveBeenCalled();

    await capabilities.options.onEvent?.(event);
    expect(originalEvent).toHaveBeenCalledTimes(2);
    expect(kernelRepository.appendEvent).toHaveBeenCalledOnce();
  });

  it("journals protected child phases under the admitted parent operation", async () => {
    const kernelRepository = {
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      appendEvent: vi.fn(async () => undefined),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(),
      claimMutation: vi.fn(),
      transitionMutation: vi.fn(),
      recordMutation: vi.fn(async () => undefined),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never);
    const capabilities = factory.createSession({
      sessionId: "probe-session",
      operationId: "probe-parent-operation",
      correlationId: randomUUID(),
      mode: "transact",
      options: { outputDirectory: "/tmp/probe" },
    });
    await capabilities.options.protectedTransactionStore?.record({
      operationId: "protected-child-operation",
      fencingToken: 1,
      phase: "mutation_dispatching",
      facts: { safe: true },
    });
    expect(kernelRepository.recordMutation).toHaveBeenCalledWith(
      "probe-session",
      "probe-parent-operation",
      expect.objectContaining({ operationId: "protected-child-operation" }),
    );
  });

  it("fails closed when a generated public value is missing", async () => {
    const kernelRepository = {
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      appendEvent: vi.fn(),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(async () => undefined),
      claimMutation: vi.fn(),
      transitionMutation: vi.fn(),
      recordMutation: vi.fn(),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never);
    const capabilities = factory.createSession({
      sessionId: "session",
      operationId: "operation",
      correlationId: randomUUID(),
      mode: "run",
      options: { outputDirectory: "/tmp/run" },
    });
    await expect(capabilities.options.publicValueResolver?.("missing-value")).rejects.toThrow(
      "GENERATED_PUBLIC_VALUE_UNAVAILABLE",
    );
  });

  it("requires a project-owned persistence authority for durable captured values", async () => {
    const kernelRepository = {
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      appendEvent: vi.fn(),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(),
      claimMutation: vi.fn(),
      transitionMutation: vi.fn(),
      recordMutation: vi.fn(),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never);
    const capabilities = factory.createSession({
      sessionId: "session",
      operationId: "operation",
      correlationId: randomUUID(),
      mode: "transact",
      options: { outputDirectory: "/tmp/run" },
    });
    expect(() =>
      capabilities.options.atomicSecretCapture?.({
        operationId: "capture",
        reference: "secret",
        name: "Secret",
        value: "protected",
        scope: "project",
      }),
    ).toThrow("PROJECT_SECRET_PERSISTENCE_AUTHORITY_REQUIRED");
    expect(kernelRepository.persistSecret).not.toHaveBeenCalled();
  });

  it("rejects certification admission before dispatch when no calibration verifier exists", async () => {
    const kernelRepository = {
      begin: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      settle: vi.fn(),
      appendEvent: vi.fn(),
      persistSecret: vi.fn(),
      persistPublicValue: vi.fn(),
      resolvePublicValue: vi.fn(),
      claimMutation: vi.fn(),
      transitionMutation: vi.fn(),
      recordMutation: vi.fn(),
      establishCheckpoint: vi.fn(),
      claimCheckpoint: vi.fn(),
      completeCheckpoint: vi.fn(),
      recordContextProvenance: vi.fn(),
    };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never);
    const correlationId = randomUUID();
    const capabilities = factory.createSession({
      sessionId: "certification-session",
      operationId: "certification-operation",
      correlationId,
      mode: "certify",
      options: {
        outputDirectory: "/tmp/certification",
        browserChannel: "chrome",
        environmentId: "environment",
        veilAdmissionKey: "test-key",
        veilPolicySnapshot: {} as never,
      },
    });
    expect(capabilities.manifest.capabilities.calibration.state).toBe("unavailable");
    const dispatch = vi.fn();
    const plan = currentPlanSchema.parse({
      name: "Certification admission",
      objective: "Reject before browser startup",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 1_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "navigate",
          title: "Navigate",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const policy = executionPolicySchema.parse({
      allowedOrigins: ["https://example.test"],
      allowPrivateNetwork: false,
    });
    const request = factory.request({
      sessionId: "certification-session",
      operationId: "certification-operation",
      correlationId,
      mode: "certify",
      plan,
      policy,
      capabilities,
      idempotencyKey: "certification-operation",
    });
    await expect(
      new ExecutionKernelService(dispatch as never).execute({ request, capabilities }),
    ).rejects.toMatchObject({
      code: "EXECUTION_CAPABILITY_INCOMPLETE",
      missingCapabilities: ["calibration"],
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(kernelRepository.begin).not.toHaveBeenCalled();
  });
});
