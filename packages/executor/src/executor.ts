import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  attemptResultSchema,
  runEventSchema,
  validatePlanAgainstPolicy,
  type CurrentAction,
  type Artifact,
  type Assertion,
  type Readiness,
  type ReadinessCondition,
  type RunEvent,
  type RecordingTimelineEntry,
} from "@scry/contracts";
import {
  classifyAction,
  RuntimePolicyError,
  RuntimeRequestPolicy,
  SecretRedactor,
} from "@scry/policy";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from "playwright";

import { availableArtifact, ensureOutputDirectories, writeJson } from "./artifacts.js";
import { playwrightBrowserChannel, visualRedactionInitScript } from "./browser-runtime-artifacts.js";
import { armExpectedEffect, checkGroundedTarget, clickGroundedTarget, fillGroundedTarget, registerGroundingHistoryProvider, registerGroundingObserver, resolveTargetLocator, selectGroundedTarget, verifyExpectedEffect } from "./grounding.js";
import { RecordingCoordinator } from "./recording-coordinator.js";
import { PrivacyGate, type PrivacyCollector } from "./privacy-gate.js";
import { capturePublicGeneratedValue } from "./public-value-capture.js";
import { BrowserSessionProvenance } from "./browser-session.js";
import { PlaywrightProtectedCapsuleFactory, ProtectedTransactionCoordinator, type ProtectedTransactionExecution } from "./protected-transaction-coordinator.js";
import { TraceCoordinator } from "./trace-coordinator.js";
import { sanitizeTraceArchive } from "./trace-sanitizer.js";
import { CalibrationRequiredError, capturePageStructure, protectedTransactionDigest, structureFingerprint } from "./calibration.js";
import { CheckpointCoordinator } from "./checkpoint-coordinator.js";
import type {
  AssertionExecutionResult,
  DiagnosticRecord,
  ExecuteOptions,
  ExecutionReport,
  PolicyViolationRecord,
  StepExecutionResult,
} from "./types.js";

export async function executePlan(options: ExecuteOptions): Promise<ExecutionReport> {
  const violations = validatePlanAgainstPolicy(options.plan, options.policy);
  if (violations.length > 0) {
    throw new Error(`Plan rejected by policy: ${violations.map((item) => item.message).join("; ")}`);
  }

  const runId = options.runId ?? randomUUID();
  const attemptId = options.attemptId ?? randomUUID();
  const startedAt = new Date();
  const eventPath = path.join(options.outputDirectory, "events.jsonl");
  const steps = initializeSteps(options);
  const diagnostics: DiagnosticRecord[] = [];
  const networkRecords: Array<Record<string, unknown>> = [];
  const pendingNetworkBodies = new Set<Promise<void>>();
  const networkActivity = { active: new Map<string, { url: string; resourceType: string }>() };
  const policyViolations: PolicyViolationRecord[] = [];
  const redactor = new SecretRedactor();
  const capturedSecrets = new Map<string, string>();
  const capturedValues = new Map<string, string>();
  const usesProtectedValues = options.plan.steps.some((step) =>
    step.action.type === "protectedTransaction"
    || (step.action.type === "fill" && Boolean(step.action.secretRef || step.action.capturedSecretRef))
  );
  const requestPolicy = new RuntimeRequestPolicy(options.plan, options.policy);
  const runArtifacts: Artifact[] = [];
  let sequence = 0;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let safeProvenance: BrowserSessionProvenance | undefined;
  let terminalState: ExecutionReport["state"] = "infrastructure_error";
  let timedOut = false;
  let cancelled = false;
  let activeStepId: string | undefined;
  let fatalError: string | undefined;
  let eventWriteChain = Promise.resolve();
  let privacySealed = false;
  let recording: RecordingCoordinator | undefined;
  let trace: TraceCoordinator | undefined;
  let privacyGate: PrivacyGate | undefined;
  let checkpointCoordinator: CheckpointCoordinator | undefined;
  const establishedCheckpoints = new Set<string>();
  const retiredArtifacts: Artifact[] = [];
  const retiredTimeline: RecordingTimelineEntry[] = [];
  const lifecycleTimeline: RecordingTimelineEntry[] = [];
  let captureEpoch = 0;
  let activeCaptureEpoch: Extract<RecordingTimelineEntry, { type: "capture_epoch" }> | undefined;
  let calibrationBoundaryReached = false;

  const startCaptureEpoch = (startReason: "run_started" | "checkpoint_restored", contextId = safeProvenance?.contextId ?? randomUUID()) => {
    captureEpoch += 1;
    activeCaptureEpoch = {
      type: "capture_epoch",
      id: randomUUID(),
      sequence: 0,
      epoch: captureEpoch,
      contextId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      startReason,
      endReason: "run_completed",
      status: "completed",
    };
    lifecycleTimeline.push(activeCaptureEpoch);
  };
  const endCaptureEpoch = (endReason: Extract<RecordingTimelineEntry, { type: "capture_epoch" }>["endReason"], status: "completed" | "sealed" = "completed") => {
    if (!activeCaptureEpoch) return;
    activeCaptureEpoch.endedAt = new Date().toISOString();
    activeCaptureEpoch.endReason = endReason;
    activeCaptureEpoch.status = status;
    activeCaptureEpoch = undefined;
  };
  const checkpointBoundary = (checkpointId: string, boundary: Extract<RecordingTimelineEntry, { type: "checkpoint_boundary" }>["boundary"], details: { reasonCode?: string; continuedAtStepId?: string } = {}) => {
    lifecycleTimeline.push({
      type: "checkpoint_boundary",
      id: randomUUID(),
      sequence: 0,
      checkpointId,
      boundary,
      occurredAt: new Date().toISOString(),
      captureEpoch: Math.max(captureEpoch, 1),
      ...details,
    });
  };

  await ensureOutputDirectories(options.outputDirectory);
  await writeFile(eventPath, "", "utf8");

  const emit = async (type: RunEvent["type"], payload: Record<string, unknown>) => {
    if (privacyGate?.isSuppressed() && !type.startsWith("privacy.") && !type.startsWith("recording.")) return;
    const event = runEventSchema.parse({
      sequence: ++sequence,
      runId,
      attemptId,
      type,
      occurredAt: new Date().toISOString(),
      payload: redactor.redactValue(payload),
    });
    eventWriteChain = eventWriteChain.then(async () => {
      await appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
      await options.onEvent?.(event);
    });
    await eventWriteChain;
  };
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(new Error("Run duration budget exceeded"));
    void stopBrowser(context, browser);
  }, options.plan.budgets.maxDurationMs);
  const cancel = () => {
    cancelled = true;
    timeoutController.abort(options.signal?.reason ?? new Error("Run cancelled"));
    void stopBrowser(context, browser);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    await emit("attempt.started", {
      planName: options.plan.name,
    });
    const browserChannel=playwrightBrowserChannel(options.browserChannel);
    browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(browserChannel ? { channel: browserChannel } : {}),
    });
    const viewport = options.viewport ?? { width: 1280, height: 720 };
    context = await browser.newContext({
      viewport,
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(options.browserStorageState ? { storageState: options.browserStorageState } : {}),
    });
    await installVisualRedactionStyles(context);
    page = await context.newPage();
    registerGroundingObserver(page, (diagnostic) => emit(diagnostic.outcome === "resolved" ? "grounding.resolved" : "grounding.rejected", { stepId: activeStepId ?? "preflight", ...diagnostic }));
    if (options.groundingHistory) registerGroundingHistoryProvider(page, options.groundingHistory);
    safeProvenance = new BrowserSessionProvenance(randomUUID(), "safe");
    let policyEpoch = 0;
    const rejectPolicy = async (
      error: RuntimePolicyError,
      context: { fatal?: boolean; resourceType?: string } = {},
    ) => {
      const fatal = context.fatal ?? true;
      if (fatal) policyEpoch += 1;
      const violation: PolicyViolationRecord = redactor.redactValue({
        code: error.code,
        message: error.message,
        occurredAt: new Date().toISOString(),
        ...(error.target ? { target: error.target } : {}),
        ...(context.resourceType ? { resourceType: context.resourceType } : {}),
        disposition: fatal ? "fatal" : "blocked_subresource",
      });
      policyViolations.push(violation);
      await emit("policy.rejected", violation);
    };
    await attachRequestInterception(context, page, requestPolicy, rejectPolicy);
    attachDiagnostics(page, diagnostics, emit, redactor, () => privacyGate?.getDecision("console") === "suppress" || privacyGate?.getDecision("console") === "quarantine");
    attachNetworkCapture(page, networkRecords, redactor, networkActivity, pendingNetworkBodies, () => privacyGate?.getDecision("network") === "suppress" || privacyGate?.getDecision("network") === "quarantine");
    attachCapabilityGuards(context, page, options, rejectPolicy);
    recording = new RecordingCoordinator({
      outputDirectory: options.outputDirectory,
      emit: (type, payload) => emit(type, payload),
    });
    trace = new TraceCoordinator({ context, outputDirectory: options.outputDirectory, sanitize: (target) => sanitizeTraceArchive(target, redactor) });
    const recordingCollector: PrivacyCollector = {
      name: "recording",
      arm: async (operationId, preparation) => {
        if (preparation?.mode === "protected_recording_gap" || !preparation?.videoMaskEstablished) {
          await recording!.createProtectedGap({ operationId, reason: "Privacy Gate protected interval" });
        }
      },
      resume: async () => {
        if (!recording!.hasActiveSegment()) await recording!.startSegment({ reason: "safe_resume" });
      },
      seal: async ({ code }) => recording!.seal(code),
      finalize: async () => recording!.finalize(),
    };
    const passiveCollectors = ["screenshot", "dom", "accessibility", "diagnostics", "network", "event-report"].map<PrivacyCollector>((name) => ({
      name, arm: async () => undefined, resume: async () => undefined, seal: async () => undefined, finalize: async () => undefined,
    }));
    privacyGate = new PrivacyGate([recordingCollector, trace, ...passiveCollectors], (privacyEvent) =>
      emit("privacy.state_changed", privacyEvent));
    page.once("close", () => { void recording?.seal("ACTIVE_PAGE_CLOSED"); });
    browser.once("disconnected", () => { void recording?.seal("BROWSER_DISCONNECTED"); });
    startCaptureEpoch("run_started");
    await recording.startSegment({ page, reason: "run_started" });
    await trace.start("run_started");
    await options.recordingTestHook?.({ page, recording });
    await options.privacyTestHook?.({ page, privacy: privacyGate });

    if (options.checkpointStore && options.flowRevisionId && options.environmentId) {
      checkpointCoordinator = new CheckpointCoordinator({ runId, flowRevisionId: options.flowRevisionId, environmentId: options.environmentId, allowedOrigins: options.plan.allowedOrigins, store: options.checkpointStore });
    }

    for (let index = 0; index < options.plan.steps.length; index += 1) {
      const step = options.plan.steps[index]!;
      const readinessStep = options.plan.steps[index]!;
      throwIfAborted(timeoutController.signal);
      const result = steps[index]!;
      let unsafeProtectedFailure = false;
      let continueUnrecordedProtectedFailure = false;
      activeStepId = step.id;
      const stepStarted = new Date();
      result.startedAt = stepStarted.toISOString();
      await emit("step.started", {
        stepId: step.id,
        title: step.title,
        capability: classifyAction(step.action),
      });

      try {
        if (!page) throw new InfrastructureDependencyError("Active safe page is unavailable");
        const checkpoint = options.plan.checkpoints.find((candidate) => candidate.beforeStepId === step.id);
        if (checkpoint && !establishedCheckpoints.has(checkpoint.id)) {
          if (!checkpointCoordinator || !context) throw new InfrastructureDependencyError("Checkpoint persistence is unavailable");
          await checkpointCoordinator.establish(context, checkpoint);
          establishedCheckpoints.add(checkpoint.id);
          checkpointBoundary(checkpoint.id, "established");
          await emit("checkpoint.established", { checkpointId: checkpoint.id, beforeStepId: checkpoint.beforeStepId });
        }
        const policyEpochBeforeStep = policyEpoch;
        let protectedTerminal = false;
        let protectedContinuationStepId: string | undefined;
        if (step.action.type === "protectedTransaction") {
          if (!browser || !context || !page || !safeProvenance || !privacyGate || !options.protectedTransactionStore || !options.atomicSecretCapture || !options.publicValueCapture) {
            throw new InfrastructureDependencyError("Protected transaction dependencies are unavailable");
          }
          const transaction: ProtectedTransactionExecution = await new ProtectedTransactionCoordinator({
            safeSession: { browser, context, page, provenance: safeProvenance },
            gate: privacyGate,
            redactor,
            store: options.protectedTransactionStore,
            capsuleFactory: new PlaywrightProtectedCapsuleFactory(),
            allowedOrigins: options.plan.allowedOrigins,
            persistSecret: options.atomicSecretCapture,
            persistPublicValue: options.publicValueCapture,
            resolveKnownSecret: options.secretResolver ?? missingSecretResolver,
            prepareCapsule: async (capsule) => {
              registerGroundingObserver(capsule.page, (diagnostic) => emit(diagnostic.outcome === "resolved" ? "grounding.resolved" : "grounding.rejected", { stepId: step.id, protected: true, ...diagnostic }));
              if (options.groundingHistory) registerGroundingHistoryProvider(capsule.page, options.groundingHistory);
              await attachRequestInterception(capsule.context, capsule.page, requestPolicy, rejectPolicy);
              attachCapabilityGuards(capsule.context, capsule.page, options, rejectPolicy);
            },
            verifyCalibration: async (capsule, action) => {
              if (!action.calibrationAttestationId) return;
              if (!options.calibrationVerifier) throw new InfrastructureDependencyError("Calibration verifier is unavailable");
              const fingerprint = structureFingerprint(await capturePageStructure(capsule.page, action));
              const operationDigest = protectedTransactionDigest(action, options.plan.allowedOrigins);
              if (!(await options.calibrationVerifier({ attestationId: action.calibrationAttestationId, operationId: action.operationId, operationDigest, structureFingerprint: fingerprint }))) throw new CalibrationRequiredError();
            },
            onPreparationVerified: async (capsule, action) => {
              if (options.calibrationRehearsal?.operationId !== action.operationId) return;
              const structure = await capturePageStructure(capsule.page, action);
              await options.calibrationRehearsal.onBoundary({ stepId: step.id, structure, url: capsule.page.url() });
              await emit("calibration.boundary_reached", { stepId: step.id, operationId: action.operationId });
              calibrationBoundaryReached = true;
            },
            verifyAssertions: async (targetPage, assertions) => {
              for (const assertion of assertions) await executeAssertion(targetPage, assertion, options.plan.allowedOrigins[0]!);
            },
            reconcile: async () => "unknown",
            ...(options.recordContextProvenance ? { onContextProvenance: options.recordContextProvenance } : {}),
            ...(options.recoverAcquisition ? { recoverAcquisition: options.recoverAcquisition } : {}),
            onEvidenceResumed: async ({ contextId }) => {
              endCaptureEpoch("sealed", "sealed");
              startCaptureEpoch("checkpoint_restored", contextId);
            },
            emit,
            signal: timeoutController.signal,
          }).execute(step.action);
          browser = transaction.safeSession.browser;
          context = transaction.safeSession.context;
          page = transaction.safeSession.page;
          safeProvenance = transaction.safeSession.provenance;
          protectedTerminal = transaction.terminal;
          protectedContinuationStepId = transaction.result.continuedAtStepId;
          for (const [reference, credentialId] of Object.entries(transaction.result.credentialReferences)) capturedSecrets.set(reference, credentialId);
          for (const [reference, valueId] of Object.entries(transaction.result.publicValueReferences)) capturedValues.set(reference, valueId);
          await emit("privacy.operation_completed", { operationId: step.action.operationId, result: transaction.result });
          if (transaction.result.status === "aborted" || transaction.result.status === "outcome_unknown") throw new UnsafeProtectedCaptureError(transaction.result.status);
        } else {
          await executeAction(
            page,
            step.action,
            options,
            timeoutController.signal,
            redactor,
            capturedSecrets,
            capturedValues,
            privacyGate,
            emit,
          );
        }
        result.action = { status: "passed" };
        const actionCompletedAt = new Date();
        if (policyEpoch !== policyEpochBeforeStep) {
          throw new Error("Action was blocked by execution policy");
        }
        {
          const readinessStartedAt = new Date();
          if (readinessStep?.after) {
            await emit("step.readiness_started", { stepId: step.id });
            try {
              const matchedConditions = await executeReadiness(
                page,
                {
                  ...readinessStep.after,
                  timeoutMs: Math.min(
                    60_000,
                    Math.round(readinessStep.after.timeoutMs * (options.readinessTimeoutMultiplier ?? 1)),
                  ),
                },
                options.plan.allowedOrigins[0]!,
                networkRecords,
                networkActivity.active,
                stepStarted.getTime(),
              );
              const readinessCompletedAt = new Date();
              result.readiness = {
                status: "passed",
                startedAt: readinessStartedAt.toISOString(),
                completedAt: readinessCompletedAt.toISOString(),
                durationMs: readinessCompletedAt.getTime() - readinessStartedAt.getTime(),
                matchedConditions,
              };
            } catch (error) {
              const readinessCompletedAt = new Date();
              result.readiness = {
                status: "failed",
                startedAt: readinessStartedAt.toISOString(),
                completedAt: readinessCompletedAt.toISOString(),
                durationMs: readinessCompletedAt.getTime() - readinessStartedAt.getTime(),
                matchedConditions: [],
                error: errorMessage(error),
              };
              throw new ReadinessTimeoutError(step.id, errorMessage(error));
            }
          } else {
            result.readiness = {
              status: "not_configured",
              startedAt: readinessStartedAt.toISOString(),
              completedAt: readinessStartedAt.toISOString(),
              durationMs: 0,
              matchedConditions: [],
            };
          }
          if (
            readinessStep?.captureIntent === "final"
            && (step.action.type === "screenshot" || step.evidence.includes("screenshot") || step.evidence.includes("dom"))
          ) {
            result.stabilization = await stabilizeApplication(page, networkActivity.active, 3_000, 500);
          }
        }
        const observation = {
              millisecondsSinceAction: Date.now() - actionCompletedAt.getTime(),
              captureIntent: readinessStep?.captureIntent ?? "final",
              readiness: result.readiness,
              stabilization: result.stabilization,
              ...(usesProtectedValues ? { visualRedaction: "protected-elements-masked" } : {}),
            };
        if (step.action.type === "screenshot" || step.evidence.length > 0) {
          await emit("step.evidence_started", { stepId: step.id, evidence: step.evidence });
        }
        if (step.action.type === "screenshot") {
          const screenshotPath = path.join(options.outputDirectory, "screenshots", `${step.action.name}.png`);
          const fallback = await captureScreenshotWithFallback(page, screenshotPath, step.action.fullPage);
          const artifact = await availableArtifact(
            "screenshot",
            "image/png",
            screenshotPath,
            `screenshots/${step.action.name}.png`,
          );
          artifact.observation = {
            ...observation,
            screenshotMode: fallback ? "viewport-fallback" : step.action.fullPage ? "full-page" : "viewport",
          };
          result.artifacts.push(artifact);
          await emit("artifact.created", {
            stepId: step.id,
            artifact,
            path: `screenshots/${step.action.name}.png`,
          });
        }
        const assertions = executableAssertions(step.id, step.action, step.assertions);
        if (assertions.length > 0) await emit("step.assertions_started", { stepId: step.id });
        for (const [assertionIndex, assertion] of assertions.entries()) {
          const assertionResult = result.assertions[assertionIndex]!;
          try {
            await executeAssertion(page, assertion, options.plan.allowedOrigins[0]!);
            assertionResult.status = "passed";
          } catch (error) {
            assertionResult.status = "failed";
            assertionResult.error = errorMessage(error);
            throw error;
          }
        }
        await captureRequestedEvidence(
          page,
          options.outputDirectory,
          step.id,
          step.evidence,
          result,
          networkRecords,
          redactor,
          pendingNetworkBodies,
          observation,
          privacyGate,
        );
        result.status = "passed";
        await emit("step.passed", {
          stepId: step.id,
          assertions: result.assertions,
        });
        if (protectedTerminal) break;
        if (protectedContinuationStepId) index = options.plan.steps.findIndex((candidate) => candidate.id === protectedContinuationStepId) - 1;
      } catch (error) {
        if (timeoutController.signal.aborted) throw error;
        if (isBrowserInfrastructureFailure(error)) {
          throw new InfrastructureDependencyError(`Browser execution failed: ${errorMessage(error)}`);
        }
        if (error instanceof InfrastructureDependencyError) throw error;
        result.action = { status: "failed", error: redactor.redact(errorMessage(error)) };
        result.status = "failed";
        result.error = redactor.redact(errorMessage(error));
        unsafeProtectedFailure = error instanceof UnsafeProtectedCaptureError;
        continueUnrecordedProtectedFailure = error instanceof ContinueUnrecordedProtectedError;
        markRemainingAssertionsUnevaluated(result);
        await captureFailureScreenshot(page, options.outputDirectory, step.id, result, privacyGate);
        await emit("step.failed", {
          stepId: step.id,
          error: result.error,
          assertions: result.assertions,
        });
        if (!continueUnrecordedProtectedFailure && (unsafeProtectedFailure || step.onFailure === "stop")) break;
      } finally {
        const completed = new Date();
        result.completedAt = completed.toISOString();
        result.durationMs = completed.getTime() - stepStarted.getTime();
      }
    }
    terminalState = steps.some((step) => step.status === "failed") ? "failed" : "passed";
    if (options.calibrationRehearsal && !calibrationBoundaryReached) {
      throw new Error("CALIBRATION_BOUNDARY_NOT_REACHED");
    }
  } catch (error) {
    fatalError = redactor.redact(
      timedOut || cancelled
        ? errorMessage(timeoutController.signal.reason ?? error)
        : errorMessage(error),
    );
    if (activeStepId) {
      const active = steps.find((step) => step.id === activeStepId);
      if (active?.status === "unevaluated") {
        active.error = fatalError;
      }
    }
    terminalState = timedOut ? "timed_out" : cancelled ? "cancelled" : "infrastructure_error";
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    await emit("attempt.finalizing", { state: terminalState });
    if (privacyGate && (privacySealed || cancelled || timedOut)) {
      await privacyGate.seal({ code: privacySealed ? "UNRESOLVED_PROTECTED_CAPTURE" : cancelled ? "RUN_CANCELLED" : "RUN_TIMED_OUT" }).catch(() => undefined);
    }
    await privacyGate?.finalize().catch(() => undefined);
    if (recording) {
      if (privacySealed || cancelled || timedOut) {
        await recording.seal(
          privacySealed
            ? "UNRESOLVED_PROTECTED_CAPTURE"
            : cancelled
                ? "RUN_CANCELLED"
                : "RUN_TIMED_OUT",
        ).catch(() => undefined);
      }
      await recording.finalize().catch(() => undefined);
      const videoArtifacts = recording.artifacts();
      runArtifacts.push(...videoArtifacts);
      for (const artifact of videoArtifacts) {
        await emit("artifact.created", { artifact, path: artifact.relativePath });
      }
    }
    if (trace) {
      const traceArtifacts = trace.artifacts();
      runArtifacts.push(...traceArtifacts);
      for (const artifact of traceArtifacts) await emit("artifact.created", { artifact, path: artifact.relativePath });
    }
    if (context && terminalState === "passed" && options.captureBrowserState) {
      await Promise.resolve(options.captureBrowserState(await context.storageState())).catch(() => undefined);
    }
    if (context) {
      await boundedClose(context.close()).catch(() => undefined);
    }
    if (browser) await boundedClose(browser.close()).catch(() => undefined);
  }

  endCaptureEpoch(privacySealed ? "sealed" : "run_completed", privacySealed ? "sealed" : "completed");
  const completedAt = new Date();
  const assertions = steps.flatMap((step) => step.assertions);
  const report: ExecutionReport = {
    planName: options.plan.name,
    runId,
    attemptId,
    state: terminalState,
    outcomeClassification: classifyOutcome(terminalState, steps, policyViolations),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    requiredAssertions: {
      passed: assertions.filter((item) => item.status === "passed").length,
      failed: assertions.filter((item) => item.status === "failed").length,
      unevaluated: assertions.filter((item) => item.status === "unevaluated").length,
    },
    artifacts: [...retiredArtifacts, ...runArtifacts, ...steps.flatMap((step) => step.artifacts)],
    ...(fatalError ? { error: fatalError } : {}),
    steps,
    diagnostics,
    policyViolations,
    artifactTimeline: mergeArtifactTimeline(retiredTimeline, lifecycleTimeline, recording?.timeline() ?? [], trace?.timeline() ?? []),
  };
  attemptResultSchema.parse({
    runId: report.runId,
    attemptId: report.attemptId,
    state: report.state,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    durationMs: report.durationMs,
    requiredAssertions: report.requiredAssertions,
    artifacts: report.artifacts,
  });
  await writeJson(path.join(options.outputDirectory, "attempt.json"), report);
  await emit("attempt.completed", {
    state: report.state,
    requiredAssertions: report.requiredAssertions,
  });
  return report;
}

function initializeSteps(options: ExecuteOptions): StepExecutionResult[] {
  return options.plan.steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: "unevaluated",
    action: { status: "unevaluated" },
    evidence: step.evidence.map((kind) => ({ kind, status: "degraded" as const })),
    assertions: executableAssertions(step.id, step.action, step.assertions).map((assertion, index) => ({
      index,
      type: assertion.type,
      status: "unevaluated",
    })),
    artifacts: [],
  }));
}

function executableAssertions(stepId: string, action: CurrentAction, assertions: Assertion[]) {
  if (action.type !== "navigate" || !/^(step-\d+-navigate|visit-\d+)$/.test(stepId)) {
    return assertions;
  }
  const requested = new URL(action.url, "https://scry.invalid");
  const requestedPath = requested.pathname + requested.search;
  return assertions.filter((assertion) =>
    !(
      assertion.type === "url"
      && assertion.match === "path"
      && assertion.expected === requestedPath
    )
  );
}

async function executeAction(
  page: Page,
  action: CurrentAction,
  options: ExecuteOptions,
  signal: AbortSignal,
  redactor: SecretRedactor,
  capturedSecrets: Map<string, string>,
  capturedValues: Map<string, string>,
  privacyGate?: PrivacyGate,
  emitEvent?: (type: RunEvent["type"], payload: Record<string, unknown>) => Promise<void>,
) {
  throwIfAborted(signal);
  switch (action.type) {
    case "protectedTransaction": {
      throw new InfrastructureDependencyError("Protected transactions must be delegated to ProtectedTransactionKernel");
    }
    case "capturePublicValue": {
      const captured = await capturePublicGeneratedValue(page, action.capture.acquisition, action.capture.timeoutMs);
      capturedValues.set(action.reference, captured.value);
      if (options.publicValueCapture) {
        await options.publicValueCapture({ operationId: action.operationId, reference: action.reference, name: action.storage.name, value: captured.value, scope: action.storage.scope });
      }
      return;
    }
    case "navigate":
      await page.goto(new URL(action.url, options.plan.allowedOrigins[0]).href, {
        waitUntil: "domcontentloaded",
        ...optionalTimeout(action.timeoutMs),
      });
      await waitForApplicationRender(page, action.timeoutMs);
      return;
    case "click":
      { const beforeUrl = page.url();
      const expectedEffect = armExpectedEffect(page, action.expectedEffect, action.timeoutMs);
      await clickGroundedTarget(page, action.target, optionalTimeout(action.timeoutMs));
      await verifyExpectedEffect(page, action.expectedEffect, beforeUrl, action.timeoutMs, expectedEffect);
      return;
      }
    case "fill": {
      let value = action.value
        ?? (action.capturedValueRef ? capturedValues.get(action.capturedValueRef) : undefined);
      if (value !== undefined && action.capturedValueRef && options.publicValueResolver) value = await options.publicValueResolver(value);
      if (value === undefined && action.generatedValueRef) value = await (options.publicValueResolver ?? missingPublicValueResolver)(action.generatedValueRef);
      if (value === undefined && action.capturedSecretRef) {
        const credentialReference = capturedSecrets.get(action.capturedSecretRef);
        if (!credentialReference) throw new Error(`Captured secret "${action.capturedSecretRef}" is unavailable`);
        try { value = await (options.secretResolver ?? missingSecretResolver)(credentialReference); }
        catch (error) { throw new InfrastructureDependencyError(`Captured credential resolution failed: ${errorMessage(error)}`); }
      }
      if (value === undefined && action.secretRef) {
        try {
          value = await (options.secretResolver ?? missingSecretResolver)(action.secretRef);
        } catch (error) {
          throw new InfrastructureDependencyError(
            `Protected credential resolution failed: ${errorMessage(error)}`,
          );
        }
      }
      if (value === undefined) throw new Error(`Captured secret "${action.capturedSecretRef}" is unavailable`);
      const protectedFill = Boolean(action.secretRef || action.capturedSecretRef);
      if (protectedFill) redactor.add(value);
      const locator = protectedFill ? await resolveTargetLocator(page, action.target) : undefined;
      if (locator) await maskSensitiveLocator(locator);
      if (protectedFill && privacyGate) {
        const operationId = `known-secret-fill-${randomUUID()}`;
        try {
          await privacyGate.prepare(operationId, { mode: "protected_recording_gap", videoMaskEstablished: false });
          await privacyGate.beginProtected();
          await locator!.fill(value, optionalTimeout(action.timeoutMs));
          const valuePresent = await locator!.evaluate((element) => "value" in (element as HTMLInputElement) ? (element as HTMLInputElement).value.length > 0 : (element.textContent ?? "").length > 0);
          if (!valuePresent) throw new Error("LOCAL_STATE_NOT_OBSERVED");
          await privacyGate.markCaptured();
          await privacyGate.beginSafeBoundary();
          await privacyGate.confirmSafeBoundary({ kind: "known_secret_registered", referenceType: action.secretRef ? "vault" : "captured" });
        } catch (error) {
          await privacyGate.seal({ code: "KNOWN_SECRET_FILL_FAILED" }).catch(() => undefined);
          throw error;
        }
      } else await fillGroundedTarget(page, action.target, value, optionalTimeout(action.timeoutMs));
      return;
    }
    case "select":
      await selectGroundedTarget(page, action.target, action.value, optionalTimeout(action.timeoutMs));
      return;
    case "check":
      await checkGroundedTarget(page, action.target, action.checked, optionalTimeout(action.timeoutMs));
      return;
    case "press":
      if (action.target) {
        await (await resolveTargetLocator(page, action.target)).press(action.key, optionalTimeout(action.timeoutMs));
      } else {
        await page.keyboard.press(action.key);
      }
      return;
    case "scroll":
      if (action.target) {
        await (await resolveTargetLocator(page, action.target)).evaluate(
          (element, deltaY) => element.scrollBy(0, deltaY),
          action.deltaY,
        );
      } else {
        await page.mouse.wheel(0, action.deltaY);
      }
      return;
    case "waitFor":
      await (await resolveTargetLocator(page, action.target)).waitFor({
        state: action.state,
        ...optionalTimeout(action.timeoutMs),
      });
      return;
    case "screenshot":
      return;
  }
}

async function waitForApplicationRender(page: Page, timeoutMs = 10_000) {
  const mountSelector = await page.evaluate(() => {
    for (const selector of ["#root", "#app", "#__next"]) {
      if (document.querySelector(selector)) return selector;
    }
    return undefined;
  });
  if (!mountSelector) return;

  try {
    await page.waitForFunction(
      (selector) => {
        const mount = document.querySelector(selector);
        if (!mount) return false;
        const text = (mount.textContent ?? "").replace(/\s+/g, " ").trim();
        const hasContent = mount.childElementCount > 0 || text.length > 0;
        const isLoadingPlaceholder =
          /^(loading|please wait|initializing|starting)([.…!]*|\s+.*)?$/i.test(text);
        return hasContent && !isLoadingPlaceholder;
      },
      mountSelector,
      { timeout: timeoutMs },
    );
  } catch {
    const visibleText = await page
      .locator(mountSelector)
      .innerText()
      .catch(() => "");
    if (/^(loading|please wait|initializing|starting)([.…!]*|\s+.*)?$/i.test(visibleText.trim())) {
      throw new Error(
        `Application remained in its loading state (${JSON.stringify(visibleText.trim())})`,
      );
    }
    throw new Error(
      `Application shell loaded, but ${mountSelector} remained empty and the application did not render`,
    );
  }
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
}

async function executeAssertion(page: Page, assertion: Assertion, baseOrigin: string) {
  switch (assertion.type) {
    case "visible":
      await (await resolveTargetLocator(page, assertion.target)).waitFor({
        state: "visible",
        ...optionalTimeout(assertion.timeoutMs),
      });
      return;
    case "enabled": {
      const locator = await resolveTargetLocator(page, assertion.target);
      await locator.waitFor({ state: "visible", ...optionalTimeout(assertion.timeoutMs) });
      if (!(await locator.isEnabled())) throw new Error("Expected target to be enabled");
      return;
    }
    case "hidden":
      await (await resolveTargetLocator(page, assertion.target)).waitFor({
        state: "hidden",
        ...optionalTimeout(assertion.timeoutMs),
      });
      return;
    case "text": {
      const locator = await resolveTargetLocator(page, assertion.target);
      await locator.waitFor({ state: "visible", ...optionalTimeout(assertion.timeoutMs) });
      const actual = (await locator.textContent()) ?? "";
      const matches = assertion.exact ? actual.trim() === assertion.expected : actual.includes(assertion.expected);
      if (!matches) throw new Error(`Expected text "${assertion.expected}", received "${actual.trim()}"`);
      return;
    }
    case "value": {
      const actual = await (await resolveTargetLocator(page, assertion.target)).inputValue({
        ...optionalTimeout(assertion.timeoutMs),
      });
      if (actual !== assertion.expected) {
        throw new Error(`Expected value "${assertion.expected}", received "${actual}"`);
      }
      return;
    }
    case "url": {
      await page.waitForLoadState("domcontentloaded", optionalTimeout(assertion.timeoutMs));
      const actual = new URL(page.url());
      const expected = new URL(assertion.expected, baseOrigin);
      const matches =
        assertion.match === "exact"
          ? actual.href === expected.href
          : assertion.match === "path"
            ? actual.pathname + actual.search === expected.pathname + expected.search
            : actual.href.includes(assertion.expected);
      if (!matches) throw new Error(`Expected URL ${assertion.match} "${assertion.expected}", received "${actual.href}"`);
    }
  }
}

async function captureRequestedEvidence(
  page: Page,
  root: string,
  stepId: string,
  evidence: Array<"screenshot" | "dom" | "network">,
  result: StepExecutionResult,
  networkRecords: Array<Record<string, unknown>>,
  redactor: SecretRedactor,
  pendingNetworkBodies: Set<Promise<void>>,
  observation?: Record<string, unknown>,
  privacyGate?: PrivacyGate,
) {
  if (evidence.includes("screenshot")) {
    if (privacyGate && privacyGate.getDecision("screenshot") !== "allow") {
      result.artifacts.push({ id: randomUUID(), kind: "screenshot", availability: "destroyed", privacyClassification: "uncertain", failureProvenance: "privacy", reasonCode: "PRIVACY_GATE_CLOSED", contentType: "image/png", observation: { bytesDestroyed: true, reasonCode: "PRIVACY_GATE_CLOSED" } });
      setEvidenceStatus(result, "screenshot", "degraded", "Evidence suppressed by Privacy Gate");
    } else {
    const file = path.join(root, "screenshots", `${stepId}.png`);
    try {
      const fallback = await captureScreenshotWithFallback(page, file, true);
      const artifact = await availableArtifact("screenshot", "image/png", file, `screenshots/${stepId}.png`);
      artifact.observation = { ...observation, screenshotMode: fallback ? "viewport-fallback" : "full-page" };
      result.artifacts.push(artifact);
      setEvidenceStatus(result, "screenshot", "available");
    } catch (error) {
      result.evidenceFailures ??= [];
      result.evidenceFailures.push({ kind: "screenshot", error: errorMessage(error) });
      result.artifacts.push({ id: randomUUID(), kind: "screenshot", availability: "failed", privacyClassification: "safe", failureProvenance: "executor", reasonCode: "SCREENSHOT_CAPTURE_FAILED", contentType: "image/png" });
      setEvidenceStatus(result, "screenshot", "failed", errorMessage(error));
    }
    }
  }
  if (evidence.includes("dom")) {
    if (privacyGate && ["suppress", "quarantine"].includes(privacyGate.getDecision("dom"))) {
      result.artifacts.push({ id: randomUUID(), kind: "dom", availability: "destroyed", privacyClassification: "uncertain", failureProvenance: "privacy", reasonCode: "PRIVACY_GATE_CLOSED", contentType: "text/html", observation: { bytesDestroyed: true, reasonCode: "PRIVACY_GATE_CLOSED" } });
      setEvidenceStatus(result, "dom", "degraded", "Evidence suppressed by Privacy Gate");
    } else {
    try {
      const file = path.join(root, "dom", `${stepId}.html`);
      await writeFile(file, redactor.redact(await page.content()), "utf8");
      const artifact = await availableArtifact("dom", "text/html", file, `dom/${stepId}.html`);
      if (observation) artifact.observation = observation;
      result.artifacts.push(artifact);
      setEvidenceStatus(result, "dom", "available");
    } catch (error) {
      result.evidenceFailures ??= [];
      result.evidenceFailures.push({ kind: "dom", error: errorMessage(error) });
      result.artifacts.push({ id: randomUUID(), kind: "dom", availability: "failed", privacyClassification: "safe", failureProvenance: "executor", reasonCode: "DOM_CAPTURE_FAILED", contentType: "text/html" });
      setEvidenceStatus(result, "dom", "failed", errorMessage(error));
    }
    }
  }
  if (evidence.includes("network")) {
    if (privacyGate && ["suppress", "quarantine"].includes(privacyGate.getDecision("network"))) {
      result.artifacts.push({ id: randomUUID(), kind: "network", availability: "destroyed", privacyClassification: "uncertain", failureProvenance: "privacy", reasonCode: "PRIVACY_GATE_CLOSED", contentType: "application/json", observation: { bytesDestroyed: true, reasonCode: "PRIVACY_GATE_CLOSED" } });
      setEvidenceStatus(result, "network", "degraded", "Evidence suppressed by Privacy Gate");
    } else {
    try {
      await Promise.allSettled([...pendingNetworkBodies]);
      const file = path.join(root, "network", `${stepId}.json`);
      await writeJson(file, redactor.redactValue({ requests: networkRecords }));
      const artifact = await availableArtifact("network", "application/json", file, `network/${stepId}.json`);
      if (observation) artifact.observation = observation;
      result.artifacts.push(artifact);
      setEvidenceStatus(result, "network", "available");
    } catch (error) {
      result.evidenceFailures ??= [];
      result.evidenceFailures.push({ kind: "network", error: errorMessage(error) });
      result.artifacts.push({ id: randomUUID(), kind: "network", availability: "failed", privacyClassification: "safe", failureProvenance: "executor", reasonCode: "NETWORK_CAPTURE_FAILED", contentType: "application/json" });
      setEvidenceStatus(result, "network", "failed", errorMessage(error));
    }
    }
  }
}

async function captureScreenshotWithFallback(page: Page, file: string, fullPage: boolean) {
  if (!fullPage) {
    await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
    return false;
  }
  const dimensions = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }));
  if (dimensions.width * dimensions.height <= 40_000_000) {
    try {
      await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
      return false;
    } catch {
      // Chromium can reject or stall on extremely complex pages despite modest dimensions.
    }
  }
  await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
  return true;
}

async function captureFailureScreenshot(
  page: Page,
  root: string,
  stepId: string,
  result: StepExecutionResult,
  privacyGate?: PrivacyGate,
) {
  if (privacyGate && privacyGate.getDecision("screenshot") !== "allow") return;
  try {
    const file = path.join(root, "screenshots", `${stepId}.failure.png`);
    await page.screenshot({ path: file, fullPage: true });
    result.artifacts.push(
      await availableArtifact(
        "screenshot",
        "image/png",
        file,
        `screenshots/${stepId}.failure.png`,
      ),
    );
  } catch {
    // Preserve the original test failure when screenshot capture also fails.
  }
}

function attachDiagnostics(
  page: Page,
  diagnostics: DiagnosticRecord[],
  emit: (type: RunEvent["type"], payload: Record<string, unknown>) => Promise<void>,
  redactor: SecretRedactor,
  isProtectedCaptureActive: () => boolean = () => false,
) {
  page.on("console", (message) => {
    if (isProtectedCaptureActive()) return;
    const diagnostic: DiagnosticRecord = {
      type: "console",
      occurredAt: new Date().toISOString(),
      message: isProtectedCaptureActive() ? PROTECTED_CAPTURE_REDACTION : redactor.redact(message.text()),
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.console", diagnostic);
  });
  page.on("pageerror", (error) => {
    if (isProtectedCaptureActive()) return;
    const diagnostic: DiagnosticRecord = {
      type: "page_error",
      occurredAt: new Date().toISOString(),
      message: isProtectedCaptureActive() ? PROTECTED_CAPTURE_REDACTION : redactor.redact(error.message),
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.page_error", diagnostic);
  });
  page.on("requestfailed", (request) => {
    if (isProtectedCaptureActive()) return;
    const diagnostic: DiagnosticRecord = {
      type: "request_failed",
      occurredAt: new Date().toISOString(),
      message: isProtectedCaptureActive() ? PROTECTED_CAPTURE_REDACTION : redactor.redact(request.failure()?.errorText ?? "Request failed"),
      url: isProtectedCaptureActive() ? PROTECTED_CAPTURE_REDACTION : redactor.redact(request.url()),
      method: request.method(),
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.request_failed", diagnostic);
  });
}

function attachNetworkCapture(
  page: Page,
  records: Array<Record<string, unknown>>,
  redactor: SecretRedactor,
  activity?: { active: Map<string, { url: string; resourceType: string }> },
  pendingBodies = new Set<Promise<void>>(),
  isProtectedCaptureActive: () => boolean = () => false,
) {
  page.on("request", (request) => {
    activity?.active.set(request.url(), { url: request.url(), resourceType: request.resourceType() });
    const protectedCaptureActive = isProtectedCaptureActive();
    if (protectedCaptureActive) return;
    records.push({
      type: "request",
      occurredAt: new Date().toISOString(),
      method: request.method(),
      url: protectedCaptureActive ? PROTECTED_CAPTURE_REDACTION : redactor.redact(request.url()),
      resourceType: request.resourceType(),
    });
  });
  page.on("response", (response) => {
    const protectedCaptureActive = isProtectedCaptureActive();
    if (protectedCaptureActive) return;
    const record: Record<string, unknown> = {
      type: "response",
      occurredAt: new Date().toISOString(),
      method: response.request().method(),
      url: protectedCaptureActive ? PROTECTED_CAPTURE_REDACTION : redactor.redact(response.url()),
      status: response.status(),
    };
    records.push(record);
    if (protectedCaptureActive) {
      record.responseBodyOmitted = "protected_capture_interval";
      return;
    }
    if (response.status() < 400) return;
    const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
    if (!contentType.includes("json") && !contentType.startsWith("text/")) return;
    const declaredLength = Number(response.headers()["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_NETWORK_ERROR_BODY_BYTES) {
      record.responseBodyOmitted = "declared_body_too_large";
      return;
    }
    let capture: Promise<void>;
    capture = response.body().then((body) => {
      const truncated = body.byteLength > MAX_NETWORK_ERROR_BODY_BYTES;
      const text = body.subarray(0, MAX_NETWORK_ERROR_BODY_BYTES).toString("utf8");
      try {
        record.responseBody = redactor.redactValue(JSON.parse(text));
      } catch {
        record.responseBody = redactor.redact(text);
      }
      if (truncated) record.responseBodyTruncated = true;
    }).catch(() => {
      record.responseBodyOmitted = "unavailable";
    }).finally(() => pendingBodies.delete(capture));
    pendingBodies.add(capture);
  });
  const complete = (request: { url(): string }) => activity?.active.delete(request.url());
  page.on("requestfinished", complete);
  page.on("requestfailed", complete);
}

const MAX_NETWORK_ERROR_BODY_BYTES = 64 * 1024;
const PROTECTED_CAPTURE_REDACTION = "[REDACTED DURING PROTECTED CAPTURE]";

async function installVisualRedactionStyles(context: BrowserContext) {
  await context.addInitScript({ content: visualRedactionInitScript });
}

async function maskSensitiveLocator(locator: Locator) {
  await locator.evaluate((element) => {
    element.setAttribute("data-scry-redacted", "true");
    const htmlElement = element as HTMLElement;
    htmlElement.style.setProperty("color", "transparent", "important");
    htmlElement.style.setProperty("-webkit-text-fill-color", "transparent", "important");
    htmlElement.style.setProperty("background", "#000", "important");
    htmlElement.style.setProperty("border-color", "#000", "important");
    htmlElement.style.setProperty("caret-color", "transparent", "important");
    htmlElement.style.setProperty("text-shadow", "none", "important");
  });
}

function setEvidenceStatus(
  result: StepExecutionResult,
  kind: "screenshot" | "dom" | "network",
  status: "available" | "degraded" | "failed",
  error?: string,
) {
  const entry = result.evidence.find((item) => item.kind === kind);
  if (entry) Object.assign(entry, { status }, error ? { error } : {});
}

class ReadinessTimeoutError extends Error {
  constructor(readonly stepId: string, message: string) {
    super(`Readiness timed out for step "${stepId}": ${message}`);
    this.name = "ReadinessTimeoutError";
  }
}

class UnsafeProtectedCaptureError extends Error {
  constructor(message: string) {
    super(`Protected capture could not resolve safely; recording remained sealed. ${message}`);
    this.name = "UnsafeProtectedCaptureError";
  }
}

class ContinueUnrecordedProtectedError extends Error {
  override name = "ContinueUnrecordedProtectedError";
}

async function executeReadiness(
  page: Page,
  readiness: Readiness,
  baseOrigin: string,
  networkRecords: Array<Record<string, unknown>>,
  activeRequests: Map<string, { url: string; resourceType: string }>,
  observationStartedAt: number,
) {
  const startedAt = Date.now();
  const execute = (condition: ReadinessCondition) => executeReadinessCondition(
    page, condition, baseOrigin, readiness.timeoutMs, startedAt, observationStartedAt, networkRecords, activeRequests,
  );
  if (readiness.mode === "all") {
    await Promise.all(readiness.conditions.map(execute));
    return readiness.conditions.map((condition) => condition.type);
  }
  const winner = await Promise.any(readiness.conditions.map(async (condition) => {
    await execute(condition);
    return condition.type;
  }));
  return [winner];
}

async function executeReadinessCondition(
  page: Page,
  condition: ReadinessCondition,
  baseOrigin: string,
  timeoutMs: number,
  startedAt: number,
  observationStartedAt: number,
  networkRecords: Array<Record<string, unknown>>,
  activeRequests: Map<string, { url: string; resourceType: string }>,
) {
  const remaining = () => Math.max(100, timeoutMs - (Date.now() - startedAt));
  switch (condition.type) {
    case "visible":
      await expectEventually(async () => (await resolveTargetLocator(page, condition.target)).isVisible(), remaining());
      return;
    case "hidden":
      await (await resolveTargetLocator(page, condition.target)).waitFor({ state: "hidden", timeout: remaining() });
      return;
    case "text":
      await expectEventually(async () => {
        const locator = await resolveTargetLocator(page, condition.target);
        if (await locator.count() === 0 || !(await locator.first().isVisible())) return false;
        const actual = ((await locator.first().textContent()) ?? "").trim();
        return condition.exact ? actual === condition.expected : actual.includes(condition.expected);
      }, remaining());
      return;
    case "value":
      await expectEventually(async () => (await (await resolveTargetLocator(page, condition.target)).inputValue()) === condition.expected, remaining());
      return;
    case "checked":
      await expectEventually(async () => (await (await resolveTargetLocator(page, condition.target)).isChecked()) === condition.expected, remaining());
      return;
    case "url":
      await expectEventually(async () => {
        const actual = new URL(page.url());
        const expected = new URL(condition.expected, baseOrigin);
        return condition.match === "exact"
          ? actual.href === expected.href
          : condition.match === "path"
            ? actual.pathname + actual.search === expected.pathname + expected.search
            : actual.href.includes(condition.expected);
      }, remaining());
      return;
    case "content":
      await expectEventually(async () => {
        const locator = await resolveTargetLocator(page, condition.target);
        if (await locator.count() === 0) return false;
        const snapshot = await locator.first().evaluate((element) => ({
          children: element.childElementCount,
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
        return (condition.minimumChildren === undefined || snapshot.children >= condition.minimumChildren)
          && (condition.minimumTextLength === undefined || snapshot.text.length >= condition.minimumTextLength)
          && (condition.requiredText === undefined || snapshot.text.includes(condition.requiredText));
      }, remaining());
      return;
    case "request":
      await expectEventually(async () => networkRecords.some((record) =>
        record.type === "response"
        && String(record.url).includes(condition.urlPattern)
        && (!condition.method || record.method === condition.method)
        && Number(record.status) >= condition.status.min
        && Number(record.status) <= condition.status.max
        && new Date(String(record.occurredAt)).getTime() >= observationStartedAt
      ), remaining());
      return;
    case "domStable":
      await waitForDomQuiet(page, condition.quietWindowMs, remaining());
      return;
    case "networkQuiet":
      await waitForNetworkQuiet(activeRequests, condition.quietWindowMs, remaining(), condition.ignoreUrlPatterns);
      return;
    case "delay":
      if (condition.durationMs > remaining()) {
        await new Promise((resolve) => setTimeout(resolve, remaining()));
        throw new Error("Fixed delay exceeded the readiness group timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, condition.durationMs));
  }
}

async function stabilizeApplication(
  page: Page,
  activeRequests: Map<string, { url: string; resourceType: string }>,
  timeoutMs: number,
  quietWindowMs: number,
) {
  const startedAt = Date.now();
  const [domQuiet, networkQuiet] = await Promise.all([
    waitForDomQuiet(page, quietWindowMs, timeoutMs).then(() => true).catch(() => false),
    waitForNetworkQuiet(activeRequests, quietWindowMs, timeoutMs, []).then(() => true).catch(() => false),
  ]);
  const visibleLoader = await page
    .locator('[aria-busy="true"], [role="progressbar"], .loading, .spinner')
    .evaluateAll((elements) => elements.some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }))
    .catch(() => false);
  return { method: "dom-and-network" as const, durationMs: Date.now() - startedAt, domQuiet, networkQuiet, visibleLoader };
}

async function waitForDomQuiet(page: Page, quietWindowMs: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let prior = await page.content();
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, quietWindowMs)));
    const current = await page.content();
    if (current !== prior) {
      prior = current;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietWindowMs) return;
  }
  throw new Error("DOM did not become quiet");
}

async function waitForNetworkQuiet(
  activeRequests: Map<string, { url: string; resourceType: string }>,
  quietWindowMs: number,
  timeoutMs: number,
  ignorePatterns: string[],
) {
  const ignored = [...ignorePatterns, "google-analytics", "googletagmanager", "cloudflareinsights", "segment.io"];
  let quietSince: number | undefined;
  await expectEventually(async () => {
    const relevant = [...activeRequests.values()].filter((request) =>
      !["websocket", "eventsource"].includes(request.resourceType)
      && !ignored.some((pattern) => request.url.includes(pattern))
    );
    if (relevant.length > 0) {
      quietSince = undefined;
      return false;
    }
    quietSince ??= Date.now();
    return Date.now() - quietSince >= quietWindowMs;
  }, timeoutMs);
}

async function expectEventually(check: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error ? lastError : new Error("Readiness condition was not satisfied before timeout");
}

function classifyOutcome(
  state: ExecutionReport["state"],
  steps: StepExecutionResult[],
  policyViolations: PolicyViolationRecord[],
): ExecutionReport["outcomeClassification"] {
  if (state === "cancelled") return "cancelled";
  if (state === "timed_out") return "execution_timeout";
  if (state === "infrastructure_error") return "infrastructure_failure";
  if (policyViolations.some((item) => item.disposition === "fatal")) return "policy_failure";
  if (steps.some((step) => isAmbiguousTargetError(step.error))) return "inconclusive_plan";
  if (steps.some((step) => step.readiness?.status === "failed")) return "readiness_timeout";
  if (steps.some((step) => step.assertions.some((assertion) => assertion.status === "failed"))) return "assertion_failure";
  // A step can fail before any assertion is evaluated—for example when an
  // authored locator matches no element and Playwright times out trying to
  // click it. That says the plan could not execute, not that the application
  // violated a declared expectation.
  if (steps.some((step) => step.status === "failed" && step.error)) return "inconclusive_plan";
  const evaluatedAssertions = steps.flatMap((step) => step.assertions).filter((assertion) => assertion.status !== "unevaluated");
  const configuredReadiness = steps.some((step) => step.readiness?.status === "passed");
  const finalEvidence = steps.some((step) => step.artifacts.some((artifact) => artifact.observation?.captureIntent === "final"));
  const transientEvidence = steps.some((step) => step.artifacts.some((artifact) => artifact.observation?.captureIntent === "transient"));
  if (transientEvidence && !finalEvidence && evaluatedAssertions.length === 0) return "transient_observation";
  if (state === "passed" && evaluatedAssertions.length === 0 && !configuredReadiness) return "inconclusive_plan";
  return state === "passed" ? "passed" : "inconclusive_plan";
}

function isAmbiguousTargetError(error?: string) {
  return Boolean(
    error
    && (
      error.includes("Target is ambiguous:")
      || error.includes("strict mode violation")
      || /resolved to \d+ elements/i.test(error)
    )
  );
}

function attachCapabilityGuards(
  context: BrowserContext,
  primaryPage: Page,
  options: ExecuteOptions,
  reject: (error: RuntimePolicyError) => Promise<void>,
) {
  context.on("page", (page) => {
    if (page === primaryPage || options.policy.allowPopups) return;
    void reject(
      new RuntimePolicyError("POPUP_NOT_ALLOWED", "Popup or new page was blocked"),
    ).finally(() => void page.close().catch(() => undefined));
  });
  primaryPage.on("download", (download) => {
    if (options.policy.allowDownloads) return;
    void reject(
      new RuntimePolicyError(
        "DOWNLOAD_NOT_ALLOWED",
        "Download was blocked",
        download.suggestedFilename(),
      ),
    ).finally(() => void download.cancel().catch(() => undefined));
  });
}

async function attachRequestInterception(
  context: BrowserContext,
  page: Page,
  requestPolicy: RuntimeRequestPolicy,
  reject: (
    error: RuntimePolicyError,
    context?: { fatal?: boolean; resourceType?: string },
  ) => Promise<void>,
): Promise<CDPSession> {
  const session = await context.newCDPSession(page);
  const frameTree = await session.send("Page.getFrameTree") as {
    frameTree: { frame: { id: string } };
  };
  const primaryFrameId = frameTree.frameTree.frame.id;
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }],
  });
  session.on(
    "Fetch.requestPaused",
    (parameters: {
      requestId: string;
      frameId?: string;
      resourceType?: string;
      request: { url: string };
    }) => {
      void (async () => {
        const isPrimaryDocument =
          parameters.resourceType === "Document"
          && parameters.frameId === primaryFrameId;
        try {
          if (isPrimaryDocument) {
            await requestPolicy.assertAllowed(parameters.request.url);
          } else {
            await requestPolicy.assertSafeSubresource(parameters.request.url);
          }
          await session.send("Fetch.continueRequest", {
            requestId: parameters.requestId,
          });
        } catch (error) {
          const violation =
            error instanceof RuntimePolicyError
              ? error
              : new RuntimePolicyError(
                  "ORIGIN_NOT_ALLOWED",
                  `Request policy check failed: ${errorMessage(error)}`,
                  parameters.request.url,
                );
          const resourceType = parameters.resourceType ?? "Other";
          await reject(violation, {
            resourceType,
            fatal: isPrimaryDocument,
          });
          await session
            .send("Fetch.failRequest", {
              requestId: parameters.requestId,
              errorReason: "BlockedByClient",
            })
            .catch(() => undefined);
        }
      })();
    },
  );
  return session;
}

function markRemainingAssertionsUnevaluated(result: StepExecutionResult) {
  for (const assertion of result.assertions) {
    if (assertion.status !== "passed" && assertion.status !== "failed") assertion.status = "unevaluated";
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error("Execution aborted");
}

async function missingSecretResolver(reference: string): Promise<string> {
  throw new Error(`No secret resolver configured for reference: ${reference}`);
}

async function missingPublicValueResolver(reference: string): Promise<string> {
  throw new Error(`Generated public value ${reference} cannot be resolved because no public-value resolver is configured`);
}

class InfrastructureDependencyError extends Error {
  override name = "InfrastructureDependencyError";
}

function isBrowserInfrastructureFailure(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("browser has been closed")
    || message.includes("browser closed")
    || message.includes("browser disconnected")
    || message.includes("target page, context or browser has been closed")
    || message.includes("target closed");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function optionalTimeout(timeoutMs: number | undefined): { timeout?: number } {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

async function stopBrowser(context: BrowserContext | undefined, browser: Browser | undefined) {
  await Promise.allSettled([
    context ? boundedClose(context.close()) : Promise.resolve(),
    browser ? boundedClose(browser.close()) : Promise.resolve(),
  ]);
}

async function boundedClose(operation: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser shutdown timed out")), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergeArtifactTimeline(...groups: RecordingTimelineEntry[][]): RecordingTimelineEntry[] {
  return groups.flat().sort((left, right) => {
    const leftTime = "startedAt" in left ? left.startedAt : left.occurredAt;
    const rightTime = "startedAt" in right ? right.startedAt : right.occurredAt;
    return Date.parse(leftTime) - Date.parse(rightTime);
  }).map((entry, sequence) => ({ ...entry, sequence }));
}
