import { randomUUID } from "node:crypto";
import { appendFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  attemptResultSchema,
  runEventSchema,
  validatePlanAgainstPolicy,
  type Action,
  type Artifact,
  type Assertion,
  type Readiness,
  type ReadinessCondition,
  type RunEvent,
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
import { resolveLocator, resolveUniqueLocator } from "./locator.js";
import { sanitizeTraceArchive } from "./trace-sanitizer.js";
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
  const tracePath = path.join(options.outputDirectory, "trace.zip");
  const videoPath = path.join(options.outputDirectory, "video", "run.webm");
  const steps = initializeSteps(options);
  const diagnostics: DiagnosticRecord[] = [];
  const networkRecords: Array<Record<string, unknown>> = [];
  const pendingNetworkBodies = new Set<Promise<void>>();
  const networkActivity = { active: new Map<string, { url: string; resourceType: string }>() };
  const policyViolations: PolicyViolationRecord[] = [];
  const redactor = new SecretRedactor();
  const capturedSecrets = new Map<string, string>();
  const usesProtectedValues = options.plan.steps.some((step) =>
    step.action.type === "captureSecret"
    || (step.action.type === "fill" && Boolean(step.action.secretRef || step.action.capturedSecretRef))
  );
  const requestPolicy = new RuntimeRequestPolicy(options.plan, options.policy);
  const runArtifacts: Artifact[] = [];
  let sequence = 0;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let terminalState: ExecutionReport["state"] = "infrastructure_error";
  let timedOut = false;
  let cancelled = false;
  let activeStepId: string | undefined;
  let fatalError: string | undefined;
  let eventWriteChain = Promise.resolve();
  let sensitiveOverlayActive = false;

  await ensureOutputDirectories(options.outputDirectory);
  await writeFile(eventPath, "", "utf8");

  const emit = async (type: RunEvent["type"], payload: Record<string, unknown>) => {
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
      protocolVersion: options.plan.protocolVersion,
      planName: options.plan.name,
    });
    browser = await chromium.launch({
      headless: options.headless ?? true,
      ...(options.browserChannel ? { channel: options.browserChannel } : {}),
    });
    const viewport = options.viewport ?? { width: 1280, height: 720 };
    context = await browser.newContext({
      viewport,
      recordVideo: {
        dir: path.join(options.outputDirectory, "video"),
        size: viewport,
      },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await installVisualRedactionStyles(context);
    page = await context.newPage();
    let policyVersion = 0;
    const rejectPolicy = async (
      error: RuntimePolicyError,
      context: { fatal?: boolean; resourceType?: string } = {},
    ) => {
      const fatal = context.fatal ?? true;
      if (fatal) policyVersion += 1;
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
    attachDiagnostics(page, diagnostics, emit, redactor, () => sensitiveOverlayActive);
    attachNetworkCapture(page, networkRecords, redactor, networkActivity, pendingNetworkBodies, () => sensitiveOverlayActive);
    attachCapabilityGuards(context, page, options, rejectPolicy);

    for (const [index, step] of options.plan.steps.entries()) {
      const v2Step = options.plan.protocolVersion === "2" ? options.plan.steps[index]! : undefined;
      throwIfAborted(timeoutController.signal);
      const result = steps[index]!;
      activeStepId = step.id;
      const stepStarted = new Date();
      result.startedAt = stepStarted.toISOString();
      await emit("step.started", {
        stepId: step.id,
        title: step.title,
        capability: classifyAction(step.action),
      });

      try {
        const nextStep = options.plan.steps[index + 1];
        if (!sensitiveOverlayActive && nextStep?.action.type === "captureSecret") {
          await showSensitiveOverlay(page);
          sensitiveOverlayActive = true;
        }
        const policyVersionBeforeStep = policyVersion;
        await executeAction(
          page,
          step.action,
          options,
          timeoutController.signal,
          redactor,
          capturedSecrets,
        );
        const actionCompletedAt = new Date();
        if (
          sensitiveOverlayActive
          && step.action.type === "captureSecret"
          && options.plan.steps[index + 1]?.action.type !== "captureSecret"
        ) {
          await hideSensitiveOverlay(page);
          sensitiveOverlayActive = false;
        }
        if (options.plan.protocolVersion === "1" && (
          step.action.type === "click" ||
          step.action.type === "press" ||
          step.action.type === "navigate"
        )) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (policyVersion !== policyVersionBeforeStep) {
          throw new Error("Action was blocked by execution policy");
        }
        if (options.plan.protocolVersion === "2") {
          const readinessStartedAt = new Date();
          if (v2Step?.after) {
            try {
              const matchedConditions = await executeReadiness(
                page,
                {
                  ...v2Step.after,
                  timeoutMs: Math.min(
                    60_000,
                    Math.round(v2Step.after.timeoutMs * (options.readinessTimeoutMultiplier ?? 1)),
                  ),
                },
                options.plan.allowedOrigins[0]!,
                networkRecords,
                networkActivity.active,
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
            v2Step?.captureIntent === "final"
            && (step.action.type === "screenshot" || step.evidence.includes("screenshot") || step.evidence.includes("dom"))
          ) {
            result.stabilization = await stabilizeApplication(page, networkActivity.active, 3_000, 500);
          }
        }
        const observation = options.plan.protocolVersion === "2"
          ? {
              millisecondsSinceAction: Date.now() - actionCompletedAt.getTime(),
              captureIntent: v2Step?.captureIntent ?? "final",
              readiness: result.readiness,
              stabilization: result.stabilization,
              ...(usesProtectedValues ? { visualRedaction: "protected-elements-masked" } : {}),
            }
          : usesProtectedValues
            ? { visualRedaction: "protected-elements-masked" }
            : undefined;
        if (step.action.type === "screenshot") {
          await page.screenshot({
            path: path.join(options.outputDirectory, "screenshots", `${step.action.name}.png`),
            fullPage: step.action.fullPage,
          });
          const artifact = await availableArtifact(
            "screenshot",
            "image/png",
            path.join(options.outputDirectory, "screenshots", `${step.action.name}.png`),
            `screenshots/${step.action.name}.png`,
          );
          if (observation) artifact.observation = observation;
          result.artifacts.push(artifact);
          await emit("artifact.created", {
            stepId: step.id,
            artifact,
            path: `screenshots/${step.action.name}.png`,
          });
        }
        const assertions = executableAssertions(step.id, step.action, step.assertions);
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
        );
        result.status = "passed";
        await emit("step.passed", {
          stepId: step.id,
          assertions: result.assertions,
        });
      } catch (error) {
        if (timeoutController.signal.aborted) throw error;
        result.status = "failed";
        result.error = redactor.redact(errorMessage(error));
        markRemainingAssertionsUnevaluated(result);
        await captureFailureScreenshot(page, options.outputDirectory, step.id, result);
        await emit("step.failed", {
          stepId: step.id,
          error: result.error,
          assertions: result.assertions,
        });
        if (step.onFailure === "stop") break;
      } finally {
        const completed = new Date();
        result.completedAt = completed.toISOString();
        result.durationMs = completed.getTime() - stepStarted.getTime();
      }
    }
    terminalState = steps.some((step) => step.status === "failed") ? "failed" : "passed";
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
    if (context) {
      try {
        await context.tracing.stop({ path: tracePath });
        await sanitizeTraceArchive(tracePath, redactor);
        const artifact = await availableArtifact("trace", "application/zip", tracePath, "trace.zip");
        if (usesProtectedValues) artifact.observation = { visualRedaction: "protected-elements-masked" };
        runArtifacts.push(artifact);
        await emit("artifact.created", { artifact, path: "trace.zip" });
      } catch {
        runArtifacts.push({
          id: randomUUID(),
          kind: "trace",
          status: "failed",
          contentType: "application/zip",
        });
      }
      await context.close().catch(() => undefined);
      try {
        const video = page?.video();
        if (video) {
          const recordedPath = await video.path();
          if (recordedPath !== videoPath) await rename(recordedPath, videoPath);
          const artifact = await availableArtifact(
            "video",
            "video/webm",
            videoPath,
            "video/run.webm",
          );
          if (usesProtectedValues) artifact.observation = { visualRedaction: "protected-elements-masked" };
          runArtifacts.push(artifact);
          await emit("artifact.created", { artifact, path: "video/run.webm" });
        }
      } catch {
        runArtifacts.push({
          id: randomUUID(),
          kind: "video",
          status: "failed",
          contentType: "video/webm",
        });
      }
    }
    await browser?.close().catch(() => undefined);
  }

  const completedAt = new Date();
  const assertions = steps.flatMap((step) => step.assertions);
  const report: ExecutionReport = {
    protocolVersion: options.plan.protocolVersion,
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
    artifacts: [...runArtifacts, ...steps.flatMap((step) => step.artifacts)],
    ...(fatalError ? { error: fatalError } : {}),
    steps,
    diagnostics,
    policyViolations,
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
    assertions: executableAssertions(step.id, step.action, step.assertions).map((assertion, index) => ({
      index,
      type: assertion.type,
      status: "unevaluated",
    })),
    artifacts: [],
  }));
}

function executableAssertions(stepId: string, action: Action, assertions: Assertion[]) {
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
  action: Action,
  options: ExecuteOptions,
  signal: AbortSignal,
  redactor: SecretRedactor,
  capturedSecrets: Map<string, string>,
) {
  throwIfAborted(signal);
  switch (action.type) {
    case "navigate":
      await page.goto(new URL(action.url, options.plan.allowedOrigins[0]).href, {
        waitUntil: "domcontentloaded",
        ...optionalTimeout(action.timeoutMs),
      });
      if (options.plan.protocolVersion === "1") {
        await waitForApplicationRender(page, action.timeoutMs);
      }
      return;
    case "click":
      await (await resolveUniqueLocator(page, action.target)).click(optionalTimeout(action.timeoutMs));
      return;
    case "fill": {
      const value =
        action.value ??
        (action.capturedSecretRef
          ? capturedSecrets.get(action.capturedSecretRef)
          : await (options.secretResolver ?? missingSecretResolver)(action.secretRef!));
      if (value === undefined) throw new Error(`Captured secret "${action.capturedSecretRef}" is unavailable`);
      if (action.secretRef || action.capturedSecretRef) redactor.add(value);
      const locator = await resolveUniqueLocator(page, action.target);
      if (action.secretRef || action.capturedSecretRef) await maskSensitiveLocator(locator);
      await locator.fill(value, optionalTimeout(action.timeoutMs));
      return;
    }
    case "captureSecret": {
      const locator = await resolveUniqueLocator(page, action.target);
      await locator.waitFor({ state: "visible", ...optionalTimeout(action.timeoutMs) });
      await maskSensitiveLocator(locator);
      const value = await locator.evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
        return element.textContent ?? "";
      });
      if (!value.trim()) throw new Error("Generated protected value was empty");
      redactor.add(value);
      capturedSecrets.set(action.reference, value);
      if (!options.secretCapture) throw new Error("This worker is not configured to store captured credentials");
      await options.secretCapture(action.credentialName, value);
      return;
    }
    case "select":
      await (await resolveUniqueLocator(page, action.target)).selectOption(action.value, {
        ...optionalTimeout(action.timeoutMs),
      });
      return;
    case "check":
      await (await resolveUniqueLocator(page, action.target)).setChecked(action.checked, {
        ...optionalTimeout(action.timeoutMs),
      });
      return;
    case "press":
      if (action.target) {
        await (await resolveUniqueLocator(page, action.target)).press(action.key, optionalTimeout(action.timeoutMs));
      } else {
        await page.keyboard.press(action.key);
      }
      return;
    case "scroll":
      if (action.target) {
        await (await resolveUniqueLocator(page, action.target)).evaluate(
          (element, deltaY) => element.scrollBy(0, deltaY),
          action.deltaY,
        );
      } else {
        await page.mouse.wheel(0, action.deltaY);
      }
      return;
    case "waitFor":
      await (await resolveUniqueLocator(page, action.target)).waitFor({
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
      await (await resolveUniqueLocator(page, assertion.target)).waitFor({
        state: "visible",
        ...optionalTimeout(assertion.timeoutMs),
      });
      return;
    case "hidden":
      await resolveLocator(page, assertion.target).waitFor({
        state: "hidden",
        ...optionalTimeout(assertion.timeoutMs),
      });
      return;
    case "text": {
      const locator = await resolveUniqueLocator(page, assertion.target);
      await locator.waitFor({ state: "visible", ...optionalTimeout(assertion.timeoutMs) });
      const actual = (await locator.textContent()) ?? "";
      const matches = assertion.exact ? actual.trim() === assertion.expected : actual.includes(assertion.expected);
      if (!matches) throw new Error(`Expected text "${assertion.expected}", received "${actual.trim()}"`);
      return;
    }
    case "value": {
      const actual = await (await resolveUniqueLocator(page, assertion.target)).inputValue({
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
) {
  if (evidence.includes("screenshot")) {
    const file = path.join(root, "screenshots", `${stepId}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const artifact = await availableArtifact("screenshot", "image/png", file, `screenshots/${stepId}.png`);
    if (observation) artifact.observation = observation;
    result.artifacts.push(artifact);
  }
  if (evidence.includes("dom")) {
    const file = path.join(root, "dom", `${stepId}.html`);
    await writeFile(file, redactor.redact(await page.content()), "utf8");
    const artifact = await availableArtifact("dom", "text/html", file, `dom/${stepId}.html`);
    if (observation) artifact.observation = observation;
    result.artifacts.push(artifact);
  }
  if (evidence.includes("network")) {
    await Promise.allSettled([...pendingNetworkBodies]);
    const file = path.join(root, "network", `${stepId}.json`);
    await writeJson(file, redactor.redactValue({ requests: networkRecords }));
    const artifact = await availableArtifact("network", "application/json", file, `network/${stepId}.json`);
    if (observation) artifact.observation = observation;
    result.artifacts.push(artifact);
  }
}

async function captureFailureScreenshot(
  page: Page,
  root: string,
  stepId: string,
  result: StepExecutionResult,
) {
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
    const diagnostic: DiagnosticRecord = {
      type: "console",
      occurredAt: new Date().toISOString(),
      message: isProtectedCaptureActive() ? PROTECTED_CAPTURE_REDACTION : redactor.redact(message.text()),
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.console", diagnostic);
  });
  page.on("pageerror", (error) => {
    const diagnostic: DiagnosticRecord = {
      type: "page_error",
      occurredAt: new Date().toISOString(),
      message: isProtectedCaptureActive() ? PROTECTED_CAPTURE_REDACTION : redactor.redact(error.message),
    };
    diagnostics.push(diagnostic);
    void emit("diagnostic.page_error", diagnostic);
  });
  page.on("requestfailed", (request) => {
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
  await context.addInitScript(() => {
    const install = () => {
      if (document.getElementById("scry-visual-redaction-style")) return;
      const style = document.createElement("style");
      style.id = "scry-visual-redaction-style";
      style.textContent = `
        [data-scry-redacted="true"] {
          color: transparent !important;
          -webkit-text-fill-color: transparent !important;
          background: #000 !important;
          border-color: #000 !important;
          caret-color: transparent !important;
          text-shadow: none !important;
        }
        #scry-sensitive-overlay {
          position: fixed !important;
          inset: 0 !important;
          z-index: 2147483647 !important;
          display: grid !important;
          place-items: center !important;
          color: #fff !important;
          background: #000 !important;
          font: 600 16px/1.4 system-ui, sans-serif !important;
          pointer-events: none !important;
        }
      `;
      document.documentElement.appendChild(style);
      try {
        if (sessionStorage.getItem("scry-sensitive-overlay") === "1" && !document.getElementById("scry-sensitive-overlay")) {
          const overlay = document.createElement("div");
          overlay.id = "scry-sensitive-overlay";
          overlay.setAttribute("role", "presentation");
          overlay.setAttribute("aria-hidden", "true");
          overlay.textContent = "Protected information hidden by Scry";
          Object.assign(overlay.style, {
            position: "fixed",
            inset: "0",
            zIndex: "2147483647",
            display: "grid",
            placeItems: "center",
            color: "#fff",
            background: "#000",
            font: "600 16px/1.4 system-ui, sans-serif",
            pointerEvents: "none",
          });
          document.documentElement.appendChild(overlay);
        }
      } catch {
        // Sandboxed documents may deny storage; the current-page overlay still applies.
      }
    };
    install();
    document.addEventListener("DOMContentLoaded", install, { once: true });
  });
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

async function showSensitiveOverlay(page: Page) {
  await page.evaluate(() => {
    try { sessionStorage.setItem("scry-sensitive-overlay", "1"); } catch { /* no-op */ }
    if (document.getElementById("scry-sensitive-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "scry-sensitive-overlay";
    overlay.setAttribute("role", "presentation");
    overlay.setAttribute("aria-hidden", "true");
    overlay.textContent = "Protected information hidden by Scry";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "grid",
      placeItems: "center",
      color: "#fff",
      background: "#000",
      font: "600 16px/1.4 system-ui, sans-serif",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(overlay);
  });
}

async function hideSensitiveOverlay(page: Page) {
  await page.evaluate(() => {
    try { sessionStorage.removeItem("scry-sensitive-overlay"); } catch { /* no-op */ }
    document.getElementById("scry-sensitive-overlay")?.remove();
  });
}

class ReadinessTimeoutError extends Error {
  constructor(readonly stepId: string, message: string) {
    super(`Readiness timed out for step "${stepId}": ${message}`);
    this.name = "ReadinessTimeoutError";
  }
}

async function executeReadiness(
  page: Page,
  readiness: Readiness,
  baseOrigin: string,
  networkRecords: Array<Record<string, unknown>>,
  activeRequests: Map<string, { url: string; resourceType: string }>,
) {
  const startedAt = Date.now();
  const execute = (condition: ReadinessCondition) => executeReadinessCondition(
    page, condition, baseOrigin, readiness.timeoutMs, startedAt, networkRecords, activeRequests,
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
  networkRecords: Array<Record<string, unknown>>,
  activeRequests: Map<string, { url: string; resourceType: string }>,
) {
  const remaining = () => Math.max(100, timeoutMs - (Date.now() - startedAt));
  switch (condition.type) {
    case "visible":
    case "hidden":
      await (await resolveUniqueLocator(page, condition.target)).waitFor({ state: condition.type, timeout: remaining() });
      return;
    case "text":
      await expectEventually(async () => {
        const locator = await resolveUniqueLocator(page, condition.target);
        if (await locator.count() === 0 || !(await locator.first().isVisible())) return false;
        const actual = ((await locator.first().textContent()) ?? "").trim();
        return condition.exact ? actual === condition.expected : actual.includes(condition.expected);
      }, remaining());
      return;
    case "value":
      await expectEventually(async () => (await (await resolveUniqueLocator(page, condition.target)).inputValue()) === condition.expected, remaining());
      return;
    case "checked":
      await expectEventually(async () => (await (await resolveUniqueLocator(page, condition.target)).isChecked()) === condition.expected, remaining());
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
        const locator = await resolveUniqueLocator(page, condition.target);
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
        && new Date(String(record.occurredAt)).getTime() >= startedAt
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
  await page.evaluate(({ quietWindowMs, timeoutMs }) => new Promise<void>((resolve, reject) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    let observer: MutationObserver | undefined;
    const timeout = setTimeout(() => {
      observer?.disconnect();
      reject(new Error("DOM did not become quiet"));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timeout);
      observer?.disconnect();
      resolve();
    };
    const reset = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietWindowMs);
    };
    observer = new MutationObserver(reset);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    reset();
  }), { quietWindowMs, timeoutMs });
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function optionalTimeout(timeoutMs: number | undefined): { timeout?: number } {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

async function stopBrowser(context: BrowserContext | undefined, browser: Browser | undefined) {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}
