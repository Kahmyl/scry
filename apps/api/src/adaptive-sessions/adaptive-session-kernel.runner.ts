import { ConflictException, Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AdaptiveSessionOperationInput,
  AgentDecisionBoundary,
  CurrentAction,
  ExecutionMode,
  ExecutionPolicy,
  ExpectedEffect,
  OperationOutcome,
} from "@scry/contracts";
import type { AuthoringBrowserSession } from "@scry/executor";
import { compileDefaultVeilPolicy } from "@scry/veil";

import {
  ExecutionCapabilityFactory,
  ExecutionKernelService,
  NativeBrowserDriver,
} from "../runtime/index.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";

export type AdaptiveKernelExecutionResult = {
  outcome: OperationOutcome;
  capabilityManifestDigest: string;
  decisionBoundary: AgentDecisionBoundary;
  timings: { resolveMs: number; executeMs: number; verifyMs: number };
  safeState: { url: string; documentEpoch: number };
};

type TestRuntimeBinding = (
  kernel: ExecutionKernelService,
  input: { sessionId: string; operation: AdaptiveSessionOperationInput },
) => Promise<AdaptiveKernelExecutionResult>;

type OwnedRuntime = {
  session: AuthoringBrowserSession;
  fencingToken: number;
  tail: Promise<void>;
};

type OperationTimingCollector = {
  onNativeResolution: (result: { status: "resolved" | "fallback"; reasonCode?: string; durationMs: number }) => void;
  onExpectedEffectVerification: (result: { status: "succeeded" | "failed"; reasonCode?: string; durationMs: number }) => void;
};

@Injectable()
export class AdaptiveSessionKernelRunner implements OnModuleDestroy {
  private readonly testBindings = new Map<string, TestRuntimeBinding>();
  private readonly runtimes = new Map<string, OwnedRuntime>();
  private readonly provisioning = new Map<string, Promise<OwnedRuntime>>();
  private readonly operationModes = new Map<string, ExecutionMode>();
  private readonly operationTimingCollectors = new Map<string, OperationTimingCollector>();
  private readonly ownerId = randomUUID();
  private readonly leaseDurationMs = Number(
    process.env.ADAPTIVE_SESSION_RUNTIME_LEASE_MS ?? 30_000,
  );
  private readonly browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
  private readonly veilAdmissionKey = process.env.VEIL_ADMISSION_KEY;
  private readonly artifactRoot = path.resolve(process.env.ARTIFACT_ROOT ?? "artifacts/runs");

  constructor(
    @Inject(ExecutionKernelService) private readonly kernel: ExecutionKernelService,
    @Inject(ExecutionCapabilityFactory) private readonly capabilities: ExecutionCapabilityFactory,
    @Inject(AdaptiveSessionRepository) private readonly sessions: AdaptiveSessionRepository,
    @Inject(NativeBrowserDriver) private readonly nativeBrowser: NativeBrowserDriver,
  ) {}

  /** Test seam only. Production execution always provisions from durable session state. */
  async bindForTest(sessionId: string, binding: TestRuntimeBinding) {
    if (process.env.NODE_ENV !== "test") {
      throw new ConflictException({ code: "ADAPTIVE_SESSION_TEST_BINDING_FORBIDDEN" });
    }
    if (this.testBindings.has(sessionId)) {
      throw new ConflictException({ code: "ADAPTIVE_SESSION_RUNTIME_ALREADY_BOUND" });
    }
    this.testBindings.set(sessionId, binding);
    return () => this.testBindings.delete(sessionId);
  }

  async execute(sessionId: string, operation: AdaptiveSessionOperationInput) {
    const testBinding = this.testBindings.get(sessionId);
    if (testBinding) return testBinding(this.kernel, { sessionId, operation });

    const owned = await this.runtime(sessionId, operation);
    await this.sessions.heartbeatRuntimeLease({
      sessionId,
      ownerId: this.ownerId,
      fencingToken: owned.fencingToken,
      leaseDurationMs: this.leaseDurationMs,
    });

    return this.exclusive(owned, async () => {
      const context = await this.sessions.runtimeContextFor(sessionId);
      let resolveMs = 0;
      let verifyMs = 0;
      const capability = this.createCapabilities({
        sessionId,
        environmentId: context.environmentId,
        correlationId: context.correlationId,
        operationId: operation.operationId,
        mode: operation.mode,
        policy: context.policy,
        onNativeResolution: (result) => { resolveMs += result.durationMs; },
        onExpectedEffectVerification: (result) => { verifyMs += result.durationMs; },
      });
      const modeKey = `${sessionId}:${operation.operationId}`;
      this.operationModes.set(modeKey, operation.mode);
      this.operationTimingCollectors.set(modeKey, {
        onNativeResolution: (result) => { resolveMs += result.durationMs; },
        onExpectedEffectVerification: (result) => { verifyMs += result.durationMs; },
      });
      try {
        const executeStartedAt = performance.now();
        const result = await owned.session.interact(operation.action, {
          operationId: operation.operationId,
          correlationId: context.correlationId,
          mutationIdentity: `adaptive-${sessionId}-${operation.idempotencyKey}`,
          expectedEffect: operation.expectedEffect,
        });
        await this.sessions.recordVerifiedObservation({
          sessionId,
          operationId: operation.operationId,
          documentEpoch: result.documentEpoch,
          url: result.url,
        });
        return {
          outcome: result.outcome,
          capabilityManifestDigest: capability.manifest.digest,
          decisionBoundary: decisionBoundary(result.outcome),
          timings: { resolveMs, executeMs: performance.now() - executeStartedAt, verifyMs },
          safeState: { url: result.url, documentEpoch: result.documentEpoch },
        };
      } finally {
        this.operationModes.delete(modeKey);
        this.operationTimingCollectors.delete(modeKey);
      }
    });
  }

  async close(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.tail;
    await runtime.session.close().catch(() => undefined);
    await this.sessions.releaseRuntimeLease({
      sessionId,
      ownerId: this.ownerId,
      fencingToken: runtime.fencingToken,
    });
  }

  async onModuleDestroy() {
    await Promise.all([...this.runtimes.keys()].map((sessionId) => this.close(sessionId)));
  }

  private runtime(sessionId: string, operation: AdaptiveSessionOperationInput) {
    const current = this.runtimes.get(sessionId);
    if (current) return Promise.resolve(current);
    const pending = this.provisioning.get(sessionId);
    if (pending) return pending;
    const provisioning = this.provision(sessionId, operation).finally(() =>
      this.provisioning.delete(sessionId),
    );
    this.provisioning.set(sessionId, provisioning);
    return provisioning;
  }

  private async provision(sessionId: string, operation: AdaptiveSessionOperationInput): Promise<OwnedRuntime> {
    if (!this.veilAdmissionKey) throw new Error("VEIL_ADMISSION_KEY_REQUIRED");
    const context = await this.sessions.runtimeContextFor(sessionId);
    const lease = await this.sessions.claimRuntimeLease({
      sessionId,
      ownerId: this.ownerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    const operationId = `adaptive-runtime-${lease.fencingToken}`;
    const capability = this.createCapabilities({
      sessionId,
      environmentId: context.environmentId,
      correlationId: context.correlationId,
      operationId,
      mode: "observe",
      policy: context.policy,
    });
    const request = this.capabilities.request({
      sessionId,
      operationId,
      correlationId: context.correlationId,
      mode: "observe",
      plan: observationPlan(context.policy),
      policy: context.policy,
      capabilities: capability,
      idempotencyKey: operationId,
    });
    let browser: AuthoringBrowserSession | undefined;
    try {
      browser = await this.kernel.openAuthoringSession({
        request,
        capabilities: capability,
        session: {
          sessionId,
          environmentId: context.environmentId,
          veilAdmissionKey: this.veilAdmissionKey,
          browserChannel: this.browserChannel,
          policy: context.policy,
          openBrowser: () => this.nativeBrowser.openBrowser(),
          executeInteraction: (input) =>
            this.executeInteraction({
              sessionId,
              environmentId: context.environmentId,
              policy: context.policy,
              mode: this.operationModes.get(`${sessionId}:${input.operationId}`) ?? "rehearse",
              fencingToken: lease.fencingToken,
              ...input,
            }),
        },
      });
      const continuationUrl = safeContinuationUrl(
        context.lastObservation?.url,
        context.policy.allowedOrigins,
      );
      const admittedFirstNavigation = operation.action.type === "navigate"
        ? safeContinuationUrl(operation.action.url, context.policy.allowedOrigins)
        : undefined;
      await this.nativeBrowser.navigateAndWait(
        browser.page,
        continuationUrl ?? admittedFirstNavigation ?? context.baseOrigin,
        context.policy.allowedOrigins,
        30_000,
        context.policy.trustedScriptOrigins ?? [],
      );
      const observation = await browser.observeDocument();
      await this.sessions.recordVerifiedObservation({
        sessionId,
        operationId: operation.operationId,
        documentEpoch: observation.documentEpoch,
        url: observation.url,
      });
      const owned = { session: browser, fencingToken: lease.fencingToken, tail: Promise.resolve() };
      this.runtimes.set(sessionId, owned);
      return owned;
    } catch (error) {
      await browser?.close().catch(() => undefined);
      await this.sessions.releaseRuntimeLease({
        sessionId,
        ownerId: this.ownerId,
        fencingToken: lease.fencingToken,
      });
      throw error;
    }
  }

  private executeInteraction(input: {
    sessionId: string;
    environmentId: string;
    policy: ExecutionPolicy;
    mode: ExecutionMode;
    fencingToken: number;
    browser: import("playwright").Browser;
    context: import("playwright").BrowserContext;
    provenance: import("@scry/executor").BrowserSessionProvenance;
    page: Parameters<AuthoringBrowserSession["interact"]>[0] extends never
      ? never
      : import("playwright").Page;
    action: CurrentAction;
    ordinal: number;
    operationId: string;
    correlationId?: string;
    mutationIdentity?: string;
    expectedEffect?: ExpectedEffect;
    resolveEffectPage?: () => Promise<import("playwright").Page | undefined>;
    objectiveDelta?: string;
    signal?: AbortSignal;
    privacyGate: import("@scry/veil").VeilRuntimeCoordinator;
  }) {
    const correlationId = input.correlationId ?? randomUUID();
    const collector = this.operationTimingCollectors.get(`${input.sessionId}:${input.operationId}`);
    const capability = this.createCapabilities({
      sessionId: input.sessionId,
      environmentId: input.environmentId,
      correlationId,
      operationId: input.operationId,
      mode: input.mode,
      policy: input.policy,
      onMutationDispatch: () =>
        this.sessions.markOperationDispatching({
          sessionId: input.sessionId,
          operationId: input.operationId,
          ownerId: this.ownerId,
          fencingToken: input.fencingToken,
        }),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(collector ? {
        onNativeResolution: collector.onNativeResolution,
        onExpectedEffectVerification: collector.onExpectedEffectVerification,
      } : {}),
    });
    return this.kernel.interact({
      request: {
        sessionId: input.sessionId,
        operationId: input.operationId,
        correlationId,
        mode: input.mode,
        policy: input.policy,
        ...(input.mutationIdentity ? { mutationIdentity: input.mutationIdentity } : {}),
        ...(input.objectiveDelta ? { semanticContext: input.objectiveDelta } : {}),
      },
      capabilities: capability,
      page: input.page,
      safeSession: {
        browser: input.browser,
        context: input.context,
        page: input.page,
        provenance: input.provenance,
      },
      action: input.action,
      ...(input.expectedEffect ? { expectedEffect: input.expectedEffect } : {}),
      ...(input.resolveEffectPage ? { resolveEffectPage: input.resolveEffectPage } : {}),
      ordinal: input.ordinal,
      privacyGate: input.privacyGate,
    });
  }

  private createCapabilities(input: {
    sessionId: string;
    environmentId: string;
    correlationId: string;
    operationId: string;
    mode: ExecutionMode;
    policy: ExecutionPolicy;
    onMutationDispatch?: () => Promise<void>;
    signal?: AbortSignal;
    onNativeResolution?: (result: { status: "resolved" | "fallback"; reasonCode?: string; durationMs: number }) => void;
    onExpectedEffectVerification?: (result: { status: "succeeded" | "failed"; reasonCode?: string; durationMs: number }) => void;
  }) {
    return this.capabilities.createSession({
      sessionId: input.sessionId,
      operationId: input.operationId,
      correlationId: input.correlationId,
      mode: input.mode,
      options: {
        outputDirectory: path.join(this.artifactRoot, "adaptive", input.sessionId),
        browserChannel: this.browserChannel,
        environmentId: input.environmentId,
        veilAdmissionKey: this.veilAdmissionKey!,
        veilPolicySnapshot: compileDefaultVeilPolicy(input.policy),
        nativeResolutionPolicy: "native_only",
        secretResolver: (reference) => this.sessions.resolveCredential(input.sessionId, reference),
        ...(input.onMutationDispatch ? { onMutationDispatch: input.onMutationDispatch } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onNativeResolution ? { onNativeResolution: input.onNativeResolution } : {}),
        ...(input.onExpectedEffectVerification ? { onExpectedEffectVerification: input.onExpectedEffectVerification } : {}),
      },
    });
  }

  private async exclusive<T>(runtime: OwnedRuntime, operation: () => Promise<T>) {
    const predecessor = runtime.tail;
    let release!: () => void;
    runtime.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function decisionBoundary(outcome: OperationOutcome): AgentDecisionBoundary {
  if (outcome.nextDecisionBoundary) return outcome.nextDecisionBoundary;
  if (outcome.mutationOutcome === "unknown") {
    return {
      type: "mutation_reconciliation_required",
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_flow_authoring"],
    };
  }
  return outcome.functionalResult === "succeeded"
    ? { type: "objective_completed", reasonCode: "OPERATION_COMPLETED", safeActions: [] }
    : {
        type: "environment_unavailable",
        reasonCode: outcome.reasonCode ?? "ADAPTIVE_OPERATION_FAILED",
        safeActions: ["get_flow_authoring", "advance_flow_authoring"],
      };
}

function safeContinuationUrl(candidate: string | undefined, allowedOrigins: string[]) {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return allowedOrigins.includes(url.origin) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function observationPlan(policy: ExecutionPolicy) {
  return {
    name: "Adaptive session runtime reconstruction",
    objective: "Reconstruct the last verified browser boundary",
    preconditions: [],
    allowedOrigins: policy.allowedOrigins,
    budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "adaptive-runtime-observation",
        title: "Observe the reconstructed document",
        action: { type: "navigate" as const, url: policy.allowedOrigins[0]!, timeoutMs: 30_000 },
        assertions: [],
        onFailure: "stop" as const,
        evidence: [],
        captureIntent: "transient" as const,
        transientJustification:
          "The plan admits browser reconstruction without replaying a mutation.",
      },
    ],
  };
}
