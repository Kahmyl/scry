import { createHash } from "node:crypto";

import {
  executionCapabilityManifestSchema,
  executionRequestSchema,
  operationOutcomeSchema,
  type CurrentAction,
  type ExecutionCapabilityManifest,
  type ExecutionCapabilityName,
  type ExecutionMode,
  type ExecutionRequest,
  type OperationOutcome,
} from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { armExpectedEffect, verifyExpectedEffect } from "@scry/praxis";
import type { Page } from "playwright";
import type { SafeBrowserSession } from "./browser-session.js";

import { executeAction } from "./action-runtime.js";
import { InteractionLifecycleTracker } from "./interaction-lifecycle.js";
import { executePlan } from "./executor.js";
import { classifyOutcome } from "./execution-outcome.js";
import { probeFlowPlan, type ProbeExecutionLevel, type ProbeExecutionResult } from "./probe.js";
import type { ExecuteOptions, ExecutionReport } from "./types.js";

const CAPABILITIES: ExecutionCapabilityName[] = [
  "browser",
  "praxis",
  "veil",
  "evidence",
  "journal",
  "protected_input",
  "protected_operations",
  "checkpoint",
  "calibration",
];

export type ExecutionKernelJournal = {
  begin(input: {
    request: ExecutionRequest;
    manifest: ExecutionCapabilityManifest;
    startedAt: string;
  }): Promise<void>;
  complete(input: {
    request: ExecutionRequest;
    outcome: OperationOutcome;
    completedAt: string;
  }): Promise<void>;
  fail(input: {
    request: ExecutionRequest;
    reasonCode: string;
    outcome: OperationOutcome;
    completedAt: string;
  }): Promise<void>;
  settle?(input: {
    request: ExecutionRequest;
    outcome: OperationOutcome;
    completedAt: string;
    state: "completed" | "failed";
    reasonCode?: string;
    mutation?: {
      mutationIdentity: string;
      fencingToken: number;
      expected: "dispatching";
      next: "reconciled_succeeded" | "reconciled_not_applied" | "outcome_unknown";
    };
  }): Promise<void>;
};

export type ExecutionMutationFence = {
  claim(input: {
    mutationIdentity: string;
    requestDigest: string;
  }): Promise<{ state: string; fencingToken: number }>;
  transition(input: {
    mutationIdentity: string;
    fencingToken: number;
    expected: string;
    next: string;
  }): Promise<boolean>;
};

export type RuntimeExecutionCapabilities = {
  manifest: ExecutionCapabilityManifest;
  journal: ExecutionKernelJournal;
  mutationFence?: ExecutionMutationFence;
  options: Omit<ExecuteOptions, "plan" | "policy">;
  compatibilityOptions?: Omit<ExecuteOptions, "plan" | "policy">;
};

type ActiveMutationFence = {
  capabilities: RuntimeExecutionCapabilities;
  request: ExecutionRequest;
  fencingToken: number;
};

export class ExecutionAdmissionError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_CAPABILITY_INCOMPLETE"
      | "EXECUTION_CAPABILITY_BINDING_MISMATCH"
      | "EXECUTION_CAPABILITY_DIGEST_MISMATCH"
      | "EXECUTION_MODE_POLICY_DENIED"
      | "EXECUTION_REQUEST_INVALID"
      | "EXECUTION_MUTATION_IDENTITY_REQUIRED"
      | "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
    readonly mode: ExecutionMode,
    readonly missingCapabilities: ExecutionCapabilityName[] = [],
  ) {
    super(code);
  }
}

export class ExecutionKernel {
  constructor(
    private readonly dispatchPlan: (
      options: ExecuteOptions,
    ) => Promise<ExecutionReport> = executePlan,
  ) {}

  admitOnly(input: {
    request: ExecutionRequest;
    capabilities: RuntimeExecutionCapabilities;
  }): ExecutionRequest {
    return this.admit(input.request, input.capabilities);
  }

  async observe<T>(input: {
    request: ExecutionRequest;
    capabilities: RuntimeExecutionCapabilities;
    perform(): Promise<T>;
  }): Promise<{ value: T; outcome: OperationOutcome }> {
    const request = this.admit(input.request, input.capabilities, true);
    await input.capabilities.journal.begin({
      request,
      manifest: input.capabilities.manifest,
      startedAt: new Date().toISOString(),
    });
    const startedAt = performance.now();
    try {
      const value = await input.perform();
      const outcome = operationOutcomeSchema.parse({
        operationId: request.operationId,
        functionalResult: "succeeded",
        mutationOutcome: "not_applied",
        privacyResult: "unverified",
        evidenceResult: requestedEvidenceWithoutArtifacts(request),
        qualityFindings: [],
        durationMs: performance.now() - startedAt,
      });
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        completedAt: new Date().toISOString(),
        state: "completed",
      });
      return { value, outcome };
    } catch (error) {
      const outcome = failureOutcome(request, [], startedAt, error, false);
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        reasonCode: safeCode(error),
        completedAt: new Date().toISOString(),
        state: "failed",
      });
      throw error;
    }
  }

  async execute(input: {
    request: ExecutionRequest;
    capabilities: RuntimeExecutionCapabilities;
  }): Promise<{ report: ExecutionReport; outcome: OperationOutcome }> {
    const request = this.admit(input.request, input.capabilities);
    await input.capabilities.journal.begin({
      request,
      manifest: input.capabilities.manifest,
      startedAt: new Date().toISOString(),
    });
    const startedAt = performance.now();
    const praxisResults: import("@scry/contracts").PraxisResult[] = [];
    const lifecycle = new InteractionLifecycleTracker();
    let protectedTelemetryReason: string | undefined;
    const originalPraxisResult = input.capabilities.options.onPraxisResult;
    const originalEvent = input.capabilities.options.onEvent;
    const originalMutationDispatch = input.capabilities.options.onMutationDispatch;
    const originalPrivacyBoundary = input.capabilities.options.onPrivacyBoundary;
    let fence: ActiveMutationFence | undefined;
    try {
      fence = await this.beginMutationFence(request, input.capabilities);
      const report = await this.dispatchPlan({
        ...input.capabilities.options,
        plan: request.plan,
        policy: request.policy,
        onPraxisResult: async (result) => {
          praxisResults.push(result);
          await originalPraxisResult?.(result);
        },
        onMutationDispatch: async () => lifecycle.beforeDispatch(originalMutationDispatch),
        onPrivacyBoundary: async (phase) => {
          lifecycle.recordPrivacy(phase);
          await originalPrivacyBoundary?.(phase);
        },
        onEvent: async (event) => {
          protectedTelemetryReason =
            protectedTelemetryReasonCode(event) ?? protectedTelemetryReason;
          await originalEvent?.(event);
        },
      });
      const outcome = outcomeFromReport(
        request,
        report,
        praxisResults,
        protectedTelemetryReason,
        startedAt,
        lifecycle,
      );
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        completedAt: new Date().toISOString(),
        state: "completed",
        ...(fence ? { mutation: mutationSettlement(fence, outcome.mutationOutcome) } : {}),
      });
      return { report, outcome };
    } catch (error) {
      const outcome = failureOutcome(
        request,
        praxisResults,
        startedAt,
        error,
        request.plan.steps.some((step) => isMutatingAction(step.action)),
        lifecycle,
      );
      await settleOperation(input.capabilities.journal, {
        request,
        reasonCode: safeCode(error),
        outcome,
        completedAt: new Date().toISOString(),
        state: "failed",
        ...(fence ? { mutation: mutationSettlement(fence, outcome.mutationOutcome) } : {}),
      });
      throw error;
    }
  }

  async probe(input: {
    request: ExecutionRequest;
    capabilities: RuntimeExecutionCapabilities;
    level: ProbeExecutionLevel;
  }): Promise<ProbeExecutionResult> {
    const request = this.admit(input.request, input.capabilities, input.level === "inspection");
    if (input.level !== "inspection") {
      return probeFlowPlan({
        plan: request.plan,
        level: input.level,
        policy: request.policy,
        browserChannel: input.capabilities.options.browserChannel ?? "chromium",
        outputDirectory: input.capabilities.options.outputDirectory,
        privacy: {
          environmentId: input.capabilities.options.environmentId ?? "",
          veilAdmissionKey: input.capabilities.options.veilAdmissionKey ?? "",
        },
        ...(input.capabilities.options.secretResolver
          ? { secretResolver: input.capabilities.options.secretResolver }
          : {}),
        ...(input.capabilities.options.captureBrowserState
          ? { captureBrowserState: input.capabilities.options.captureBrowserState }
          : {}),
        ...(input.capabilities.options.openBrowser
          ? { openBrowser: input.capabilities.options.openBrowser }
          : {}),
        execute: async (options) =>
          (
            await this.execute({
              request: {
                ...request,
                plan: options.plan,
              },
              capabilities: {
                ...input.capabilities,
                options: {
                  ...input.capabilities.options,
                  ...options,
                },
              },
            })
          ).report,
      });
    }
    await input.capabilities.journal.begin({
      request,
      manifest: input.capabilities.manifest,
      startedAt: new Date().toISOString(),
    });
    const startedAt = performance.now();
    try {
      const result = await probeFlowPlan({
        plan: request.plan,
        level: input.level,
        policy: request.policy,
        browserChannel: input.capabilities.options.browserChannel ?? "chromium",
        outputDirectory: input.capabilities.options.outputDirectory,
        privacy: {
          environmentId: input.capabilities.options.environmentId ?? "",
          veilAdmissionKey: input.capabilities.options.veilAdmissionKey ?? "",
        },
        ...(input.capabilities.options.secretResolver
          ? { secretResolver: input.capabilities.options.secretResolver }
          : {}),
        ...(input.capabilities.options.captureBrowserState
          ? { captureBrowserState: input.capabilities.options.captureBrowserState }
          : {}),
        ...(input.capabilities.options.openBrowser
          ? { openBrowser: input.capabilities.options.openBrowser }
          : {}),
      });
      const outcome = operationOutcomeSchema.parse({
        operationId: request.operationId,
        functionalResult: result.allResolved ? "succeeded" : "inconclusive",
        mutationOutcome: "not_applied",
        privacyResult: result.runtimeHealthy ? "unverified" : "degraded",
        evidenceResult: requestedEvidenceWithoutArtifacts(request),
        qualityFindings: [],
        durationMs: performance.now() - startedAt,
        ...(!result.runtimeHealthy ? { reasonCode: "BROWSER_RUNTIME_UNHEALTHY" } : {}),
      });
      await input.capabilities.journal.complete({
        request,
        outcome,
        completedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      await input.capabilities.journal
        .fail({
          request,
          reasonCode: safeCode(error),
          outcome: failureOutcome(request, [], startedAt, error, false),
          completedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async interact(input: {
    request: Pick<
      ExecutionRequest,
      | "sessionId"
      | "operationId"
      | "correlationId"
      | "mode"
      | "policy"
      | "semanticContext"
      | "mutationIdentity"
    >;
    capabilities: RuntimeExecutionCapabilities;
    page: Page;
    safeSession?: SafeBrowserSession;
    existingProtectedSession?: boolean;
    action: CurrentAction;
    expectedEffect?: import("@scry/contracts").ExpectedEffect;
    resolveEffectPage?: () => Promise<Page | undefined>;
    ordinal: number;
    privacyGate?: import("@scry/veil").VeilRuntimeCoordinator;
  }): Promise<OperationOutcome> {
    const syntheticRequest = executionRequestSchema.parse({
      ...input.request,
      plan: singleActionPlan(input.action, input.request.policy, input.request.semanticContext),
      capabilityManifestDigest: input.capabilities.manifest.digest,
      idempotencyKey: `kernel-${input.request.operationId}`,
      ...(isMutatingAction(input.action)
        ? {
            mutationIdentity:
              input.request.mutationIdentity ?? `mutation-${input.request.operationId}`,
          }
        : {}),
    });
    if (input.action.type === "protectedTransaction") {
      return (
        await this.execute({
          request: syntheticRequest,
          capabilities: input.safeSession
            ? {
                ...input.capabilities,
                options: {
                  ...input.capabilities.options,
                  existingSafeSession: input.safeSession,
                  ...(input.existingProtectedSession ? { existingProtectedSession: true } : {}),
                },
              }
            : input.capabilities,
        })
      ).outcome;
    }
    const request = this.admit(syntheticRequest, input.capabilities);
    await input.capabilities.journal.begin({
      request,
      manifest: input.capabilities.manifest,
      startedAt: new Date().toISOString(),
    });
    const startedAt = performance.now();
    const lifecycle = new InteractionLifecycleTracker();
    let fence: ActiveMutationFence | undefined;
    try {
      fence = await this.beginMutationFence(request, input.capabilities);
      const beforeUrl = input.page.url();
      const expectedEffect = input.expectedEffect ?? { type: "none" };
      const armedEffect = armExpectedEffect(
        input.page,
        expectedEffect,
        "timeoutMs" in input.action ? input.action.timeoutMs : undefined,
      );
      let outcome = await executeInteractionCompatibility({
        sessionId: request.sessionId,
        operationId: request.operationId,
        page: input.page,
        action: input.action,
        ordinal: input.ordinal,
        policy: request.policy,
        lifecycle,
        options: {
          ...input.capabilities.options,
          expectedEffectVerificationOwner: "kernel",
        },
        ...(input.privacyGate ? { privacyGate: input.privacyGate } : {}),
      });
      if (outcome.functionalResult === "succeeded") {
        const effectStartedAt = performance.now();
        try {
          const resolvedEffectPage = await input.resolveEffectPage?.();
          if (
            expectedEffect.type === "new_page" &&
            (!resolvedEffectPage || resolvedEffectPage === input.page)
          ) {
            throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
          }
          const effectPage = resolvedEffectPage ?? input.page;
          const timeoutMs =
            ("timeoutMs" in input.action ? input.action.timeoutMs : undefined) ?? 10_000;
          if (expectedEffect.type === "new_page") {
            verifyAdoptedPopup(effectPage, beforeUrl, expectedEffect.origin);
          } else {
            await verifyExpectedEffect(
              effectPage,
              expectedEffect,
              beforeUrl,
              timeoutMs,
              effectPage === input.page ? armedEffect : undefined,
            );
          }
          await input.capabilities.options.onExpectedEffectVerification?.({
            status: "succeeded",
            durationMs: performance.now() - effectStartedAt,
          });
        } catch (error) {
          await input.capabilities.options.onExpectedEffectVerification?.({
            status: "failed",
            reasonCode: safeCode(error),
            durationMs: performance.now() - effectStartedAt,
          });
          outcome = operationOutcomeSchema.parse({
            ...outcome,
            functionalResult: "failed",
            reasonCode:
              safeCode(error) === "EXECUTION_KERNEL_FAILED"
                ? "EXPECTED_EFFECT_NOT_OBSERVED"
                : safeCode(error),
            ...safeNavigationEnvironmentFailure(error),
            ...(outcome.mutationOutcome === "applied"
              ? {
                  nextDecisionBoundary: {
                    type: "effect_observation_required",
                    reasonCode:
                      safeCode(error) === "EXECUTION_KERNEL_FAILED"
                        ? "EXPECTED_EFFECT_NOT_OBSERVED"
                        : safeCode(error),
                    safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
                  },
                }
              : {}),
          });
        }
      }
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        completedAt: new Date().toISOString(),
        state: "completed",
        ...(fence ? { mutation: mutationSettlement(fence, outcome.mutationOutcome) } : {}),
      });
      return outcome;
    } catch (error) {
      const outcome = failureOutcome(
        request,
        [],
        startedAt,
        error,
        isMutatingAction(input.action),
        lifecycle,
      );
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        reasonCode: safeCode(error),
        completedAt: new Date().toISOString(),
        state: "failed",
        ...(fence ? { mutation: mutationSettlement(fence, outcome.mutationOutcome) } : {}),
      });
      throw error;
    }
  }

  async interactWithReport(input: {
    request: Pick<
      ExecutionRequest,
      | "sessionId"
      | "operationId"
      | "correlationId"
      | "mode"
      | "policy"
      | "semanticContext"
      | "mutationIdentity"
    >;
    capabilities: RuntimeExecutionCapabilities;
    page: Page;
    safeSession?: SafeBrowserSession;
    existingProtectedSession?: boolean;
    action: CurrentAction;
    expectedEffect?: import("@scry/contracts").ExpectedEffect;
    resolveEffectPage?: () => Promise<Page | undefined>;
    ordinal: number;
    privacyGate?: import("@scry/veil").VeilRuntimeCoordinator;
  }): Promise<{ report: ExecutionReport; outcome: OperationOutcome }> {
    const syntheticRequest = executionRequestSchema.parse({
      ...input.request,
      plan: singleActionPlan(input.action, input.request.policy, input.request.semanticContext, {
        captureEvidence: true,
        veilPolicySnapshot: input.capabilities.options.veilPolicySnapshot,
        expectedEffect: input.expectedEffect ?? { type: "none" },
      }),
      capabilityManifestDigest: input.capabilities.manifest.digest,
      idempotencyKey: `kernel-${input.request.operationId}`,
      ...(isMutatingAction(input.action)
        ? {
            mutationIdentity:
              input.request.mutationIdentity ?? `mutation-${input.request.operationId}`,
          }
        : {}),
    });
    const request = this.admit(syntheticRequest, input.capabilities);
    await input.capabilities.journal.begin({
      request,
      manifest: input.capabilities.manifest,
      startedAt: new Date().toISOString(),
    });
    const startedAt = performance.now();
    const praxisResults: import("@scry/contracts").PraxisResult[] = [];
    const lifecycle = new InteractionLifecycleTracker();
    let protectedTelemetryReason: string | undefined;
    const originalPraxisResult = input.capabilities.options.onPraxisResult;
    const originalEvent = input.capabilities.options.onEvent;
    const originalMutationDispatch = input.capabilities.options.onMutationDispatch;
    const originalPrivacyBoundary = input.capabilities.options.onPrivacyBoundary;
    let fence: ActiveMutationFence | undefined;
    try {
      fence = await this.beginMutationFence(request, input.capabilities);
      const beforeUrl = input.page.url();
      const expectedEffect = input.expectedEffect ?? { type: "none" };
      const armedEffect = armExpectedEffect(
        input.page,
        expectedEffect,
        "timeoutMs" in input.action ? input.action.timeoutMs : undefined,
      );
      let report = await this.dispatchPlan({
        ...input.capabilities.options,
        plan: request.plan,
        policy: request.policy,
        ...(input.safeSession ? { existingSafeSession: input.safeSession } : {}),
        ...(input.existingProtectedSession ? { existingProtectedSession: true } : {}),
        expectedEffectVerificationOwner: "kernel",
        recordingOperationId: request.operationId,
        expectedDocumentTransition:
          input.action.type === "navigate" || expectedEffect.type === "navigation",
        onPraxisResult: async (result) => {
          praxisResults.push(result);
          await originalPraxisResult?.(result);
        },
        onMutationDispatch: async () => lifecycle.beforeDispatch(originalMutationDispatch),
        onPrivacyBoundary: async (phase) => {
          lifecycle.recordPrivacy(phase);
          await originalPrivacyBoundary?.(phase);
        },
        onEvent: async (event) => {
          protectedTelemetryReason =
            protectedTelemetryReasonCode(event) ?? protectedTelemetryReason;
          await originalEvent?.(event);
        },
      });
      let outcome = outcomeFromReport(
        request,
        report,
        praxisResults,
        protectedTelemetryReason,
        startedAt,
        lifecycle,
      );
      if (outcome.functionalResult === "succeeded") {
        const effectStartedAt = performance.now();
        try {
          const resolvedEffectPage = await input.resolveEffectPage?.();
          if (
            expectedEffect.type === "new_page" &&
            (!resolvedEffectPage || resolvedEffectPage === input.page)
          ) {
            throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
          }
          const effectPage = resolvedEffectPage ?? input.page;
          const timeoutMs =
            ("timeoutMs" in input.action ? input.action.timeoutMs : undefined) ?? 10_000;
          if (expectedEffect.type === "new_page") {
            verifyAdoptedPopup(effectPage, beforeUrl, expectedEffect.origin);
          } else {
            await verifyExpectedEffect(
              effectPage,
              expectedEffect,
              beforeUrl,
              timeoutMs,
              effectPage === input.page ? armedEffect : undefined,
            );
          }
          await input.capabilities.options.onExpectedEffectVerification?.({
            status: "succeeded",
            durationMs: performance.now() - effectStartedAt,
          });
        } catch (error) {
          const reasonCode =
            safeCode(error) === "EXECUTION_KERNEL_FAILED"
              ? "EXPECTED_EFFECT_NOT_OBSERVED"
              : safeCode(error);
          await input.capabilities.options.onExpectedEffectVerification?.({
            status: "failed",
            reasonCode,
            durationMs: performance.now() - effectStartedAt,
          });
          outcome = operationOutcomeSchema.parse({
            ...outcome,
            functionalResult: "failed",
            reasonCode,
            ...safeNavigationEnvironmentFailure(error),
            ...(outcome.mutationOutcome === "applied"
              ? {
                  nextDecisionBoundary: {
                    type: "effect_observation_required",
                    reasonCode,
                    safeActions: ["get_run", "get_praxis_session", "observe_praxis_session"],
                  },
                }
              : {}),
          });
          report = applyExpectedEffectFailure(report, reasonCode);
        }
      }
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        completedAt: new Date().toISOString(),
        state: "completed",
        ...(fence ? { mutation: mutationSettlement(fence, outcome.mutationOutcome) } : {}),
      });
      return { report, outcome };
    } catch (error) {
      const outcome = failureOutcome(
        request,
        praxisResults,
        startedAt,
        error,
        isMutatingAction(input.action),
        lifecycle,
      );
      await settleOperation(input.capabilities.journal, {
        request,
        outcome,
        reasonCode: safeCode(error),
        completedAt: new Date().toISOString(),
        state: "failed",
        ...(fence ? { mutation: mutationSettlement(fence, outcome.mutationOutcome) } : {}),
      });
      throw error;
    }
  }

  private admit(
    candidate: ExecutionRequest,
    capabilities: RuntimeExecutionCapabilities,
    inspection = false,
  ): ExecutionRequest {
    const parsed = executionRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ExecutionAdmissionError("EXECUTION_REQUEST_INVALID", candidate.mode);
    }
    const manifest = executionCapabilityManifestSchema.parse(capabilities.manifest);
    if (
      manifest.mode !== parsed.data.mode ||
      manifest.correlationId !== parsed.data.correlationId
    ) {
      throw new ExecutionAdmissionError("EXECUTION_CAPABILITY_BINDING_MISMATCH", parsed.data.mode);
    }
    if (manifest.digest !== parsed.data.capabilityManifestDigest) {
      throw new ExecutionAdmissionError("EXECUTION_CAPABILITY_DIGEST_MISMATCH", parsed.data.mode);
    }
    const required = requiredCapabilities(parsed.data);
    const missing = CAPABILITIES.filter((name) => {
      if (!required.has(name)) return false;
      const state = manifest.capabilities[name]?.state;
      return !state || state === "unavailable" || state === "policy_denied";
    });
    if (missing.length) {
      throw new ExecutionAdmissionError(
        "EXECUTION_CAPABILITY_INCOMPLETE",
        parsed.data.mode,
        missing,
      );
    }
    if (
      !inspection &&
      modeDenied(
        parsed.data.mode,
        parsed.data.plan.steps.map((step) => step.action),
      )
    ) {
      throw new ExecutionAdmissionError("EXECUTION_MODE_POLICY_DENIED", parsed.data.mode);
    }
    if (
      parsed.data.plan.steps.some((step) => isMutatingAction(step.action)) &&
      !parsed.data.mutationIdentity
    ) {
      throw new ExecutionAdmissionError("EXECUTION_MUTATION_IDENTITY_REQUIRED", parsed.data.mode);
    }
    if (
      parsed.data.plan.steps.some((step) => isMutatingAction(step.action)) &&
      !capabilities.journal.settle
    ) {
      throw new ExecutionAdmissionError("EXECUTION_CAPABILITY_INCOMPLETE", parsed.data.mode, [
        "journal",
      ]);
    }
    if (
      parsed.data.plan.steps.some(
        (step) => step.action.type === "protectedTransaction" && !step.action.operationId,
      )
    ) {
      throw new ExecutionAdmissionError("EXECUTION_MUTATION_IDENTITY_REQUIRED", parsed.data.mode);
    }
    return parsed.data;
  }

  private async beginMutationFence(
    request: ExecutionRequest,
    capabilities: RuntimeExecutionCapabilities,
  ) {
    if (request.plan.steps.some((step) => step.action.type === "protectedTransaction")) {
      return undefined;
    }
    if (
      !request.mutationIdentity ||
      !request.plan.steps.some((step) => isMutatingAction(step.action))
    ) {
      return undefined;
    }
    if (!capabilities.mutationFence) {
      throw new ExecutionAdmissionError("EXECUTION_CAPABILITY_INCOMPLETE", request.mode, [
        "journal",
      ]);
    }
    const claim = await capabilities.mutationFence.claim({
      mutationIdentity: request.mutationIdentity,
      requestDigest: mutationRequestDigest(request),
    });
    if (claim.state !== "planned") {
      throw new ExecutionAdmissionError(
        "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
        request.mode,
      );
    }
    const transitioned = await capabilities.mutationFence.transition({
      mutationIdentity: request.mutationIdentity,
      fencingToken: claim.fencingToken,
      expected: "planned",
      next: "dispatching",
    });
    if (!transitioned) {
      throw new ExecutionAdmissionError(
        "EXECUTION_UNKNOWN_MUTATION_REQUIRES_RECONCILIATION",
        request.mode,
      );
    }
    return { capabilities, request, fencingToken: claim.fencingToken };
  }
}

export async function executeInteractionCompatibility(input: {
  sessionId: string;
  operationId: string;
  page: Page;
  action: CurrentAction;
  ordinal: number;
  policy: ExecutionRequest["policy"];
  options: Omit<ExecuteOptions, "plan" | "policy">;
  privacyGate?: import("@scry/veil").VeilRuntimeCoordinator;
  lifecycle?: InteractionLifecycleTracker;
}): Promise<OperationOutcome> {
  const startedAt = performance.now();
  const lifecycle = input.lifecycle ?? new InteractionLifecycleTracker();
  const praxisResults: import("@scry/contracts").PraxisResult[] = [];
  let rejectedCandidateDistinctions: Array<{ label: string; distinction: string }> | undefined;
  try {
    const beforeDispatch = async () => {
      await lifecycle.beforeDispatch(input.options.onMutationDispatch);
    };
    await executeAction(
      input.page,
      input.action,
      {
        ...input.options,
        onMutationDispatch: beforeDispatch,
        onPrivacyBoundary: async (phase) => {
          lifecycle.recordPrivacy(phase);
          await input.options.onPrivacyBoundary?.(phase);
        },
        plan: singleActionPlan(input.action, input.policy),
        policy: input.policy,
      },
      input.options.signal ?? new AbortController().signal,
      new SecretRedactor(),
      new Map(),
      new Map(),
      input.privacyGate,
      undefined,
      {
        runId: input.sessionId,
        stepId: input.operationId,
        channel: "action",
        ordinal: input.ordinal,
        allowedOrigins: input.policy.allowedOrigins,
        timeoutMs:
          "timeoutMs" in input.action && input.action.timeoutMs ? input.action.timeoutMs : 30_000,
        onGroundingDiagnostic: async (diagnostic) => {
          await input.options.onGroundingDiagnostic?.(diagnostic);
          if (
            diagnostic.outcome === "rejected" &&
            (diagnostic.code === "TARGET_AMBIGUOUS" ||
              diagnostic.code === "INSUFFICIENT_EVIDENCE") &&
            diagnostic.candidateDistinctions?.length
          ) {
            rejectedCandidateDistinctions = diagnostic.candidateDistinctions;
          }
        },
        beforeMutation: beforeDispatch,
        record: async (result) => {
          praxisResults.push(result);
          await input.options.onPraxisResult?.(result);
        },
      },
    );
    return operationOutcomeSchema.parse({
      operationId: input.operationId,
      functionalResult: "succeeded",
      mutationOutcome: !isMutatingAction(input.action)
        ? "not_applied"
        : praxisResults.length === 0
          ? "applied"
          : praxisMutationOutcome(praxisResults),
      privacyResult:
        (input.action.type === "fill" &&
          Boolean(input.action.secretRef || input.action.capturedSecretRef)) ||
        input.action.type === "protectedAuthentication" ||
        input.action.type === "sameOriginRequest"
          ? "verified"
          : "unverified",
      evidenceResult: [],
      qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
      ...resolvedTargetOutcome(praxisResults),
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    const reasonCode = safeCode(error);
    const observedMutation = praxisMutationOutcome(praxisResults);
    return operationOutcomeSchema.parse({
      operationId: input.operationId,
      functionalResult: "failed",
      mutationOutcome: lifecycle.mutationFailure(isMutatingAction(input.action), observedMutation),
      privacyResult: lifecycle.privacyFailure(privacyOutcomeFromError(reasonCode)),
      evidenceResult: evidenceOutcomeFromError(reasonCode),
      qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
      ...resolvedTargetOutcome(praxisResults),
      durationMs: performance.now() - startedAt,
      reasonCode,
      ...safeEnvironmentFailure(error),
      ...(rejectedCandidateDistinctions &&
      (reasonCode === "PRAXIS_TARGET_AMBIGUOUS" || reasonCode === "PRAXIS_INSUFFICIENT_EVIDENCE")
        ? {
            nextDecisionBoundary: {
              type: "ambiguous_candidate",
              reasonCode,
              safeActions: ["observe_praxis_session"],
              candidateDistinctions: rejectedCandidateDistinctions,
            },
          }
        : {}),
    });
  }
}

export function createExecutionCapabilityManifest(input: {
  mode: ExecutionMode;
  correlationId: string;
  states?: Partial<Record<ExecutionCapabilityName, "available" | "policy_denied" | "unavailable">>;
}): ExecutionCapabilityManifest {
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((name) => [name, { state: input.states?.[name] ?? "available" }]),
  ) as ExecutionCapabilityManifest["capabilities"];
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 1, mode: input.mode, capabilities }))
    .digest("hex");
  return executionCapabilityManifestSchema.parse({
    version: 1,
    mode: input.mode,
    correlationId: input.correlationId,
    capabilities,
    digest,
  });
}

function modeDenied(mode: ExecutionMode, actions: CurrentAction[]): boolean {
  if (mode === "run" || mode === "certify" || mode === "transact") return false;
  if (mode === "observe") return actions.some((action) => !isObservationAction(action));
  return actions.some((action) => action.type === "protectedTransaction");
}

function verifyAdoptedPopup(page: Page, beforeUrl: string, expectedOrigin?: string) {
  const actual = new URL(page.url());
  if (
    actual.href === beforeUrl ||
    (expectedOrigin && actual.origin !== new URL(expectedOrigin).origin)
  ) {
    throw new Error("EXPECTED_NEW_PAGE_NOT_OBSERVED");
  }
}

function isMutatingAction(action: CurrentAction): boolean {
  if (action.type === "click") return action.dispatchSemantics !== "read_only";
  if (action.type === "press") return action.dispatchSemantics !== "read_only";
  return (
    ["fill", "select", "check", "protectedAuthentication", "protectedTransaction"].includes(
      action.type,
    ) ||
    (action.type === "sameOriginRequest" && action.method !== "GET")
  );
}

function isObservationAction(action: CurrentAction): boolean {
  if (action.type === "click") return action.dispatchSemantics === "read_only";
  if (action.type === "press") return action.dispatchSemantics === "read_only";
  if (action.type === "sameOriginRequest") return action.method === "GET";
  return ["navigate", "waitFor", "scroll", "screenshot", "capturePublicValue"].includes(
    action.type,
  );
}

function singleActionPlan(
  action: CurrentAction,
  policy: ExecutionRequest["policy"],
  semanticContext?: string,
  options: {
    captureEvidence?: boolean;
    veilPolicySnapshot?: ExecuteOptions["veilPolicySnapshot"];
    expectedEffect?: import("@scry/contracts").ExpectedEffect;
  } = {},
) {
  const captureEvidence = options.captureEvidence === true;
  const evidenceReadiness = captureEvidence
    ? interactionEvidenceReadiness(action, options.expectedEffect)
    : undefined;
  const continuationSteps =
    action.type === "protectedTransaction"
      ? action.continuation.strategies.flatMap((strategy) => {
          if (!("continueAtStepId" in strategy)) return [];
          const targetAssertion = strategy.assertions.find((assertion) => "target" in assertion);
          const continuationTarget =
            targetAssertion && "target" in targetAssertion ? targetAssertion.target : undefined;
          return [
            {
              id: strategy.continueAtStepId,
              title: "Resume after protected interaction",
              action: continuationTarget
                ? {
                    type: "waitFor" as const,
                    target: continuationTarget,
                    state: "visible" as const,
                    timeoutMs: targetAssertion?.timeoutMs,
                  }
                : {
                    type: "navigate" as const,
                    url: strategy.reentryUrl,
                    timeoutMs: 10_000,
                  },
              assertions: [],
              onFailure: "stop" as const,
              evidence: [],
              captureIntent: "transient" as const,
              transientJustification: "Protected continuation contract boundary.",
            },
          ];
        })
      : [];
  return {
    name: "Kernel interactive operation",
    objective: semanticContext ?? "Execute one bounded semantic interaction",
    preconditions: [],
    allowedOrigins: policy.allowedOrigins,
    budgets: {
      maxActions: 1 + continuationSteps.length,
      maxDurationMs: policy.maxDurationMs ?? 30_000,
      maxNavigations: 1 + continuationSteps.length,
    },
    checkpoints: [],
    steps: [
      {
        id: "kernel-interaction",
        title: "Kernel interaction",
        action,
        assertions: [],
        onFailure: "stop" as const,
        ...(evidenceReadiness ? { after: evidenceReadiness } : {}),
        evidence: captureEvidence ? requestedInteractionEvidence(options.veilPolicySnapshot) : [],
        captureIntent: captureEvidence ? ("final" as const) : ("transient" as const),
        ...(captureEvidence
          ? {}
          : {
              transientJustification: "Internal kernel operation contract.",
            }),
      },
      ...continuationSteps,
    ],
  };
}

function interactionEvidenceReadiness(
  action: CurrentAction,
  expectedEffect?: import("@scry/contracts").ExpectedEffect,
) {
  const requiresSettlement = [
    "navigate",
    "click",
    "press",
    "select",
    "check",
    "protectedAuthentication",
  ].includes(action.type);

  if (!requiresSettlement) return undefined;

  const requestedTimeoutMs =
    "timeoutMs" in action && typeof action.timeoutMs === "number" ? action.timeoutMs : 15_000;
  const timeoutMs = Math.min(60_000, Math.max(100, requestedTimeoutMs));

  if (expectedEffect?.type === "navigation" && expectedEffect.url) {
    return {
      mode: "all" as const,
      timeoutMs,
      conditions: [
        {
          type: "url" as const,
          expected: expectedEffect.url,
          match: expectedEffect.match,
        },
      ],
    };
  }

  if (expectedEffect?.type === "visibility_change") {
    return {
      mode: "all" as const,
      timeoutMs,
      conditions: [
        expectedEffect.visible
          ? {
              type: "visible" as const,
              target: expectedEffect.target,
            }
          : {
              type: "hidden" as const,
              target: expectedEffect.target,
            },
      ],
    };
  }

  if (expectedEffect?.type === "value_change" && typeof expectedEffect.expected === "string") {
    return {
      mode: "all" as const,
      timeoutMs,
      conditions: [
        {
          type: "value" as const,
          target: expectedEffect.target,
          expected: expectedEffect.expected,
        },
      ],
    };
  }

  if (expectedEffect?.type === "state_change" && typeof expectedEffect.checked === "boolean") {
    return {
      mode: "all" as const,
      timeoutMs,
      conditions: [
        {
          type: "checked" as const,
          target: expectedEffect.target,
          expected: expectedEffect.checked,
        },
      ],
    };
  }

  if (expectedEffect?.type === "new_region") {
    return {
      mode: "all" as const,
      timeoutMs,
      conditions: [
        {
          type: "visible" as const,
          target: expectedEffect.target,
        },
      ],
    };
  }

  if (expectedEffect?.type === "network_outcome") {
    return {
      mode: "all" as const,
      timeoutMs,
      conditions: [
        {
          type: "request" as const,
          urlPattern: expectedEffect.urlPattern,
          ...(expectedEffect.method ? { method: expectedEffect.method } : {}),
          status: {
            min: expectedEffect.statusMin,
            max: expectedEffect.statusMax,
          },
        },
      ],
    };
  }

  /*
   * Agent-directed read-context clicks and protected authentication
   * currently may have no semantic ExpectedEffect. They still must
   * settle before final evidence. This is deliberately DOM quiescence,
   * not a fixed delay; Veil remains the final capture authority.
   */
  return {
    mode: "all" as const,
    timeoutMs,
    conditions: [
      {
        type: "domStable" as const,
        quietWindowMs: 500,
      },
    ],
  };
}

function requestedInteractionEvidence(
  veilPolicySnapshot?: ExecuteOptions["veilPolicySnapshot"],
): Array<"screenshot" | "dom" | "network"> {
  if (!veilPolicySnapshot) return [];
  const evidence: Array<"screenshot" | "dom" | "network"> = [];
  if (veilPolicySnapshot.controls.screenshots) evidence.push("screenshot");
  if (veilPolicySnapshot.controls.dom) evidence.push("dom");
  if (veilPolicySnapshot.controls.network) evidence.push("network");
  return evidence;
}

function applyExpectedEffectFailure(report: ExecutionReport, reasonCode: string): ExecutionReport {
  const next = structuredClone(report);
  const step = next.steps.at(-1);
  if (step) {
    step.status = "failed";
    step.error = reasonCode;
    step.action = { status: "failed", error: reasonCode };
  }
  next.state = "failed";
  next.error = reasonCode;
  next.outcomeClassification = classifyOutcome(next.state, next.steps, next.policyViolations);
  return next;
}

function outcomeFromReport(
  request: ExecutionRequest,
  report: ExecutionReport,
  praxisResults: import("@scry/contracts").PraxisResult[],
  protectedTelemetryReason: string | undefined,
  startedAt: number,
  lifecycle?: InteractionLifecycleTracker,
): OperationOutcome {
  const observedMutation = praxisMutationOutcome(praxisResults);
  const praxisFailureReason = [...praxisResults]
    .reverse()
    .flatMap((result) => (result.status === "succeeded" ? [] : [result.code]))
    .at(0);
  const mutating = request.plan.steps.some((step) => isMutatingAction(step.action));
  const mutationOutcome = !mutating
    ? "not_applied"
    : report.state === "passed"
      ? observedMutation
      : (lifecycle?.mutationFailure(mutating, observedMutation) ??
        (observedMutation === "not_applied" && mutating && praxisResults.length === 0
          ? "unknown"
          : observedMutation));
  return operationOutcomeSchema.parse({
    operationId: request.operationId,
    functionalResult:
      report.state === "passed"
        ? "succeeded"
        : report.state === "infrastructure_error"
          ? "inconclusive"
          : "failed",
    mutationOutcome,
    privacyResult: privacyOutcomeFromReport(report),
    evidenceResult: evidenceOutcomeFromReport(report),
    qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
    ...resolvedTargetOutcome(praxisResults),
    durationMs: performance.now() - startedAt,
    ...(protectedTelemetryReason
      ? { reasonCode: protectedTelemetryReason }
      : report.error
        ? { reasonCode: safeCode(report.error) }
        : praxisFailureReason
          ? { reasonCode: praxisFailureReason }
          : {}),
  });
}

function protectedTelemetryReasonCode(event: import("@scry/contracts").RunEvent) {
  if (event.type !== "privacy.operation_completed") return undefined;
  const result = event.payload.result;
  if (!result || typeof result !== "object") return undefined;
  const reasonCode = (result as Record<string, unknown>).reasonCode;
  return typeof reasonCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(reasonCode)
    ? reasonCode
    : undefined;
}

function resolvedTargetOutcome(results: import("@scry/contracts").PraxisResult[]) {
  const resolved = [...results].reverse().find((result) => result.status === "succeeded");
  const target = resolved?.status === "succeeded" ? resolved.resolution.target : undefined;
  if (!target) return {};
  return {
    resolvedTarget: {
      version: 2 as const,
      digest: target.fingerprint,
      concept: target.concept,
      scopeKind: target.scopeKind,
      capabilityDigest: target.capabilityDigest,
      structuralPath: [],
    },
  };
}

function failureOutcome(
  request: ExecutionRequest,
  praxisResults: import("@scry/contracts").PraxisResult[],
  startedAt: number,
  error: unknown,
  mutating: boolean,
  lifecycle?: InteractionLifecycleTracker,
): OperationOutcome {
  const observedMutation = praxisMutationOutcome(praxisResults);
  const reasonCode = safeCode(error);
  const mutationOutcome =
    lifecycle?.mutationFailure(mutating, observedMutation) ??
    (observedMutation === "not_applied" && mutating && !isProvenPreDispatchFailure(reasonCode)
      ? "unknown"
      : observedMutation);
  return operationOutcomeSchema.parse({
    operationId: request.operationId,
    functionalResult: "inconclusive",
    mutationOutcome,
    privacyResult:
      lifecycle?.privacyFailure(privacyOutcomeFromError(reasonCode)) ??
      privacyOutcomeFromError(reasonCode),
    evidenceResult: evidenceOutcomeFromError(reasonCode),
    qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
    ...resolvedTargetOutcome(praxisResults),
    durationMs: performance.now() - startedAt,
    reasonCode,
    ...safeNavigationEnvironmentFailure(error),
  });
}

export function privacyOutcomeFromReport(
  report: ExecutionReport,
): OperationOutcome["privacyResult"] {
  if (
    report.artifacts.some(
      (artifact) =>
        artifact.availability === "quarantined" || artifact.privacyClassification === "uncertain",
    ) ||
    report.artifactTimeline.some(
      (entry) =>
        entry.type === "quarantine_record" ||
        (entry.type === "capture_epoch" && entry.status === "sealed"),
    )
  ) {
    return "sealed";
  }
  if (
    report.state === "infrastructure_error" ||
    report.artifacts.some((artifact) => ["failed", "incomplete"].includes(artifact.availability)) ||
    report.steps.some((step) => Boolean(step.evidenceFailures?.length)) ||
    report.artifactTimeline.some((entry) => entry.type === "unavailable_interval")
  ) {
    return "degraded";
  }
  const hasPrivacyProof =
    report.artifacts.some(
      (artifact) =>
        artifact.availability === "available" && artifact.privacyClassification === "safe",
    ) ||
    report.artifactTimeline.some(
      (entry) => entry.type === "capture_epoch" && entry.status === "completed",
    );
  return hasPrivacyProof ? "verified" : "unverified";
}

export function evidenceOutcomeFromReport(
  report: ExecutionReport,
): OperationOutcome["evidenceResult"] {
  const outcomes = new Map<
    OperationOutcome["evidenceResult"][number]["channel"],
    OperationOutcome["evidenceResult"][number]
  >();
  const priority = { available: 0, suppressed: 1, failed: 2, quarantined: 3 } as const;
  const record = (entry: OperationOutcome["evidenceResult"][number]) => {
    const existing = outcomes.get(entry.channel);
    if (!existing || priority[entry.state] > priority[existing.state]) {
      outcomes.set(entry.channel, entry);
    }
  };
  for (const artifact of report.artifacts) {
    const channel = artifact.kind;
    const state =
      artifact.availability === "available"
        ? "available"
        : artifact.availability === "quarantined"
          ? "quarantined"
          : artifact.availability === "destroyed"
            ? "suppressed"
            : "failed";
    record({
      channel,
      state,
      ...(artifact.reasonCode ? { reasonCode: artifact.reasonCode } : {}),
    });
  }
  for (const step of report.steps) {
    for (const failure of step.evidenceFailures ?? []) {
      record({ channel: failure.kind, state: "failed", reasonCode: safeCode(failure.error) });
    }
  }
  for (const entry of report.artifactTimeline) {
    if (entry.type === "quarantine_record") {
      const channel = evidenceChannel(entry.channel);
      if (channel) record({ channel, state: "quarantined", reasonCode: entry.reasonCode });
    } else if (entry.type === "trace_segment") {
      record({
        channel: "trace",
        state: entry.status === "available" ? "available" : entry.status,
        ...(entry.failureCode ? { reasonCode: entry.failureCode } : {}),
      });
    } else if (entry.type === "video_segment") {
      record({
        channel: "video",
        state: entry.status === "available" ? "available" : entry.status,
        ...(entry.failureCode ? { reasonCode: entry.failureCode } : {}),
      });
    } else if (entry.type === "protected_gap") {
      record({ channel: "video", state: "suppressed", reasonCode: "PROTECTED_CAPTURE_SUPPRESSED" });
    } else if (entry.type === "unavailable_interval") {
      record({ channel: "video", state: "failed", reasonCode: entry.failureCode });
    }
  }
  return [...outcomes.values()].sort((left, right) => left.channel.localeCompare(right.channel));
}

function privacyOutcomeFromError(reasonCode: string): OperationOutcome["privacyResult"] {
  if (/^(VEIL|PRIVACY|PROTECTED)_/.test(reasonCode)) return "sealed";
  if (/^(CAPTURE|SCREENSHOT|TRACE|VIDEO)_/.test(reasonCode)) return "degraded";
  return "unverified";
}

export function isProvenPreDispatchFailure(reasonCode: string) {
  return [
    "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
    "PRAXIS_TARGET_NOT_FOUND",
    "PRAXIS_TARGET_SCOPE_NOT_FOUND",
    "TARGET_NOT_FOUND",
    "NATIVE_TARGET_NOT_FOUND",
    "TARGET_AMBIGUOUS",
    "NATIVE_TARGET_AMBIGUOUS",
    "NO_CAPABILITY_COMPATIBLE_CONTROL",
    "STALE_OBSERVATION",
    "CAPABILITY_ADMISSION_DENIED",
    "POLICY_DENIED",
    "PRAXIS_INSUFFICIENT_EVIDENCE",
    "PRAXIS_VEIL_SCHEDULE_REFUSED",
    "PROTECTED_INPUT_REFERENCE_UNAVAILABLE",
    "PROTECTED_INPUT_RESOLVER_UNAVAILABLE",
    "EXECUTION_MODE_POLICY_DENIED",
    "EXECUTION_CAPABILITY_INCOMPLETE",
  ].includes(reasonCode);
}

function mutationSettlement(
  fence: { request: ExecutionRequest; fencingToken: number },
  outcome: OperationOutcome["mutationOutcome"],
) {
  return {
    mutationIdentity: fence.request.mutationIdentity!,
    fencingToken: fence.fencingToken,
    expected: "dispatching" as const,
    next:
      outcome === "applied"
        ? ("reconciled_succeeded" as const)
        : outcome === "not_applied"
          ? ("reconciled_not_applied" as const)
          : ("outcome_unknown" as const),
  };
}

async function settleOperation(
  journal: ExecutionKernelJournal,
  input: Parameters<NonNullable<ExecutionKernelJournal["settle"]>>[0],
) {
  if (journal.settle) return journal.settle(input);
  if (input.mutation) throw new Error("EXECUTION_ATOMIC_SETTLEMENT_REQUIRED");
  if (input.state === "completed") {
    return journal.complete({
      request: input.request,
      outcome: input.outcome,
      completedAt: input.completedAt,
    });
  }
  return journal.fail({
    request: input.request,
    outcome: input.outcome,
    reasonCode: input.reasonCode ?? input.outcome.reasonCode ?? "EXECUTION_KERNEL_FAILED",
    completedAt: input.completedAt,
  });
}

function evidenceOutcomeFromError(reasonCode: string): OperationOutcome["evidenceResult"] {
  if (/SCREENSHOT|CAPTURE/.test(reasonCode)) {
    return [{ channel: "screenshot", state: "failed", reasonCode }];
  }
  if (/TRACE/.test(reasonCode)) return [{ channel: "trace", state: "failed", reasonCode }];
  return [];
}

function requestedEvidenceWithoutArtifacts(
  request: ExecutionRequest,
): OperationOutcome["evidenceResult"] {
  const channels = new Set<OperationOutcome["evidenceResult"][number]["channel"]>();
  for (const step of request.plan.steps) {
    for (const evidence of step.evidence) channels.add(evidence);
    if (step.action.type === "screenshot") channels.add("screenshot");
  }
  return [...channels]
    .sort()
    .map((channel) => ({ channel, state: "failed" as const, reasonCode: "EVIDENCE_NOT_PRODUCED" }));
}

function evidenceChannel(
  value: string,
): OperationOutcome["evidenceResult"][number]["channel"] | undefined {
  return ["screenshot", "video", "trace", "dom", "network", "console", "report"].includes(value)
    ? (value as OperationOutcome["evidenceResult"][number]["channel"])
    : undefined;
}

function requiredCapabilities(request: ExecutionRequest): Set<ExecutionCapabilityName> {
  const required = new Set<ExecutionCapabilityName>(["browser", "journal"]);
  if (
    request.plan.steps.some((step) => {
      const target = "target" in step.action ? step.action.target : undefined;
      return Boolean(
        target &&
        (target.requiredCapabilities.includes("coordinate_action") ||
          target.preferredEvidence.visual?.sources.some((source) => source === "canvas")),
      );
    })
  ) {
    required.add("praxis");
  }
  if (
    request.plan.steps.some((step) => step.evidence.length > 0 || step.action.type === "screenshot")
  ) {
    required.add("evidence");
    required.add("veil");
  }
  if (
    request.plan.steps.some(
      (step) =>
        step.action.type === "protectedAuthentication" ||
        (step.action.type === "fill" &&
          Boolean(step.action.secretRef || step.action.capturedSecretRef)),
    )
  ) {
    required.add("protected_input");
    required.add("veil");
  }
  if (request.plan.steps.some((step) => step.action.type === "protectedTransaction")) {
    required.add("protected_operations");
    required.add("veil");
    required.add("checkpoint");
  }
  if (request.plan.checkpoints.length) required.add("checkpoint");
  return required;
}

function mutationRequestDigest(request: ExecutionRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: request.mode,
        mutationIdentity: request.mutationIdentity,
        plan: request.plan,
        policy: request.policy,
      }),
    )
    .digest("hex");
}

function praxisMutationOutcome(
  results: import("@scry/contracts").PraxisResult[],
): "not_applied" | "applied" | "unknown" {
  if (results.some((result) => result.mutationOutcome === "unknown")) return "unknown";
  if (results.some((result) => result.mutationOutcome === "applied")) return "applied";
  return "not_applied";
}

function safeCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "EXECUTION_KERNEL_FAILED";
}

function safeEnvironmentFailure(error: unknown) {
  if (typeof error !== "object" || error === null || !("safeEnvironmentFailure" in error))
    return {};
  const details = (error as { safeEnvironmentFailure?: unknown }).safeEnvironmentFailure;
  if (typeof details !== "object" || details === null) return {};
  const candidate = details as Record<string, unknown>;
  if (
    candidate.missingOriginClassification !== "public" &&
    candidate.missingOriginClassification !== "redacted"
  )
    return {};
  if (
    !Array.isArray(candidate.missingTrustedScriptOrigins) ||
    candidate.missingTrustedScriptOrigins.length > 20 ||
    !candidate.missingTrustedScriptOrigins.every(
      (origin) => typeof origin === "string" && safeUrl(origin),
    )
  )
    return {};
  return {
    environmentFailure: {
      missingTrustedScriptOrigins: candidate.missingTrustedScriptOrigins as string[],
      missingOriginClassification: candidate.missingOriginClassification,
    },
  };
}

function safeNavigationEnvironmentFailure(error: unknown) {
  if (typeof error !== "object" || error === null || !("safeNavigationEnvironmentFailure" in error))
    return {};
  const details = (error as { safeNavigationEnvironmentFailure?: unknown })
    .safeNavigationEnvironmentFailure;
  if (typeof details !== "object" || details === null) return {};
  const missingAllowedOrigin = (details as Record<string, unknown>).missingAllowedOrigin;
  if (typeof missingAllowedOrigin !== "string" || !safeUrl(missingAllowedOrigin)) return {};
  return {
    navigationEnvironmentFailure: { missingAllowedOrigin: new URL(missingAllowedOrigin).origin },
  };
}

function safeUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
