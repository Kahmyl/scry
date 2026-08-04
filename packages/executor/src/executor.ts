import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  attemptResultSchema,
  veilPolicySnapshotSchema,
  validatePlanAgainstPolicy,
  type CurrentAction,
  type Artifact,
  type Assertion,
  type RecordingTimelineEntry,
} from "@scry/contracts";
import {
  classifyAction,
  RuntimePolicyError,
  RuntimeRequestPolicy,
  SecretRedactor,
} from "@scry/policy";
import { compileDefaultVeilPolicy, veilPolicyDigest, VeilAuthority } from "@scry/veil";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";

import {
  availableArtifact,
  ensureOutputDirectories,
  registerVeilEvidenceAdmission,
  writeJson,
} from "./artifacts.js";
import { playwrightBrowserChannel, visualRedactionInitScript } from "@scry/praxis";
import { registerGroundingHistoryProvider, resolveTargetLocator } from "@scry/praxis";
import { requirePraxisSuccess, type PraxisConsumerContext } from "@scry/praxis";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { RecordingCoordinator } from "./recording-coordinator.js";
import { VeilRuntimeCoordinator, type PrivacyCollector, type PrivacyPreparation } from "@scry/veil";
import { VeilClipboardCollector } from "@scry/veil";
import { VeilChannelCollector } from "@scry/veil";
import { VeilVisualCaptureAuthority } from "@scry/veil";
import { VeilVideoSegmentAuthority } from "@scry/veil";
import { BrowserSessionProvenance } from "./browser-session.js";
import {
  PlaywrightProtectedCapsuleFactory,
  ProtectedTransactionCoordinator,
  type ProtectedTransactionExecution,
} from "./protected-transaction-coordinator.js";
import { TraceCoordinator } from "./trace-coordinator.js";
import { sanitizeTraceArchive } from "./trace-sanitizer.js";
import {
  CalibrationRequiredError,
  capturePageStructure,
  protectedTransactionDigest,
  structureFingerprint,
} from "./calibration.js";
import { CheckpointCoordinator } from "./checkpoint-coordinator.js";
import {
  executeReadiness,
  ReadinessTimeoutError,
  stabilizeApplication,
} from "./readiness-runtime.js";
import {
  executeAction,
  InfrastructureDependencyError,
  missingSecretResolver,
  requirePraxisContext,
} from "./action-runtime.js";
import { attachDiagnostics, attachNetworkCapture } from "./runtime-diagnostics.js";
import {
  captureFailureScreenshot,
  captureRequestedEvidence,
  captureScreenshotWithFallback,
  installVisualRedactionStyles,
} from "./evidence-runtime.js";
import {
  executeAssertion,
  executableAssertions,
  initializeSteps,
  markRemainingAssertionsUnevaluated,
} from "./execution-assertions.js";
import {
  attachCapabilityGuards,
  attachRequestInterception,
  boundedClose,
  canonicalVeilOrigin,
  errorMessage,
  isBrowserInfrastructureFailure,
  stopBrowser,
  throwIfAborted,
} from "./execution-browser-policy.js";
import { buildExecutionReport } from "./execution-report.js";
import { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";
import { ExecutionState } from "./execution-state.js";
import { ExecutionEventStream } from "./execution-events.js";
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
    throw new Error(
      `Plan rejected by policy: ${violations.map((item) => item.message).join("; ")}`,
    );
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
  const usesProtectedValues = options.plan.steps.some(
    (step) =>
      step.action.type === "protectedTransaction" ||
      (step.action.type === "fill" &&
        Boolean(step.action.secretRef || step.action.capturedSecretRef)),
  );
  const requestPolicy = new RuntimeRequestPolicy(options.plan, options.policy);
  const runArtifacts: Artifact[] = [];
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let safeProvenance: BrowserSessionProvenance | undefined;
  const state = new ExecutionState();
  let recording: RecordingCoordinator | undefined;
  let trace: TraceCoordinator | undefined;
  let privacyGate: VeilRuntimeCoordinator | undefined;
  let veilChannelCollectors = new Map<string, VeilChannelCollector>();
  let checkpointCoordinator: CheckpointCoordinator | undefined;

  let unregisterPraxisVeil: (() => void) | undefined;
  const veilPolicy = resolveVeilPolicyForExecution(options.policy, options.veilPolicySnapshot);
  const veilAuthority = new VeilAuthority(veilPolicy);
  const veilVisualCapture = new VeilVisualCaptureAuthority(veilPolicy.digest);
  const veilVideoSegments = new VeilVideoSegmentAuthority(veilPolicy.digest, veilVisualCapture);
  const veilCaptureBinding = () => ({
    browserContextId: safeProvenance?.contextId ?? attemptId,
    pageId: runId,
    frameId: "main-frame",
    documentEpoch: state.captureEpoch,
  });
  const veilAdmissionKey =
    options.veilAdmissionKey ??
    (process.env.NODE_ENV === "test" ? "scry-test-only-veil-admission-key-32-bytes" : undefined);
  if (!veilAdmissionKey) throw new Error("VEIL_ADMISSION_KEY_REQUIRED");
  const unregisterVeilAdmission = registerVeilEvidenceAdmission({
    root: options.outputDirectory,
    authority: veilAuthority,
    admissionKey: veilAdmissionKey,
    visualAdmission: (permit) => veilVisualCapture.admissionBinding(permit),
    videoAdmission: (finalization) => veilVideoSegments.consumeFinalization(finalization),
    context: () => ({
      userId: "executor",
      environmentId: options.environmentId ?? "local-environment",
      transactionId: attemptId,
      origin: canonicalVeilOrigin(page?.url(), options.plan.allowedOrigins[0]!),
      browserContextId: safeProvenance?.contextId ?? attemptId,
      pageId: runId,
      frameId: "main-frame",
      documentEpoch: state.captureEpoch,
    }),
  });

  await ensureOutputDirectories(options.outputDirectory);
  await writeFile(eventPath, "", "utf8");

  const eventStream = new ExecutionEventStream({
    eventPath,
    runId,
    attemptId,
    redactor,
    isSuppressed: () =>
      Boolean(
        privacyGate?.isSuppressed() ||
        veilChannelCollectors.get("event-report")?.isCaptureSuppressed(),
      ),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const emit = eventStream.emit;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    state.timedOut = true;
    timeoutController.abort(new Error("Run duration budget exceeded"));
    void stopBrowser(context, browser);
  }, options.plan.budgets.maxDurationMs);
  const cancel = () => {
    state.cancelled = true;
    timeoutController.abort(options.signal?.reason ?? new Error("Run state.cancelled"));
    void stopBrowser(context, browser);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    await emit("attempt.started", {
      planName: options.plan.name,
    });
    const browserChannel = playwrightBrowserChannel(options.browserChannel);
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
    unregisterPraxisVeil = registerPraxisVeilAuthority(page, {
      authority: veilAuthority,
      userId: "executor",
      environmentId: options.environmentId ?? "local-environment",
      browserContextId: safeProvenance?.contextId ?? attemptId,
    });
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
    veilChannelCollectors = new Map(
      ["screenshot", "dom", "accessibility", "diagnostics", "network", "event-report"].map(
        (name) => [name, new VeilChannelCollector(name)] as const,
      ),
    );
    attachDiagnostics(
      page,
      diagnostics,
      emit,
      redactor,
      () =>
        veilChannelCollectors.get("diagnostics")!.isCaptureSuppressed() ||
        privacyGate?.getDecision("console") === "suppress" ||
        privacyGate?.getDecision("console") === "quarantine",
    );
    attachNetworkCapture(
      page,
      networkRecords,
      redactor,
      networkActivity,
      pendingNetworkBodies,
      () =>
        veilChannelCollectors.get("network")!.isCaptureSuppressed() ||
        privacyGate?.getDecision("network") === "suppress" ||
        privacyGate?.getDecision("network") === "quarantine",
    );
    attachCapabilityGuards(context, page, options, rejectPolicy);
    recording = new RecordingCoordinator({
      outputDirectory: options.outputDirectory,
      emit: (type, payload) => emit(type, payload),
      videoAuthority: veilVideoSegments,
      videoBinding: veilCaptureBinding,
    });
    trace = new TraceCoordinator({
      context,
      outputDirectory: options.outputDirectory,
      sanitize: (target) => sanitizeTraceArchive(target, redactor),
    });
    let recordingVeilState: ReturnType<PrivacyCollector["state"]>["status"] = "active";
    let recordingOperationId = "protected-operation";
    let recordingPreparation: PrivacyPreparation = {
      mode: "protected_recording_gap",
      videoMaskEstablished: false,
    };
    const recordingCollector: PrivacyCollector = {
      name: "recording",
      arm: async (operationId, preparation) => {
        if (recordingVeilState !== "active") throw new Error("RECORDING_NOT_ACTIVE");
        recordingOperationId = operationId;
        recordingPreparation = preparation ?? recordingPreparation;
        recordingVeilState = "prepared";
      },
      suspend: async () => {
        if (recordingVeilState !== "prepared") throw new Error("RECORDING_NOT_PREPARED");
        recordingVeilState = "suspended";
      },
      isolate: async () => {
        if (recordingVeilState !== "suspended") throw new Error("RECORDING_NOT_SUSPENDED");
        if (
          recordingPreparation.mode === "protected_recording_gap" ||
          !recordingPreparation.videoMaskEstablished
        ) {
          await recording!.createProtectedGap({
            operationId: recordingOperationId,
            reason: "Veil protected interval",
          });
        }
        recordingVeilState = "isolated";
      },
      resume: async () => {
        if (recordingVeilState !== "isolated") throw new Error("RECORDING_NOT_ISOLATED");
        if (!recording!.hasActiveSegment())
          await recording!.startSegment({ reason: "safe_resume" });
        recordingVeilState = "active";
      },
      seal: async ({ code }) => {
        await recording!.seal(code);
        recordingVeilState = "sealed";
      },
      finalize: async () => {
        await recording!.finalize();
        recordingVeilState = "finalized";
      },
      state: () => ({ status: recordingVeilState }),
    };
    const clipboardCollector = new VeilClipboardCollector(page);
    const passiveCollectors = [...veilChannelCollectors.values(), clipboardCollector];
    privacyGate = new VeilRuntimeCoordinator(
      [recordingCollector, trace, ...passiveCollectors],
      (privacyEvent) => emit("privacy.state_changed", privacyEvent),
      5_000,
      veilPolicy.digest,
      `${runId}:${attemptId}`,
    );
    page.once("close", () => {
      void privacyGate?.seal({ code: "ACTIVE_PAGE_CLOSED" }).catch(() => undefined);
    });
    browser.once("disconnected", () => {
      void privacyGate?.seal({ code: "BROWSER_DISCONNECTED" }).catch(() => undefined);
    });
    state.startCaptureEpoch("run_started", safeProvenance?.contextId ?? randomUUID());
    await recording.startSegment({ page, reason: "run_started" });
    await trace.start("run_started");
    await options.recordingTestHook?.({ page, recording });
    await options.privacyTestHook?.({ page, privacy: privacyGate });

    if (options.checkpointStore && options.flowRevisionId && options.environmentId) {
      checkpointCoordinator = new CheckpointCoordinator({
        runId,
        flowRevisionId: options.flowRevisionId,
        environmentId: options.environmentId,
        allowedOrigins: options.plan.allowedOrigins,
        store: options.checkpointStore,
      });
    }

    for (let index = 0; index < options.plan.steps.length; index += 1) {
      const step = options.plan.steps[index]!;
      const readinessStep = options.plan.steps[index]!;
      throwIfAborted(timeoutController.signal);
      const result = steps[index]!;
      let unsafeProtectedFailure = false;
      let continueUnrecordedProtectedFailure = false;
      state.activeStepId = step.id;
      const stepStarted = new Date();
      result.startedAt = stepStarted.toISOString();
      await emit("step.started", {
        stepId: step.id,
        title: step.title,
        capability: classifyAction(step.action),
      });

      try {
        if (!page) throw new InfrastructureDependencyError("Active safe page is unavailable");
        const checkpoint = options.plan.checkpoints.find(
          (candidate) => candidate.beforeStepId === step.id,
        );
        if (checkpoint && !state.establishedCheckpoints.has(checkpoint.id)) {
          if (!checkpointCoordinator || !context)
            throw new InfrastructureDependencyError("Checkpoint persistence is unavailable");
          await checkpointCoordinator.establish(context, checkpoint);
          state.establishedCheckpoints.add(checkpoint.id);
          state.recordCheckpointBoundary(checkpoint.id, "established");
          await emit("checkpoint.established", {
            checkpointId: checkpoint.id,
            beforeStepId: checkpoint.beforeStepId,
          });
        }
        const policyEpochBeforeStep = policyEpoch;
        let protectedTerminal = false;
        let protectedContinuationStepId: string | undefined;
        if (step.action.type === "protectedTransaction") {
          if (
            !browser ||
            !context ||
            !page ||
            !safeProvenance ||
            !privacyGate ||
            !options.protectedTransactionStore ||
            !options.atomicSecretCapture ||
            !options.publicValueCapture
          ) {
            throw new InfrastructureDependencyError(
              "Protected transaction dependencies are unavailable",
            );
          }
          let protectedAssertionOrdinal = 0;
          const transaction: ProtectedTransactionExecution =
            await new ProtectedTransactionCoordinator({
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
                registerPraxisVeilAuthority(capsule.page, {
                  authority: veilAuthority,
                  userId: "executor",
                  environmentId: options.environmentId ?? "local-environment",
                  browserContextId: capsule.provenance.contextId,
                });
                if (options.groundingHistory)
                  registerGroundingHistoryProvider(capsule.page, options.groundingHistory);
                await attachRequestInterception(
                  capsule.context,
                  capsule.page,
                  requestPolicy,
                  rejectPolicy,
                );
                attachCapabilityGuards(capsule.context, capsule.page, options, rejectPolicy);
              },
              verifyCalibration: async (capsule, action) => {
                if (!action.calibrationAttestationId) return;
                if (!options.calibrationVerifier)
                  throw new InfrastructureDependencyError("Calibration verifier is unavailable");
                try {
                  const fingerprint = structureFingerprint(
                    await capturePageStructure(capsule.page, action),
                  );
                  const operationDigest = protectedTransactionDigest(
                    action,
                    options.plan.allowedOrigins,
                  );
                  const verified = await options.calibrationVerifier({
                    attestationId: action.calibrationAttestationId,
                    operationId: action.operationId,
                    operationDigest,
                    structureFingerprint: fingerprint,
                  });
                  await emit("calibration.boundary_reached", {
                    operationId: action.operationId,
                    attestationId: action.calibrationAttestationId,
                    operationDigest,
                    structureFingerprint: fingerprint,
                    verified,
                    mode: "production_verification",
                  });
                  if (!verified) throw new CalibrationRequiredError();
                } catch (error) {
                  await emit("calibration.boundary_reached", {
                    operationId: action.operationId,
                    code:
                      error && typeof error === "object" && "code" in error
                        ? String(
                            (error as { code?: unknown }).code ?? "CALIBRATION_VERIFICATION_FAILED",
                          )
                        : "CALIBRATION_VERIFICATION_FAILED",
                    message:
                      error instanceof Error
                        ? error.message.slice(0, 500)
                        : "CALIBRATION_VERIFICATION_FAILED",
                    verified: false,
                    mode: "production_verification_failed",
                  });
                  throw error;
                }
              },
              onPreparationVerified: async (capsule, action) => {
                if (options.calibrationRehearsal?.operationId !== action.operationId) return;
                const structure = await capturePageStructure(capsule.page, action);
                await options.calibrationRehearsal.onBoundary({
                  stepId: step.id,
                  structure,
                  url: capsule.page.url(),
                });
                await emit("calibration.boundary_reached", {
                  stepId: step.id,
                  operationId: action.operationId,
                });
                state.calibrationBoundaryReached = true;
              },
              verifyAssertions: async (targetPage, assertions) => {
                for (const assertion of assertions)
                  await executeAssertion(
                    targetPage,
                    assertion,
                    options.plan.allowedOrigins[0]!,
                    {
                      runId,
                      attemptId,
                      stepId: step.id,
                      channel: "assertion",
                      ordinal: protectedAssertionOrdinal++,
                      allowedOrigins: options.plan.allowedOrigins,
                      timeoutMs: assertion.timeoutMs ?? 10_000,
                      ...(options.onPraxisResult ? { record: options.onPraxisResult } : {}),
                    },
                    timeoutController.signal,
                  );
              },
              reconcile: async () => "unknown",
              ...(options.recordContextProvenance
                ? { onContextProvenance: options.recordContextProvenance }
                : {}),
              ...(options.recoverAcquisition
                ? { recoverAcquisition: options.recoverAcquisition }
                : {}),
              onEvidenceResumed: async ({ contextId }) => {
                state.endCaptureEpoch("sealed", "sealed");
                state.startCaptureEpoch("checkpoint_restored", contextId);
              },
              emit,
              signal: timeoutController.signal,
            }).execute(step.action);
          browser = transaction.safeSession.browser;
          context = transaction.safeSession.context;
          page = transaction.safeSession.page;
          safeProvenance = transaction.safeSession.provenance;
          unregisterPraxisVeil?.();
          unregisterPraxisVeil = registerPraxisVeilAuthority(page, {
            authority: veilAuthority,
            userId: "executor",
            environmentId: options.environmentId ?? "local-environment",
            browserContextId: safeProvenance.contextId,
          });
          protectedTerminal = transaction.terminal;
          protectedContinuationStepId = transaction.result.continuedAtStepId;
          for (const [reference, credentialId] of Object.entries(
            transaction.result.credentialReferences,
          ))
            capturedSecrets.set(reference, credentialId);
          for (const [reference, valueId] of Object.entries(
            transaction.result.publicValueReferences,
          ))
            capturedValues.set(reference, valueId);
          await emit("privacy.operation_completed", {
            operationId: step.action.operationId,
            result: transaction.result,
          });
          if (
            transaction.result.status === "aborted" ||
            transaction.result.status === "outcome_unknown"
          )
            throw new UnsafeProtectedCaptureError(transaction.result.status);
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
            {
              runId,
              attemptId,
              stepId: step.id,
              channel: "action",
              ordinal: index,
              allowedOrigins: options.plan.allowedOrigins,
              timeoutMs: "timeoutMs" in step.action ? (step.action.timeoutMs ?? 10_000) : 10_000,
              ...(options.onPraxisResult ? { record: options.onPraxisResult } : {}),
            },
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
                    Math.round(
                      readinessStep.after.timeoutMs * (options.readinessTimeoutMultiplier ?? 1),
                    ),
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
            readinessStep?.captureIntent === "final" &&
            (step.action.type === "screenshot" ||
              step.evidence.includes("screenshot") ||
              step.evidence.includes("dom"))
          ) {
            result.stabilization = await stabilizeApplication(
              page,
              networkActivity.active,
              3_000,
              500,
            );
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
          const capturePage = page;
          const fullPage = step.action.fullPage;
          const screenshotPath = path.join(
            options.outputDirectory,
            "screenshots",
            `${step.action.name}.png`,
          );
          const { permit } = await veilVisualCapture.issue(capturePage, veilCaptureBinding());
          const fallback = await veilVisualCapture.capture(
            capturePage,
            permit,
            veilCaptureBinding(),
            () => captureScreenshotWithFallback(capturePage, screenshotPath, fullPage),
          );
          const artifact = await availableArtifact(
            "screenshot",
            "image/png",
            screenshotPath,
            `screenshots/${step.action.name}.png`,
            { classification: "public", capturePermit: permit },
          );
          artifact.observation = {
            ...artifact.observation,
            ...observation,
            screenshotMode: fallback
              ? "viewport-fallback"
              : step.action.fullPage
                ? "full-page"
                : "viewport",
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
            await executeAssertion(
              page,
              assertion,
              options.plan.allowedOrigins[0]!,
              {
                runId,
                attemptId,
                stepId: step.id,
                channel: "assertion",
                ordinal: assertionIndex,
                allowedOrigins: options.plan.allowedOrigins,
                timeoutMs: assertion.timeoutMs ?? 10_000,
                ...(options.onPraxisResult ? { record: options.onPraxisResult } : {}),
              },
              timeoutController.signal,
            );
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
          veilChannelCollectors,
          veilVisualCapture,
          veilCaptureBinding,
        );
        result.status = "passed";
        await emit("step.passed", {
          stepId: step.id,
          assertions: result.assertions,
        });
        if (protectedTerminal) break;
        if (protectedContinuationStepId)
          index =
            options.plan.steps.findIndex(
              (candidate) => candidate.id === protectedContinuationStepId,
            ) - 1;
      } catch (error) {
        if (timeoutController.signal.aborted) throw error;
        if (isBrowserInfrastructureFailure(error)) {
          throw new InfrastructureDependencyError(
            `Browser execution failed: ${errorMessage(error)}`,
          );
        }
        if (error instanceof InfrastructureDependencyError) throw error;
        result.action = { status: "failed", error: redactor.redact(errorMessage(error)) };
        result.status = "failed";
        result.error = redactor.redact(errorMessage(error));
        unsafeProtectedFailure = error instanceof UnsafeProtectedCaptureError;
        continueUnrecordedProtectedFailure = error instanceof ContinueUnrecordedProtectedError;
        markRemainingAssertionsUnevaluated(result);
        await captureFailureScreenshot(
          page,
          options.outputDirectory,
          step.id,
          result,
          privacyGate,
          veilChannelCollectors,
          veilVisualCapture,
          veilCaptureBinding,
        );
        await emit("step.failed", {
          stepId: step.id,
          error: result.error,
          assertions: result.assertions,
        });
        if (
          !continueUnrecordedProtectedFailure &&
          (unsafeProtectedFailure || step.onFailure === "stop")
        )
          break;
      } finally {
        const completed = new Date();
        result.completedAt = completed.toISOString();
        result.durationMs = completed.getTime() - stepStarted.getTime();
      }
    }
    state.terminalState = steps.some((step) => step.status === "failed") ? "failed" : "passed";
    if (options.calibrationRehearsal && !state.calibrationBoundaryReached) {
      throw new Error("CALIBRATION_BOUNDARY_NOT_REACHED");
    }
  } catch (error) {
    state.fatalError = redactor.redact(
      state.timedOut || state.cancelled
        ? errorMessage(timeoutController.signal.reason ?? error)
        : errorMessage(error),
    );
    if (state.activeStepId) {
      const active = steps.find((step) => step.id === state.activeStepId);
      if (active?.status === "unevaluated") {
        active.error = state.fatalError;
      }
    }
    state.terminalState = state.timedOut
      ? "timed_out"
      : state.cancelled
        ? "cancelled"
        : "infrastructure_error";
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    await emit("attempt.finalizing", { state: state.terminalState });
    if (privacyGate && (state.privacySealed || state.cancelled || state.timedOut)) {
      await privacyGate
        .seal({
          code: state.privacySealed
            ? "UNRESOLVED_PROTECTED_CAPTURE"
            : state.cancelled
              ? "RUN_CANCELLED"
              : "RUN_TIMED_OUT",
        })
        .catch(() => undefined);
    }
    if (privacyGate) {
      try {
        await privacyGate.finalize();
      } catch (error) {
        state.privacySealed = true;
        state.terminalState = "infrastructure_error";
        state.fatalError = errorMessage(error);
        await privacyGate.seal({ code: "VEIL_COLLECTOR_FINALIZE_FAILED" }).catch(() => undefined);
        await emit("privacy.state_changed", {
          state: "sealed",
          code: "VEIL_COLLECTOR_FINALIZE_FAILED",
          diagnostic: errorMessage(error),
        }).catch(() => undefined);
      }
    }
    if (recording) {
      if (state.privacySealed || state.cancelled || state.timedOut) {
        await recording
          .seal(
            state.privacySealed
              ? "UNRESOLVED_PROTECTED_CAPTURE"
              : state.cancelled
                ? "RUN_CANCELLED"
                : "RUN_TIMED_OUT",
          )
          .catch(() => undefined);
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
      for (const artifact of traceArtifacts)
        await emit("artifact.created", { artifact, path: artifact.relativePath });
    }
    if (context && state.terminalState === "passed" && options.captureBrowserState) {
      await Promise.resolve(options.captureBrowserState(await context.storageState())).catch(
        () => undefined,
      );
    }
    if (context) {
      await boundedClose(context.close()).catch(() => undefined);
    }
    if (browser) await boundedClose(browser.close()).catch(() => undefined);
    unregisterPraxisVeil?.();
    unregisterVeilAdmission();
  }

  state.endCaptureEpoch(
    state.privacySealed ? "sealed" : "run_completed",
    state.privacySealed ? "sealed" : "completed",
  );
  const completedAt = new Date();
  const report = buildExecutionReport({
    planName: options.plan.name,
    runId,
    attemptId,
    state: state.terminalState,
    startedAt,
    completedAt,
    steps,
    diagnostics,
    policyViolations,
    retiredArtifacts: state.retiredArtifacts,
    runArtifacts,
    retiredTimeline: state.retiredTimeline,
    lifecycleTimeline: state.lifecycleTimeline,
    recordingTimeline: recording?.timeline() ?? [],
    traceTimeline: trace?.timeline() ?? [],
    ...(state.fatalError ? { error: state.fatalError } : {}),
  });
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

class UnsafeProtectedCaptureError extends Error {
  constructor(message: string) {
    super(`Protected capture could not resolve safely; recording remained sealed. ${message}`);
    this.name = "UnsafeProtectedCaptureError";
  }
}

class ContinueUnrecordedProtectedError extends Error {
  override name = "ContinueUnrecordedProtectedError";
}

export { resolveVeilPolicyForExecution } from "./execution-veil-policy.js";
