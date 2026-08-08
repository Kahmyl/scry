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

import { ExecutionCapabilityFactory, ExecutionKernelService } from "../runtime/index.js";
import { AdaptiveSessionRepository } from "./adaptive-session.repository.js";

export type AdaptiveKernelExecutionResult = {
  outcome: OperationOutcome;
  capabilityManifestDigest: string;
  decisionBoundary: AgentDecisionBoundary;
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

@Injectable()
export class AdaptiveSessionKernelRunner implements OnModuleDestroy {
  private readonly testBindings = new Map<string, TestRuntimeBinding>();
  private readonly runtimes = new Map<string, OwnedRuntime>();
  private readonly provisioning = new Map<string, Promise<OwnedRuntime>>();
  private readonly operationModes = new Map<string, ExecutionMode>();
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

    const owned = await this.runtime(sessionId, operation.operationId);
    await this.sessions.heartbeatRuntimeLease({
      sessionId,
      ownerId: this.ownerId,
      fencingToken: owned.fencingToken,
      leaseDurationMs: this.leaseDurationMs,
    });

    return this.exclusive(owned, async () => {
      const context = await this.sessions.runtimeContextFor(sessionId);
      const capability = this.createCapabilities({
        sessionId,
        environmentId: context.environmentId,
        correlationId: context.correlationId,
        operationId: operation.operationId,
        mode: operation.mode,
        policy: context.policy,
      });
      await this.sessions.markOperationDispatching({
        sessionId,
        operationId: operation.operationId,
        ownerId: this.ownerId,
        fencingToken: owned.fencingToken,
      });
      const modeKey = `${sessionId}:${operation.operationId}`;
      this.operationModes.set(modeKey, operation.mode);
      try {
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
        };
      } finally {
        this.operationModes.delete(modeKey);
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

  private runtime(sessionId: string, journalOperationId: string) {
    const current = this.runtimes.get(sessionId);
    if (current) return Promise.resolve(current);
    const pending = this.provisioning.get(sessionId);
    if (pending) return pending;
    const provisioning = this.provision(sessionId, journalOperationId).finally(() =>
      this.provisioning.delete(sessionId),
    );
    this.provisioning.set(sessionId, provisioning);
    return provisioning;
  }

  private async provision(
    sessionId: string,
    journalOperationId: string,
  ): Promise<OwnedRuntime> {
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
          executeInteraction: (input) =>
            this.executeInteraction({
              sessionId,
              environmentId: context.environmentId,
              policy: context.policy,
              mode: this.operationModes.get(`${sessionId}:${input.operationId}`) ?? "rehearse",
              ...input,
            }),
        },
      });
      const continuationUrl = safeContinuationUrl(
        context.lastObservation?.url,
        context.policy.allowedOrigins,
      );
      await browser.page.goto(continuationUrl ?? context.baseOrigin, {
        waitUntil: "domcontentloaded",
      });
    const observation = await browser.observeDocument();
    await this.sessions.recordVerifiedObservation({
      sessionId,
      operationId: journalOperationId,
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
    page: Parameters<AuthoringBrowserSession["interact"]>[0] extends never
      ? never
      : import("playwright").Page;
    action: CurrentAction;
    ordinal: number;
    operationId: string;
    correlationId?: string;
    mutationIdentity?: string;
    expectedEffect?: ExpectedEffect;
    objectiveDelta?: string;
    signal?: AbortSignal;
  }) {
    const correlationId = input.correlationId ?? randomUUID();
    const capability = this.createCapabilities({
      sessionId: input.sessionId,
      environmentId: input.environmentId,
      correlationId,
      operationId: input.operationId,
      mode: input.mode,
      policy: input.policy,
      ...(input.signal ? { signal: input.signal } : {}),
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
      action: input.action,
      ...(input.expectedEffect ? { expectedEffect: input.expectedEffect } : {}),
      ordinal: input.ordinal,
    });
  }

  private createCapabilities(input: {
    sessionId: string;
    environmentId: string;
    correlationId: string;
    operationId: string;
    mode: ExecutionMode;
    policy: ExecutionPolicy;
    signal?: AbortSignal;
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
        secretResolver: (reference) => this.sessions.resolveCredential(input.sessionId, reference),
        ...(input.signal ? { signal: input.signal } : {}),
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
      safeActions: ["reconcile_operation"],
    };
  }
  return outcome.functionalResult === "succeeded"
    ? { type: "objective_completed", reasonCode: "OPERATION_COMPLETED", safeActions: [] }
    : {
        type: "environment_unavailable",
        reasonCode: outcome.reasonCode ?? "ADAPTIVE_OPERATION_FAILED",
        safeActions: ["resume_session"],
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
