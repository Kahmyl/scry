import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionCapabilityManifest } from "@scry/executor";
import { compileDefaultVeilPolicy } from "@scry/veil";

import {
  createCalibrationProcessor,
  createProbeProcessor,
  createPraxisProcessor,
  safeDependencyCode,
  safeWorkerCode,
} from "../src/workers/index.js";
import { createRunProcessor } from "../src/workers/index.js";
import { ExecutionKernelService } from "../src/runtime/index.js";

const identity = {
  workerId: "worker-1",
  releaseId: "release-1",
  schemaFingerprint: "schema-1",
  heartbeatMs: 10,
  browserChannel: "chromium",
  kernel: {} as never,
  capabilities: {} as never,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("worker processor boundaries", () => {
  it("emits a causal worker failure while preserving the original failure path", async () => {
    const failure = new Error("DATABASE_UNAVAILABLE");
    const executions = {
      claimAttempt: vi.fn(async () => ({ id: "attempt-1", attemptNumber: 1 })),
      loadExecution: vi.fn(async () => {
        throw failure;
      }),
      failAttempt: vi.fn(async () => undefined),
    };
    const operationalEvents = {
      emit: vi.fn(async () => {
        throw new Error("TELEMETRY_SINK_UNAVAILABLE");
      }),
    };
    const processor = createRunProcessor({
      ...identity,
      executions: executions as never,
      artifactRoot: "/tmp/scry-worker-test",
      artifactRetentionMs: 60_000,
      artifactStore: {} as never,
      artifactStoreRemote: false,
      veilAdmissionKey: "test-key",
      operationalEvents,
    });

    await expect(
      processor(
        job({ runId: "run-1", releaseId: "release-1", schemaFingerprint: "schema-1" }) as never,
      ),
    ).rejects.toBe(failure);
    expect(executions.failAttempt).toHaveBeenCalledOnce();
    expect(operationalEvents.emit).toHaveBeenCalledWith(
      "worker",
      expect.objectContaining({
        name: "worker.execution_failed",
        classification: "persistence",
        reasonCode: "DATABASE_UNAVAILABLE",
        causality: expect.objectContaining({ runId: "run-1", attemptId: "attempt-1" }),
        transition: { from: "claimed", to: "failed" },
      }),
    );
  });

  it("emits a partially causal refusal and does not fail an unclaimed attempt on release mismatch", async () => {
    const executions = { claimAttempt: vi.fn(), failAttempt: vi.fn() };
    const operationalEvents = { emit: vi.fn(async () => undefined) };
    const processor = createRunProcessor({
      ...identity,
      executions: executions as never,
      artifactRoot: "/tmp/scry-worker-test",
      artifactRetentionMs: 60_000,
      artifactStore: {} as never,
      artifactStoreRemote: false,
      veilAdmissionKey: "test-key",
      operationalEvents,
    });
    await expect(
      processor(job({ runId: "run-1", releaseId: "old", schemaFingerprint: "schema-1" }) as never),
    ).rejects.toThrow("WORKER_RELEASE_MISMATCH");
    expect(executions.claimAttempt).not.toHaveBeenCalled();
    expect(executions.failAttempt).not.toHaveBeenCalled();
    expect(operationalEvents.emit).toHaveBeenCalledWith(
      "worker",
      expect.objectContaining({
        reasonCode: "WORKER_RELEASE_MISMATCH",
        causality: expect.objectContaining({ runId: "run-1", correlationId: expect.any(String) }),
        transition: { from: "queued", to: "failed" },
      }),
    );
  });

  it("emits a partially causal claim failure without inventing or failing an attempt", async () => {
    const failure = new Error("DATABASE_CLAIM_FAILED");
    const executions = {
      claimAttempt: vi.fn(async () => {
        throw failure;
      }),
      failAttempt: vi.fn(),
    };
    const operationalEvents = { emit: vi.fn(async () => undefined) };
    const processor = createRunProcessor({
      ...identity,
      executions: executions as never,
      artifactRoot: "/tmp/scry-worker-test",
      artifactRetentionMs: 60_000,
      artifactStore: {} as never,
      artifactStoreRemote: false,
      veilAdmissionKey: "test-key",
      operationalEvents,
    });

    await expect(
      processor(
        job({ runId: "run-1", releaseId: "release-1", schemaFingerprint: "schema-1" }) as never,
      ),
    ).rejects.toBe(failure);
    expect(executions.failAttempt).not.toHaveBeenCalled();
    expect(operationalEvents.emit).toHaveBeenCalledWith(
      "worker",
      expect.objectContaining({
        classification: "persistence",
        reasonCode: "DATABASE_CLAIM_FAILED",
        causality: expect.objectContaining({ runId: "run-1", correlationId: expect.any(String) }),
        transition: { from: "queued", to: "failed" },
      }),
    );
  });

  it("fences Probe work before claiming when schema metadata differs", async () => {
    const probes = { claim: vi.fn() };
    const processor = createProbeProcessor({
      ...identity,
      probes: probes as never,
      observationRuntimeHash: "runtime",
      veilAdmissionKey: "test-key",
    });
    await expect(
      processor(
        job({
          probeSessionId: "probe-1",
          releaseId: "release-1",
          schemaFingerprint: "old",
        }) as never,
      ),
    ).rejects.toThrow("WORKER_RELEASE_MISMATCH");
    expect(probes.claim).not.toHaveBeenCalled();
  });

  it("fences Calibration work before claiming when release metadata differs", async () => {
    const calibrations = { claim: vi.fn() };
    const processor = createCalibrationProcessor({
      ...identity,
      calibrations: calibrations as never,
      veilAdmissionKey: "test-key",
    });
    await expect(
      processor(
        job({
          calibrationSessionId: "cal-1",
          releaseId: "old",
          schemaFingerprint: "schema-1",
        }) as never,
      ),
    ).rejects.toThrow("WORKER_RELEASE_MISMATCH");
    expect(calibrations.claim).not.toHaveBeenCalled();
  });

  it("fences a logical Run mutation across a worker retry after possible dispatch", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const attempts = [
      { id: "22222222-2222-4222-8222-222222222221", attemptNumber: 1 },
      { id: "22222222-2222-4222-8222-222222222222", attemptNumber: 2 },
    ];
    const executions = {
      claimAttempt: vi.fn(async () => attempts.shift()),
      loadExecution: vi.fn(async () => ({
        flowRevisionId: "flow-revision",
        environmentId: "environment",
        planSnapshot: mutatingRunPlan(),
        policySnapshot: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false },
        veilPolicySnapshot: compileDefaultVeilPolicy({
          allowedOrigins: ["https://example.test"],
          allowDownloads: false,
        }),
        executionSnapshot: {
          viewport: { width: 1280, height: 720 },
          certificationCandidate: true,
        },
      })),
      markRunning: vi.fn(async () => undefined),
      setRunPhase: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => true),
      isCancellationRequested: vi.fn(async () => false),
      failAttempt: vi.fn(async () => undefined),
    };
    const mutationStates = new Map<string, string>();
    const modes: string[] = [];
    const requestInputs: Array<{ mutationIdentity?: string; operationId: string }> = [];
    const capabilities = {
      createRun: vi.fn(
        (input: { correlationId: string; mode: "run" | "certify"; options: object }) => {
          modes.push(input.mode);
          const manifest = createExecutionCapabilityManifest({
            mode: input.mode,
            correlationId: input.correlationId,
          });
          return {
            manifest,
            journal: {
              begin: vi.fn(async () => undefined),
              complete: vi.fn(async () => undefined),
              fail: vi.fn(async () => undefined),
              settle: vi.fn(
                async (settlement: { mutation?: { mutationIdentity: string; next: string } }) => {
                  if (settlement.mutation) {
                    mutationStates.set(
                      settlement.mutation.mutationIdentity,
                      settlement.mutation.next,
                    );
                  }
                },
              ),
            },
            mutationFence: {
              claim: async ({ mutationIdentity }: { mutationIdentity: string }) => ({
                state: mutationStates.get(mutationIdentity) ?? "planned",
                fencingToken: 1,
              }),
              transition: async (input: {
                mutationIdentity: string;
                expected: string;
                next: string;
              }) => {
                const current = mutationStates.get(input.mutationIdentity) ?? "planned";
                if (current !== input.expected) return false;
                mutationStates.set(input.mutationIdentity, input.next);
                return true;
              },
            },
            options: input.options,
          };
        },
      ),
      request: vi.fn(
        (input: Record<string, unknown> & { capabilities: { manifest: { digest: string } } }) => {
          requestInputs.push({
            operationId: String(input.operationId),
            ...(typeof input.mutationIdentity === "string"
              ? { mutationIdentity: input.mutationIdentity }
              : {}),
          });
          return {
            sessionId: input.sessionId,
            operationId: input.operationId,
            correlationId: input.correlationId,
            mode: input.mode,
            plan: input.plan,
            policy: input.policy,
            capabilityManifestDigest: input.capabilities.manifest.digest,
            idempotencyKey: input.idempotencyKey,
            mutationIdentity: input.mutationIdentity,
          };
        },
      ),
    };
    const dispatch = vi.fn(async (options: { onMutationDispatch?: () => void | Promise<void> }) => {
      await options.onMutationDispatch?.();
      throw new Error("WORKER_PROCESS_LOST_AFTER_DISPATCH");
    });
    const processor = createRunProcessor({
      ...identity,
      executions: executions as never,
      artifactRoot: "/tmp/scry-worker-test",
      artifactRetentionMs: 60_000,
      artifactStore: {} as never,
      artifactStoreRemote: false,
      veilAdmissionKey: "test-key",
      kernel: new ExecutionKernelService(dispatch as never),
      capabilities: capabilities as never,
    });

    await expect(
      processor({
        ...job({ runId, releaseId: "release-1", schemaFingerprint: "schema-1" }),
        opts: { attempts: 2 },
      } as never),
    ).rejects.toThrow("WORKER_PROCESS_LOST_AFTER_DISPATCH");
    await expect(
      processor({
        ...job({ runId, releaseId: "release-1", schemaFingerprint: "schema-1" }),
        attemptsMade: 1,
        opts: { attempts: 2 },
      } as never),
    ).rejects.toThrow("EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION");

    expect(dispatch).toHaveBeenCalledOnce();
    expect(modes).toEqual(["run", "run"]);
    expect(requestInputs).toEqual([
      {
        operationId: "attempt-22222222-2222-4222-8222-222222222221",
        mutationIdentity: `run-${runId}`,
      },
      {
        operationId: "attempt-22222222-2222-4222-8222-222222222222",
        mutationIdentity: `run-${runId}`,
      },
    ]);
    expect(mutationStates.get(`run-${runId}`)).toBe("outcome_unknown");
  });

  it("routes read-only Probe inspection through the kernel exactly once", async () => {
    const runtime = {
      id: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      environmentId: "33333333-3333-4333-8333-333333333333",
      level: "inspection" as const,
      plan: {
        name: "Read-only shadow",
        objective: "Open one page",
        preconditions: [],
        allowedOrigins: ["https://example.com"],
        budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
        checkpoints: [],
        steps: [
          {
            id: "open",
            title: "Open",
            action: { type: "navigate", url: "https://example.com" },
            assertions: [],
            onFailure: "stop",
            evidence: [],
            captureIntent: "final",
          },
        ],
      },
      policy: { allowedOrigins: ["https://example.com"], allowPrivateNetwork: false },
    };
    const probes = {
      claim: vi.fn(async () => runtime),
      running: vi.fn(async () => true),
      heartbeat: vi.fn(async () => true),
      cancelled: vi.fn(async () => false),
      complete: vi.fn(async () => true),
      fail: vi.fn(async () => undefined),
      storeAuthenticatedState: vi.fn(async () => undefined),
      resolveCredential: vi.fn(async () => "unused"),
    };
    const result = {
      allResolved: true,
      runtimeHealthy: true,
      targets: [],
      readiness: [],
      diagnostics: [],
      pageFingerprint: "stable-page",
    };
    const kernel = {
      probe: vi.fn(async () => result),
    };
    const capabilities = {
      createSession: vi.fn(() => ({ manifest: {}, options: {} })),
      request: vi.fn(() => ({ operationId: "probe-shadow" })),
    };
    const processor = createProbeProcessor({
      ...identity,
      probes: probes as never,
      observationRuntimeHash: "runtime",
      veilAdmissionKey: "test-key",
      kernel: kernel as never,
      capabilities: capabilities as never,
    });

    await expect(
      processor(
        job({
          probeSessionId: runtime.id,
          releaseId: "release-1",
          schemaFingerprint: "schema-1",
        }) as never,
      ),
    ).resolves.toEqual({ state: "completed", allResolved: true });
    expect(kernel.probe).toHaveBeenCalledOnce();
    expect(probes.complete).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        learnedContracts: [],
        qualityFindings: [],
        authoringTrajectory: expect.objectContaining({
          schemaVersion: 1,
          probeSessionId: runtime.id,
          attemptId: runtime.attemptId,
        }),
      }),
    );
  });

  it("runs Praxis inspection through the owned authoring runtime page", async () => {
    const praxis = {
      claim: vi.fn(async () => ({
        id: "request-1",
        payload: {
          intent: {
            concept: "Continue",
            requiredCapabilities: ["pointer_activatable"],
            preferredEvidence: {
              roles: ["button"],
              names: ["Continue"],
              labels: [],
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
              minimumMargin: 0.05,
              minimumFamilyCount: 1,
            },
          },
          allowedOrigins: ["https://example.com"],
          probeSessionId: "probe-1",
        },
        claimToken: "claim-1",
      })),
      resolveActiveBrowserLease: vi.fn(async () => "lease-1"),
      complete: vi.fn(async () => true),
      fail: vi.fn(async () => undefined),
    };

    const authoringRuntimeOwner = {
      inspect: vi.fn(async () => ({
        resolution: "resolved",
        candidates: [
          {
            id: "candidate-1",
            fingerprint: "a".repeat(64),
            confidence: 0.95,
            runnerUpMargin: 0.5,
            evidenceFamilies: ["accessibility"],
            strategy: "native_activate",
            resumeToken: {
              id: "resume-1",
              intentDigest: "b".repeat(64),
              fingerprint: "a".repeat(64),
              documentEpoch: 1,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        ],
        policy: {
          allowsAgentCandidateChoice: true,
          allowsSelectorHint: true,
          requiresExplicitAuthorization: false,
        },
        diagnostic: {
          intentDigest: "b".repeat(64),
          documentEpoch: 1,
        },
      })),
    };

    const processor = createPraxisProcessor({
      ...identity,
      praxis: praxis as never,
      authoringRuntimeOwner: authoringRuntimeOwner as never,
    });

    const result = await processor(
      job({
        requestId: "request-1",
        releaseId: "release-1",
        schemaFingerprint: "schema-1",
      }) as never,
    );

    expect(result).toEqual({
      state: "completed",
      requestId: "request-1",
    });

    expect(praxis.resolveActiveBrowserLease).toHaveBeenCalledWith("probe-1", "worker-1");

    expect(authoringRuntimeOwner.inspect).toHaveBeenCalledWith("lease-1", expect.any(Object), [
      "https://example.com",
    ]);

    expect(praxis.complete).toHaveBeenCalledOnce();
  });

  it("fails Praxis inspection when the worker does not own the browser lease", async () => {
    const praxis = {
      claim: vi.fn(async () => ({
        id: "request-1",
        payload: {
          intent: {},
          allowedOrigins: ["https://example.com"],
          probeSessionId: "probe-1",
        },
        claimToken: "claim-1",
      })),
      resolveActiveBrowserLease: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };

    const authoringRuntimeOwner = {
      inspect: vi.fn(),
    };

    const processor = createPraxisProcessor({
      ...identity,
      praxis: praxis as never,
      authoringRuntimeOwner: authoringRuntimeOwner as never,
    });

    const result = await processor(
      job({
        requestId: "request-1",
        releaseId: "release-1",
        schemaFingerprint: "schema-1",
      }) as never,
    );

    expect(result).toEqual({
      state: "failed",
    });

    expect(praxis.resolveActiveBrowserLease).toHaveBeenCalledWith("probe-1", "worker-1");

    expect(authoringRuntimeOwner.inspect).not.toHaveBeenCalled();

    expect(praxis.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "request-1",
      }),
      "AUTHORING_BROWSER_SESSION_UNAVAILABLE",
    );
  });

  it.each([
    {
      name: "claim fencing",
      heartbeatOwned: false,
      cancellationRequested: false,
      code: "WORKER_CLAIM_FENCED",
      transitionTo: "failed",
    },
    {
      name: "requested cancellation",
      heartbeatOwned: true,
      cancellationRequested: true,
      code: "RUN_CANCELLATION_REQUESTED",
      transitionTo: "cancelled",
    },
  ])("emits a stable code for $name", async (scenario) => {
    const executions = abortingRunExecutions(
      scenario.heartbeatOwned,
      scenario.cancellationRequested,
    );
    const operationalEvents = { emit: vi.fn(async () => undefined) };
    const processor = createRunProcessor({
      ...identity,
      heartbeatMs: 1,
      executions: executions as never,
      artifactRoot: "/tmp/scry-worker-test",
      artifactRetentionMs: 60_000,
      artifactStore: {} as never,
      artifactStoreRemote: false,
      veilAdmissionKey: "test-key",
      operationalEvents,
      capabilities: {
        createRun: (input: { options: { signal: AbortSignal } }) => ({
          manifest: { digest: "manifest" },
          options: input.options,
        }),
        request: (input: Record<string, unknown>) => input,
      } as never,
      kernel: {
        execute: async (input: { capabilities: { options: { signal: AbortSignal } } }) =>
          await new Promise((_, reject) => {
            const signal = input.capabilities.options.signal;
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }),
      } as never,
    });

    await expect(
      processor(
        job({ runId: "run-1", releaseId: "release-1", schemaFingerprint: "schema-1" }) as never,
      ),
    ).rejects.toThrow(scenario.code);
    expect(executions.failAttempt).toHaveBeenCalledWith(
      "run-1",
      "attempt-1",
      expect.any(String),
      scenario.code,
      false,
    );
    expect(operationalEvents.emit).toHaveBeenCalledWith(
      "worker",
      expect.objectContaining({
        reasonCode: scenario.code,
        transition: { from: "running", to: scenario.transitionTo },
      }),
    );
  });

  it("sanitizes unsafe worker and dependency diagnostics", () => {
    expect(safeWorkerCode(new Error("sensitive free-form detail"))).toBe(
      "CALIBRATION_EXECUTION_FAILED",
    );
    expect(safeWorkerCode(new Error("PROBE_CANCELLED"))).toBe("PROBE_CANCELLED");
    expect(safeDependencyCode({ code: "ECONNRESET" })).toBe("ECONNRESET");
    expect(safeDependencyCode({ code: "secret detail" })).toBeUndefined();
  });
});

function job(data: Record<string, unknown>) {
  return { data, attemptsMade: 0, opts: { attempts: 1 } };
}

function mutatingRunPlan() {
  return {
    name: "Worker retry mutation",
    objective: "Apply one mutation",
    preconditions: [],
    allowedOrigins: ["https://example.test"],
    budgets: { maxActions: 1, maxDurationMs: 5_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "fill",
        title: "Fill",
        action: {
          type: "fill",
          target: {
            concept: "Name",
            requiredCapabilities: ["accepts_text", "focusable", "editable"],
            preferredEvidence: {
              roles: ["textbox"],
              names: ["Name"],
              labels: ["Name"],
              descriptions: [],
              placeholders: [],
              inputTypes: [],
            },
            scope: { kind: "page" },
            relations: [],
            prohibited: ["hidden", "disabled"],
            risk: "ordinary",
            confidence: { requiredFamilies: [], minimumFamilyCount: 1 },
          },
          value: "public",
        },
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "final",
      },
    ],
  };
}

function abortingRunExecutions(heartbeatOwned: boolean, cancellationRequested: boolean) {
  return {
    claimAttempt: vi.fn(async () => ({ id: "attempt-1", attemptNumber: 1 })),
    loadExecution: vi.fn(async () => ({
      flowRevisionId: "flow-revision-1",
      environmentId: "environment-1",
      projectId: "project-1",
      missionId: "mission-1",
      objectiveId: "objective-1",
      agentSessionId: "agent-1",
      planSnapshot: mutatingRunPlan(),
      policySnapshot: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false },
      veilPolicySnapshot: compileDefaultVeilPolicy({
        allowedOrigins: ["https://example.test"],
        allowDownloads: false,
      }),
      executionSnapshot: { viewport: { width: 1280, height: 720 } },
    })),
    markRunning: vi.fn(async () => undefined),
    setRunPhase: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => heartbeatOwned),
    isCancellationRequested: vi.fn(async () => cancellationRequested),
    appendEvent: vi.fn(async () => undefined),
    stageSuccessorCheckpoint: vi.fn(async () => undefined),
    failAttempt: vi.fn(async () => undefined),
  };
}
