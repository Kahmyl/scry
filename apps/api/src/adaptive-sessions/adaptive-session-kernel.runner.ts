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
import { runProtectedStage, type AuthoringBrowserSession } from "@scry/executor";
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

type OperationLeaseGuard = {
  signal: AbortSignal;
  heartbeat(): Promise<void>;
  stop(): Promise<void>;
  assertOwned(): void;
};

@Injectable()
export class AdaptiveSessionKernelRunner implements OnModuleDestroy {
  private readonly testBindings = new Map<string, TestRuntimeBinding>();
  private readonly runtimes = new Map<string, OwnedRuntime>();
  private readonly provisioning = new Map<string, Promise<OwnedRuntime>>();
  private readonly operationModes = new Map<string, ExecutionMode>();
  private readonly operationTimingCollectors = new Map<string, OperationTimingCollector>();
  private readonly operationLeaseGuards = new Map<string, OperationLeaseGuard>();
  private readonly ownerId = randomUUID();
  private readonly leaseDurationMs = Number(
    process.env.ADAPTIVE_SESSION_RUNTIME_LEASE_MS ?? 30_000,
  );
  private readonly runtimeCloseTimeoutMs = Number(
    process.env.ADAPTIVE_SESSION_RUNTIME_CLOSE_TIMEOUT_MS ?? 2_000,
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

  async execute(
    sessionId: string,
    operation: AdaptiveSessionOperationInput,
    signal?: AbortSignal,
  ) {
    const testBinding = this.testBindings.get(sessionId);
    if (testBinding) return testBinding(this.kernel, { sessionId, operation });

    const owned = await this.runtime(sessionId, operation);
    return this.exclusive(owned, async () => {
      const leaseGuard = await this.startOperationLeaseGuard(sessionId, owned);
      const context = await this.sessions.runtimeContextFor(sessionId);
      const protectedContext = operation.action.type === "protectedTransaction"
        ? await this.sessions.protectedExecutionContext(sessionId, operation.operationId)
        : undefined;
      let resolveMs = 0;
      let verifyMs = 0;
      const capability = this.createCapabilities({
        sessionId,
        environmentId: context.environmentId,
        correlationId: context.correlationId,
        operationId: operation.operationId,
        mode: operation.mode,
        policy: context.policy,
        ...(protectedContext ? { protectedContext, leaseOwner: `${this.ownerId}:${owned.fencingToken}` } : {}),
        onNativeResolution: (result) => { resolveMs += result.durationMs; },
        onExpectedEffectVerification: (result) => { verifyMs += result.durationMs; },
      });
      const modeKey = `${sessionId}:${operation.operationId}`;
      this.operationModes.set(modeKey, operation.mode);
      this.operationTimingCollectors.set(modeKey, {
        onNativeResolution: (result) => { resolveMs += result.durationMs; },
        onExpectedEffectVerification: (result) => { verifyMs += result.durationMs; },
      });
      this.operationLeaseGuards.set(modeKey, leaseGuard);
      try {
        const executeStartedAt = performance.now();
        const result = await owned.session.interact(operation.action, {
          operationId: operation.operationId,
          correlationId: context.correlationId,
          mutationIdentity: `adaptive-${sessionId}-${operation.idempotencyKey}`,
          expectedEffect: operation.expectedEffect,
          ...(signal ? { signal } : {}),
        });
        if (result.outcome.mutationOutcome !== "unknown") leaseGuard.assertOwned();
        await this.sessions.recordVerifiedObservation({
          sessionId,
          operationId: operation.operationId,
          documentEpoch: result.documentEpoch,
          url: result.url,
        });
        return {
          outcome: result.outcome,
          capabilityManifestDigest: capability.manifest.digest,
          decisionBoundary: decisionBoundary(result.outcome, {
            environmentId: context.environmentId,
            trustedScriptOrigins: context.policy.trustedScriptOrigins ?? [],
          }),
          timings: { resolveMs, executeMs: performance.now() - executeStartedAt, verifyMs },
          safeState: { url: result.url, documentEpoch: result.documentEpoch },
        };
      } finally {
        this.operationLeaseGuards.delete(modeKey);
        this.operationModes.delete(modeKey);
        this.operationTimingCollectors.delete(modeKey);
        await leaseGuard.stop();
      }
    });
  }

  async cancelActiveOperation(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.session.cancelActiveOperation();
  }

  async close(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    try {
      try {
        await runProtectedStage({
          stage: "adaptive_runtime_tail_shutdown",
          timeoutMs: this.runtimeCloseTimeoutMs,
          timeoutCode: "ADAPTIVE_RUNTIME_TAIL_SHUTDOWN_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => runtime.tail,
        });
      } catch {
        await runProtectedStage({
          stage: "adaptive_runtime_operation_cancel",
          timeoutMs: this.runtimeCloseTimeoutMs,
          timeoutCode: "ADAPTIVE_RUNTIME_OPERATION_CANCEL_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => runtime.session.cancelActiveOperation(),
        }).catch(() => undefined);
      }
      await runProtectedStage({
        stage: "adaptive_runtime_session_close",
        timeoutMs: this.runtimeCloseTimeoutMs,
        timeoutCode: "ADAPTIVE_RUNTIME_SESSION_CLOSE_TIMEOUT",
        dispatchPosition: "post_dispatch",
        work: () => runtime.session.close(),
      }).catch(() => undefined);
    } finally {
      await this.sessions.releaseRuntimeLease({
        sessionId,
        ownerId: this.ownerId,
        fencingToken: runtime.fencingToken,
      });
    }
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
          openBrowser: () => this.nativeBrowser.openBrowser({}, {
            kind: "safe_browser",
            ownerId: sessionId,
          }),
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

  private async executeInteraction(input: {
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
    protectedContext?: {
      projectId: string; environmentId: string; missionId: string; objectiveId: string;
      agentSessionId: string; flowDraftId: string; authorizationId: string;
    };
    leaseOwner?: string;
    privacyGate: import("@scry/veil").VeilRuntimeCoordinator;
  }) {
    const correlationId = input.correlationId ?? randomUUID();
    const operationKey = `${input.sessionId}:${input.operationId}`;
    const collector = this.operationTimingCollectors.get(operationKey);
    const leaseGuard = this.operationLeaseGuards.get(operationKey);
    const signal = composeSignals(input.signal, leaseGuard?.signal);
    const protectedContext = input.action.type === "protectedTransaction"
      ? await this.sessions.protectedExecutionContext(input.sessionId, input.operationId)
      : undefined;
    const capability = this.createCapabilities({
      sessionId: input.sessionId,
      environmentId: input.environmentId,
      correlationId,
      operationId: input.operationId,
      mode: input.mode,
      policy: input.policy,
      dispatchDisposition: protectedContext?.dispatchDisposition ?? "execute",
      ...(protectedContext ? {
        protectedContext,
        leaseOwner: `${this.ownerId}:${input.fencingToken}`,
      } : {}),
      onMutationDispatch: async () => {
        await leaseGuard?.heartbeat();
        await this.sessions.markOperationDispatching({
          sessionId: input.sessionId,
          operationId: input.operationId,
          ownerId: this.ownerId,
          fencingToken: input.fencingToken,
        });
      },
      ...(signal ? { signal } : {}),
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
    dispatchDisposition?: "execute" | "qualification_only";
    onMutationDispatch?: () => Promise<void>;
    signal?: AbortSignal;
    protectedContext?: {
      projectId: string; environmentId: string; missionId: string; objectiveId: string;
      agentSessionId: string; flowDraftId: string; authorizationId: string;
      dispatchDisposition: "execute" | "qualification_only";
    };
    leaseOwner?: string;
    onNativeResolution?: (result: { status: "resolved" | "fallback"; reasonCode?: string; durationMs: number }) => void;
    onExpectedEffectVerification?: (result: { status: "succeeded" | "failed"; reasonCode?: string; durationMs: number }) => void;
  }) {
    const create = input.protectedContext
      ? this.capabilities.createMissionAuthoringSession.bind(this.capabilities)
      : this.capabilities.createSession.bind(this.capabilities);
    return create({
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
        secretResolver: (reference) => this.sessions.resolveProtectedInput(input.sessionId, input.operationId, reference),
        dispatchDisposition: input.dispatchDisposition ?? "execute",
        ...(input.onMutationDispatch ? { onMutationDispatch: input.onMutationDispatch } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onNativeResolution ? { onNativeResolution: input.onNativeResolution } : {}),
        ...(input.onExpectedEffectVerification ? { onExpectedEffectVerification: input.onExpectedEffectVerification } : {}),
      },
      ...(input.protectedContext ? { ...input.protectedContext, leaseOwner: input.leaseOwner! } : {}),
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

  private async startOperationLeaseGuard(
    sessionId: string,
    runtime: OwnedRuntime,
  ): Promise<OperationLeaseGuard> {
    const controller = new AbortController();
    const heartbeatTimeoutMs = Math.max(250, Math.floor(this.leaseDurationMs / 3));
    let stopped = false;
    let firstFailure: unknown;
    let renewalTail = Promise.resolve();
    const renew = (propagate: boolean) => {
      const renewal = renewalTail.then(async () => {
        if (firstFailure) throw firstFailure;
        await runProtectedStage({
          stage: "adaptive_runtime_heartbeat",
          timeoutMs: heartbeatTimeoutMs,
          signal: controller.signal,
          timeoutCode: "ADAPTIVE_RUNTIME_HEARTBEAT_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => this.sessions.heartbeatRuntimeLease({
          sessionId,
          ownerId: this.ownerId,
          fencingToken: runtime.fencingToken,
          leaseDurationMs: this.leaseDurationMs,
          }),
        });
      });
      renewalTail = renewal.catch((error) => {
        if (!firstFailure) {
          firstFailure = error;
          controller.abort(error);
        }
      });
      return propagate ? renewal : renewalTail;
    };
    await renew(true);
    const timer = setInterval(
      () => { if (!stopped) void renew(false); },
      Math.max(250, Math.floor(this.leaseDurationMs / 3)),
    );
    return {
      signal: controller.signal,
      heartbeat: () => renew(true),
      assertOwned() {
        if (firstFailure) throw firstFailure;
      },
      async stop() {
        stopped = true;
        clearInterval(timer);
        await runProtectedStage({
          stage: "adaptive_runtime_heartbeat_shutdown",
          timeoutMs: heartbeatTimeoutMs,
          timeoutCode: "ADAPTIVE_RUNTIME_HEARTBEAT_SHUTDOWN_TIMEOUT",
          dispatchPosition: "post_dispatch",
          work: () => renewalTail,
        }).catch(() => undefined);
      },
    };
  }
}

function composeSignals(...signals: Array<AbortSignal | undefined>) {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function decisionBoundary(outcome: OperationOutcome, environment?: {
  environmentId: string;
  trustedScriptOrigins: string[];
}): AgentDecisionBoundary {
  if (outcome.nextDecisionBoundary) return outcome.nextDecisionBoundary;
  if (outcome.reasonCode === "ENVIRONMENT_TRUSTED_SCRIPT_ORIGIN_REQUIRED") {
    return {
      type: "environment_unavailable",
      reasonCode: outcome.reasonCode,
      safeActions: ["recover_trusted_script_origins"],
      ...(environment && outcome.environmentFailure ? {
        environmentRecovery: {
          environmentId: environment.environmentId,
          missingTrustedScriptOrigins: outcome.environmentFailure.missingTrustedScriptOrigins,
          missingOriginClassification: outcome.environmentFailure.missingOriginClassification,
          currentTrustedScriptOrigins: environment.trustedScriptOrigins,
          recoveryTool: "recover_trusted_script_origins" as const,
          requiresNewFlowDraftAndAuthoringSession: true as const,
        },
      } : {}),
    };
  }
  if (outcome.mutationOutcome === "unknown") {
    return {
      type: "mutation_reconciliation_required",
      reasonCode: "MUTATION_OUTCOME_UNKNOWN",
      safeActions: ["get_flow_authoring"],
    };
  }
  if (outcome.mutationOutcome === "applied" && outcome.functionalResult !== "succeeded") {
    return {
      type: "effect_observation_required",
      reasonCode: outcome.reasonCode ?? "EXPECTED_EFFECT_NOT_OBSERVED",
      safeActions: ["get_flow_authoring", "advance_flow_authoring"],
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
