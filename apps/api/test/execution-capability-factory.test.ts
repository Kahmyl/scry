import { randomUUID } from "node:crypto";

import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { describe, expect, it, vi } from "vitest";

import { ExecutionCapabilityFactory, ExecutionKernelService } from "../src/runtime/index.js";

describe("execution capability factory", () => {
  it("claims the authoring reservation without creating it lazily", async () => {
    const kernelRepository = { appendEvent: vi.fn(), establishCheckpoint: vi.fn(), claimCheckpoint: vi.fn(), completeCheckpoint: vi.fn(), recordContextProvenance: vi.fn() };
    const protectedOperations = {
      create: vi.fn(async () => undefined),
      claim: vi.fn(async () => ({ id: randomUUID(), state: "planned", version: 2, fencingToken: 1, persistedReferences: {} })),
      transition: vi.fn(), record: vi.fn(), heartbeat: vi.fn(),
    };
    const protectedOutputs = { persistOutputsAtomically: vi.fn(), markCommittedCredentialsCompromised: vi.fn() };
    const factory = new ExecutionCapabilityFactory({} as never, kernelRepository as never, { openBrowser: vi.fn() } as never, protectedOperations as never, protectedOutputs as never);
    const capabilities = factory.createMissionAuthoringSession({
      sessionId: randomUUID(), operationId: "authoring-parent", correlationId: randomUUID(), mode: "transact",
      projectId: randomUUID(), environmentId: randomUUID(), missionId: randomUUID(), objectiveId: randomUUID(),
      agentSessionId: randomUUID(), flowDraftId: randomUUID(), authorizationId: randomUUID(), leaseOwner: "authoring-owner",
      options: { outputDirectory: "/tmp/authoring", browserChannel: "chrome", environmentId: "environment", veilAdmissionKey: "test-key", veilPolicySnapshot: {} as never, secretResolver: vi.fn() },
    });
    expect(capabilities.options.protectedTransactionStore).toBeDefined();
    expect(capabilities.options.atomicOutputCapture).toBeDefined();
    expect(capabilities.manifest.capabilities.protected_operations.state).toBe("available");
    expect(capabilities.manifest.capabilities.protected_input.state).toBe("available");
    await capabilities.options.protectedTransactionStore!.claim({ operationId: "generate", mutationKind: "one_time", mutationIdentity: "generate-once", programDigest: "a".repeat(64), inputSchemaDigest: "b".repeat(64), inputDigest: "c".repeat(64), safeOutputManifest: [{ reference: "secret", classification: "protected", storageName: "Secret" }] });
    expect(protectedOperations.create).not.toHaveBeenCalled();
    expect(protectedOperations.claim).toHaveBeenCalledOnce();
    expect(protectedOperations.claim).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({
        mutationIdentity: "generate-once",
        programDigest: "a".repeat(64),
        safeOutputManifest: [{ reference: "secret", classification: "protected", storageName: "Secret" }],
      }),
    }));
    await capabilities.options.protectedTransactionStore!.record({
      operationId: "generate",
      fencingToken: 1,
      phase: "preparation_rejected",
      facts: {
        preparationEffects: [{
          method: "POST",
          origin: "https://telemetry.example.test",
          path: "/events",
          disposition: "blocked",
        }],
      },
    });
    expect(protectedOperations.record).toHaveBeenCalledWith(expect.objectContaining({
      safeDiagnostics: {
        preparationEffects: [{
          method: "POST",
          origin: "https://telemetry.example.test",
          path: "/events",
          disposition: "blocked",
        }],
      },
    }));
  });

  it("preserves lazy reservation for synchronous run-owned protected execution", async () => {
    const executions = { resolveCredential: vi.fn(), captureCredential: vi.fn(), persistCapturedSecret: vi.fn(), persistGeneratedPublicValue: vi.fn(), resolveGeneratedPublicValue: vi.fn(), establishCheckpoint: vi.fn(), claimCheckpoint: vi.fn(), completeCheckpoint: vi.fn(), verifyCalibrationAttestation: vi.fn() };
    const kernelRepository = { appendEvent: vi.fn(), establishCheckpoint: vi.fn(), claimCheckpoint: vi.fn(), completeCheckpoint: vi.fn(), recordContextProvenance: vi.fn() };
    const protectedOperations = {
      create: vi.fn(async () => undefined),
      claim: vi.fn(async () => ({ id: randomUUID(), state: "planned", version: 2, fencingToken: 1, persistedReferences: {} })),
      transition: vi.fn(), record: vi.fn(), heartbeat: vi.fn(),
    };
    const protectedOutputs = { persistOutputsAtomically: vi.fn(), markCommittedCredentialsCompromised: vi.fn() };
    const factory = new ExecutionCapabilityFactory(executions as never, kernelRepository as never, { openBrowser: vi.fn() } as never, protectedOperations as never, protectedOutputs as never);
    const capabilities = factory.createRun({
      sessionId: randomUUID(), operationId: "run-parent", correlationId: randomUUID(), mode: "transact",
      runId: randomUUID(), attemptId: randomUUID(), claimToken: "run-owner", flowRevisionId: randomUUID(),
      environmentId: randomUUID(), projectId: randomUUID(), missionId: randomUUID(), objectiveId: randomUUID(), agentSessionId: randomUUID(),
      options: { outputDirectory: "/tmp/run", browserChannel: "chrome", environmentId: "environment", veilAdmissionKey: "test-key", veilPolicySnapshot: {} as never },
    });
    await capabilities.options.protectedTransactionStore!.claim({
      operationId: "run-generate", mutationKind: "one_time", mutationIdentity: "run-generate-once",
      programDigest: "a".repeat(64), inputSchemaDigest: "b".repeat(64), inputDigest: "c".repeat(64),
      safeOutputManifest: [{ reference: "secret", classification: "protected", storageName: "Secret" }],
    });
    expect(protectedOperations.create).toHaveBeenCalledOnce();
    expect(protectedOperations.claim).toHaveBeenCalledOnce();
  });

  it("keeps project protected-output authority out of generic sessions", () => {
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
    expect(capabilities.options.protectedTransactionStore).toBeUndefined();
    expect(capabilities.options.checkpointStore).toBeDefined();
    expect(capabilities.options.atomicSecretCapture).toBeDefined();
    expect(capabilities.options.publicValueCapture).toBeDefined();
    expect(capabilities.compatibilityOptions?.protectedTransactionStore).toBeUndefined();
    for (const name of [
      "browser",
      "praxis",
      "veil",
      "evidence",
      "journal",
      "checkpoint",
    ] as const) {
      expect(capabilities.manifest.capabilities[name].state).toBe("available");
    }
    expect(capabilities.manifest.capabilities.protected_operations.state).toBe("unavailable");
    expect(capabilities.manifest.capabilities.protected_input.state).toBe("available");
    expect(capabilities.manifest.capabilities.calibration.state).toBe("unavailable");
  });

  it("keeps protected input unavailable without a secret resolver", () => {
    const factory = new ExecutionCapabilityFactory({} as never, {
      appendEvent: vi.fn(), establishCheckpoint: vi.fn(), claimCheckpoint: vi.fn(), completeCheckpoint: vi.fn(),
      persistSecret: vi.fn(), persistPublicValue: vi.fn(), resolvePublicValue: vi.fn(), claimMutation: vi.fn(),
      transitionMutation: vi.fn(), recordMutation: vi.fn(), recordContextProvenance: vi.fn(),
    } as never, { openBrowser: vi.fn() } as never);
    const capabilities = factory.createSession({ sessionId: "no-secret", operationId: "operation",
      correlationId: randomUUID(), mode: "run", options: { outputDirectory: "/tmp/no-secret", browserChannel: "chrome",
        environmentId: "environment", veilAdmissionKey: "test-key", veilPolicySnapshot: {} as never } });
    expect(capabilities.manifest.capabilities.protected_input.state).toBe("unavailable");
    const withoutVeil = factory.createSession({ sessionId: "no-veil", operationId: "operation",
      correlationId: randomUUID(), mode: "run", options: { outputDirectory: "/tmp/no-veil", browserChannel: "chrome",
        environmentId: "environment", secretResolver: vi.fn() } });
    expect(withoutVeil.manifest.capabilities.protected_input.state).toBe("unavailable");
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

  it("does not expose the legacy child mutation ledger from a generic session", async () => {
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
    expect(capabilities.options.protectedTransactionStore).toBeUndefined();
    expect(kernelRepository.recordMutation).not.toHaveBeenCalled();
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
