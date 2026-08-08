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

import { executeAction } from "./action-runtime.js";
import { executePlan } from "./executor.js";
import { probeFlowPlan, type ProbeExecutionLevel, type ProbeExecutionResult } from "./probe.js";
import type { ExecuteOptions, ExecutionReport } from "./types.js";

const CAPABILITIES: ExecutionCapabilityName[] = [
  "browser",
  "praxis",
  "veil",
  "evidence",
  "journal",
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
    const protectedMutationOutcomes: Array<"not_applied" | "applied" | "unknown"> = [];
    const originalPraxisResult = input.capabilities.options.onPraxisResult;
    const originalEvent = input.capabilities.options.onEvent;
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
        onEvent: async (event) => {
          const protectedOutcome = protectedMutationOutcome(event);
          if (protectedOutcome) protectedMutationOutcomes.push(protectedOutcome);
          await originalEvent?.(event);
        },
      });
      const outcome = outcomeFromReport(
        request,
        report,
        praxisResults,
        protectedMutationOutcomes,
        startedAt,
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
    action: CurrentAction;
    expectedEffect?: import("@scry/contracts").ExpectedEffect;
    ordinal: number;
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
    const request = this.admit(syntheticRequest, input.capabilities);
    await input.capabilities.journal.begin({
      request,
      manifest: input.capabilities.manifest,
      startedAt: new Date().toISOString(),
    });
    const startedAt = performance.now();
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
        options: input.capabilities.options,
      });
      if (outcome.functionalResult === "succeeded") {
        try {
          await verifyExpectedEffect(
            input.page,
            expectedEffect,
            beforeUrl,
            ("timeoutMs" in input.action ? input.action.timeoutMs : undefined) ?? 10_000,
            armedEffect,
          );
        } catch (error) {
          outcome = operationOutcomeSchema.parse({
            ...outcome,
            functionalResult: "failed",
            reasonCode:
              safeCode(error) === "EXECUTION_KERNEL_FAILED"
                ? "EXPECTED_EFFECT_NOT_OBSERVED"
                : safeCode(error),
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
      const outcome = failureOutcome(request, [], startedAt, error, isMutatingAction(input.action));
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
}): Promise<OperationOutcome> {
  const startedAt = performance.now();
  const praxisResults: import("@scry/contracts").PraxisResult[] = [];
  try {
    await executeAction(
      input.page,
      input.action,
      {
        ...input.options,
        plan: singleActionPlan(input.action, input.policy),
        policy: input.policy,
        onPraxisResult: (result) => {
          praxisResults.push(result);
          return input.options.onPraxisResult?.(result);
        },
      },
      input.options.signal ?? new AbortController().signal,
      new SecretRedactor(),
      new Map(),
      new Map(),
      undefined,
      undefined,
      {
        runId: input.sessionId,
        stepId: input.operationId,
        channel: "action",
        ordinal: input.ordinal,
        allowedOrigins: input.policy.allowedOrigins,
        timeoutMs:
          "timeoutMs" in input.action && input.action.timeoutMs ? input.action.timeoutMs : 30_000,
      },
    );
    return operationOutcomeSchema.parse({
      operationId: input.operationId,
      functionalResult: "succeeded",
      mutationOutcome: praxisMutationOutcome(praxisResults),
      privacyResult: "unverified",
      evidenceResult: [],
      qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    const reasonCode = safeCode(error);
    const observedMutation = praxisMutationOutcome(praxisResults);
    return operationOutcomeSchema.parse({
      operationId: input.operationId,
      functionalResult: "failed",
      mutationOutcome:
        observedMutation === "not_applied" &&
        isMutatingAction(input.action) &&
        !isProvenPreDispatchFailure(reasonCode)
          ? "unknown"
          : observedMutation,
      privacyResult: privacyOutcomeFromError(reasonCode),
      evidenceResult: evidenceOutcomeFromError(reasonCode),
      qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
      durationMs: performance.now() - startedAt,
      reasonCode,
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
  if (mode === "observe") return actions.some((action) => action.type !== "navigate");
  return actions.some((action) => action.type === "protectedTransaction");
}

function isMutatingAction(action: CurrentAction): boolean {
  return ["click", "fill", "select", "check", "press", "protectedTransaction"].includes(
    action.type,
  );
}

function singleActionPlan(
  action: CurrentAction,
  policy: ExecutionRequest["policy"],
  semanticContext?: string,
) {
  return {
    name: "Kernel interactive operation",
    objective: semanticContext ?? "Execute one bounded semantic interaction",
    preconditions: [],
    allowedOrigins: policy.allowedOrigins,
    budgets: { maxActions: 1, maxDurationMs: policy.maxDurationMs ?? 30_000, maxNavigations: 1 },
    checkpoints: [],
    steps: [
      {
        id: "kernel-interaction",
        title: "Kernel interaction",
        action,
        assertions: [],
        onFailure: "stop" as const,
        evidence: [],
        captureIntent: "transient" as const,
        transientJustification: "Internal kernel operation contract.",
      },
    ],
  };
}

function outcomeFromReport(
  request: ExecutionRequest,
  report: ExecutionReport,
  praxisResults: import("@scry/contracts").PraxisResult[],
  protectedMutationOutcomes: Array<"not_applied" | "applied" | "unknown">,
  startedAt: number,
): OperationOutcome {
  const observedMutation = combinedMutationOutcome(praxisResults, protectedMutationOutcomes);
  const mutationOutcome =
    report.state !== "passed" &&
    observedMutation === "not_applied" &&
    praxisResults.length === 0 &&
    request.plan.steps.some((step) => isMutatingAction(step.action))
      ? "unknown"
      : observedMutation;
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
    durationMs: performance.now() - startedAt,
    ...(report.error ? { reasonCode: safeCode(report.error) } : {}),
  });
}

function combinedMutationOutcome(
  praxisResults: import("@scry/contracts").PraxisResult[],
  protectedOutcomes: Array<"not_applied" | "applied" | "unknown">,
): "not_applied" | "applied" | "unknown" {
  const outcomes = [praxisMutationOutcome(praxisResults), ...protectedOutcomes];
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.includes("applied")) return "applied";
  return "not_applied";
}

function protectedMutationOutcome(
  event: import("@scry/contracts").RunEvent,
): "not_applied" | "applied" | "unknown" | undefined {
  if (event.type !== "privacy.operation_completed") return undefined;
  const result = event.payload.result;
  if (!result || typeof result !== "object") return undefined;
  const mutation = (result as Record<string, unknown>).mutation;
  if (!mutation || typeof mutation !== "object") return undefined;
  const outcome = (mutation as Record<string, unknown>).outcome;
  if (outcome === "unknown") return "unknown";
  if (outcome === "confirmed_succeeded") return "applied";
  if (outcome === "not_attempted") return "not_applied";
  return undefined;
}

function failureOutcome(
  request: ExecutionRequest,
  praxisResults: import("@scry/contracts").PraxisResult[],
  startedAt: number,
  error: unknown,
  mutating: boolean,
): OperationOutcome {
  const observedMutation = praxisMutationOutcome(praxisResults);
  const reasonCode = safeCode(error);
  const mutationOutcome =
    observedMutation === "not_applied" && mutating && !isProvenPreDispatchFailure(reasonCode)
      ? "unknown"
      : observedMutation;
  return operationOutcomeSchema.parse({
    operationId: request.operationId,
    functionalResult: "inconclusive",
    mutationOutcome,
    privacyResult: privacyOutcomeFromError(reasonCode),
    evidenceResult: evidenceOutcomeFromError(reasonCode),
    qualityFindings: praxisResults.flatMap((result) => result.qualityFindings),
    durationMs: performance.now() - startedAt,
    reasonCode,
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

function isProvenPreDispatchFailure(reasonCode: string) {
  return [
    "PRAXIS_TARGET_CHANGED_BEFORE_ACTION",
    "PRAXIS_TARGET_NOT_FOUND",
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
  const required = new Set<ExecutionCapabilityName>(["browser", "praxis", "veil", "journal"]);
  if (
    request.plan.steps.some((step) => step.evidence.length > 0 || step.action.type === "screenshot")
  ) {
    required.add("evidence");
  }
  if (
    request.plan.steps.some(
      (step) =>
        step.action.type === "protectedTransaction" ||
        (step.action.type === "fill" &&
          Boolean(step.action.secretRef || step.action.capturedSecretRef)),
    )
  ) {
    required.add("protected_operations");
    if (request.plan.steps.some((step) => step.action.type === "protectedTransaction")) {
      required.add("checkpoint");
    }
  }
  if (request.plan.checkpoints.length) required.add("checkpoint");
  if (request.mode === "certify") required.add("calibration");
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
  const value = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "EXECUTION_KERNEL_FAILED";
}
