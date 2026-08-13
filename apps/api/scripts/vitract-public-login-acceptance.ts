import {
  executionPolicySchema,
  type ExecutionPolicy,
  type InteractionTargetIntent,
} from "@scry/contracts";
import { executeInteractionCompatibility } from "@scry/executor";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";
import type { Browser, BrowserContext, Page } from "playwright";

import { Database } from "../src/infrastructure/database.js";
import { NativeBrowserDriver } from "../src/runtime/native-browser-driver/native-browser-driver.js";

const LOGIN_URL = "https://preview.vitract.com/login";
const VITRACT_TEST_ENVIRONMENT_ID = "9a581bb0-2276-4888-9ddb-07b2485cddc3";
const SYNTHETIC_VALUE = "scry-live-acceptance@example.invalid";
const ACTION_TIMEOUT_MS = 10_000;
const emailTarget: InteractionTargetIntent = {
  concept: "login email",
  requiredCapabilities: ["focusable", "accepts_text", "editable"],
  preferredEvidence: {
    roles: ["textbox"], names: [], labels: [], descriptions: [],
    placeholders: ["Enter your email"], inputTypes: [],
  },
  scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
  risk: "authentication", confidence: { requiredFamilies: [] },
};

type AcceptanceOutput = {
  failureStage:
    | "none"
    | "ENVIRONMENT_POLICY_LOAD"
    | "ACTION_POLICY_DERIVATION"
    | "BROWSER_LAUNCH"
    | "NAVIGATION"
    | "ACTION_EXECUTION";
  browserLaunchAttempted: boolean;
  navigationSucceeded: boolean;
  finalOrigin: string;
  finalPath: string;
  actionTimeoutMs: number;
  nativeProbeBudgetMs: number;
  nativeAttempted: boolean;
  nativeSucceeded: boolean;
  nativeFailureCode: string;
  praxisInvocationCount: number;
  praxisResultSequence: string[];
  actionElapsedMs: number;
  fillDispatched: boolean;
  dispatchCount: number;
  loginClickCount: number;
  formSubmitObserved: boolean;
  finalInputValueMatchesSyntheticAcceptanceValue: "yes" | "no";
  dispatchAfterDeadlineObserved: "yes" | "no";
  result: "LIVE_LOGIN_ACCEPTANCE_PASS" | "LIVE_LOGIN_ACCEPTANCE_FAIL";
};

const output: AcceptanceOutput = {
  failureStage: "none",
  browserLaunchAttempted: false,
  navigationSucceeded: false,
  finalOrigin: "unavailable",
  finalPath: "unavailable",
  actionTimeoutMs: ACTION_TIMEOUT_MS,
  nativeProbeBudgetMs: 0,
  nativeAttempted: false,
  nativeSucceeded: false,
  nativeFailureCode: "none",
  praxisInvocationCount: 0,
  praxisResultSequence: [],
  actionElapsedMs: 0,
  fillDispatched: false,
  dispatchCount: 0,
  loginClickCount: 0,
  formSubmitObserved: false,
  finalInputValueMatchesSyntheticAcceptanceValue: "no",
  dispatchAfterDeadlineObserved: "no",
  result: "LIVE_LOGIN_ACCEPTANCE_FAIL",
};

const driver = new NativeBrowserDriver();
const database = new Database();
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let unregisterPraxis: (() => void) | undefined;
let activeStage: Exclude<AcceptanceOutput["failureStage"], "none"> =
  "ENVIRONMENT_POLICY_LOAD";

try {
  const environmentPolicy = await loadAuthoritativeEnvironmentPolicy(database, LOGIN_URL);
  activeStage = "ACTION_POLICY_DERIVATION";
  const actionPolicy = executionPolicySchema.parse({
    ...environmentPolicy,
    maxActions: 1,
    maxDurationMs: Math.min(environmentPolicy.maxDurationMs, 15_000),
    maxNavigations: 1,
  });
  activeStage = "BROWSER_LAUNCH";
  output.browserLaunchAttempted = true;
  const opened = await driver.openBrowser();
  ({ browser, context, page } = opened);

  await page.addInitScript(() => {
    const acceptance = { loginClickCount: 0, formSubmitCount: 0 };
    Object.defineProperty(window, "__scryPublicLoginAcceptance", {
      value: acceptance,
      configurable: false,
      enumerable: false,
      writable: false,
    });
    document.addEventListener("click", (event) => {
      const element = event.target instanceof Element
        ? event.target.closest('button, input[type="button"], input[type="submit"]')
        : null;
      const label = element instanceof HTMLInputElement
        ? element.value
        : element?.textContent ?? "";
      if (/^\s*(?:log\s*in|login|sign\s*in)\s*$/i.test(label))
        acceptance.loginClickCount += 1;
    }, true);
    document.addEventListener("submit", () => {
      acceptance.formSubmitCount += 1;
    }, true);
  });

  activeStage = "NAVIGATION";
  await driver.navigateAndWait(
    page,
    LOGIN_URL,
    environmentPolicy.allowedOrigins,
    30_000,
    environmentPolicy.trustedScriptOrigins ?? [],
  );
  output.navigationSucceeded = true;
  recordSafeLocation(page, output);

  unregisterPraxis = registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(compileVeilPolicy({
      profile: "balanced",
      allowedOrigins: environmentPolicy.allowedOrigins,
    })),
    userId: "public-login-acceptance",
    environmentId: "manual-live-acceptance",
    browserContextId: "fresh-public-login-context",
  });

  activeStage = "ACTION_EXECUTION";
  const actionStartedAt = performance.now();
  const actionDeadlineAt = actionStartedAt + ACTION_TIMEOUT_MS;
  const dispatchTimes: number[] = [];
  const outcome = await executeInteractionCompatibility({
    sessionId: "vitract-public-login-single-acceptance",
    operationId: "fill-public-login-email",
    ordinal: 1,
    page,
    action: {
      type: "fill",
      value: SYNTHETIC_VALUE,
      timeoutMs: ACTION_TIMEOUT_MS,
      target: emailTarget,
    },
    policy: actionPolicy,
    options: {
      outputDirectory: "/tmp/scry-vitract-public-login-acceptance",
      executeNativeControl: async (activePage, target, operation, beforeDispatch) => {
        output.nativeAttempted = true;
        if ("resolutionTimeoutMs" in operation)
          output.nativeProbeBudgetMs = operation.resolutionTimeoutMs ?? 0;
        try {
          await driver.executeSemanticControl(activePage, target, operation, beforeDispatch);
          output.nativeSucceeded = true;
        } catch (error) {
          output.nativeFailureCode = safeCode(error);
          throw error;
        }
      },
      onPraxisResult: async (result) => {
        output.praxisInvocationCount += 1;
        output.praxisResultSequence.push(
          result.status === "succeeded" ? "PRAXIS_SUCCEEDED" : result.code,
        );
      },
      onMutationDispatch: async () => {
        dispatchTimes.push(performance.now());
      },
    },
  });
  output.actionElapsedMs = Math.round(performance.now() - actionStartedAt);
  output.dispatchCount = dispatchTimes.length;
  output.fillDispatched = outcome.functionalResult === "succeeded" && output.dispatchCount === 1;
  output.dispatchAfterDeadlineObserved = dispatchTimes.some((at) => at > actionDeadlineAt)
    ? "yes"
    : "no";

  const counters = await page.evaluate(() => {
    const acceptance = (window as Window & {
      __scryPublicLoginAcceptance?: { loginClickCount: number; formSubmitCount: number };
    }).__scryPublicLoginAcceptance;
    return {
      loginClickCount: acceptance?.loginClickCount ?? 0,
      formSubmitCount: acceptance?.formSubmitCount ?? 0,
    };
  });
  output.loginClickCount = counters.loginClickCount;
  output.formSubmitObserved = counters.formSubmitCount > 0;
  output.finalInputValueMatchesSyntheticAcceptanceValue =
    (await page.getByPlaceholder("Enter your email", { exact: true }).inputValue()) === SYNTHETIC_VALUE
      ? "yes"
      : "no";
  recordSafeLocation(page, output);

  output.failureStage = "ACTION_EXECUTION";
  if (
    output.navigationSucceeded &&
    outcome.functionalResult === "succeeded" &&
    output.actionElapsedMs <= ACTION_TIMEOUT_MS &&
    output.dispatchCount === 1 &&
    output.loginClickCount === 0 &&
    !output.formSubmitObserved &&
    output.finalInputValueMatchesSyntheticAcceptanceValue === "yes" &&
    output.dispatchAfterDeadlineObserved === "no"
  ) {
    output.result = "LIVE_LOGIN_ACCEPTANCE_PASS";
    output.failureStage = "none";
  }
} catch (error) {
  output.failureStage = activeStage;
  if (output.nativeAttempted && output.nativeFailureCode === "none")
    output.nativeFailureCode = safeCode(error);
  if (page) recordSafeLocation(page, output);
} finally {
  unregisterPraxis?.();
  if (browser && context) await driver.closeBrowser(browser, context);
  await database.onModuleDestroy();
  printOutput(output);
}

function recordSafeLocation(activePage: Page, target: AcceptanceOutput) {
  try {
    const location = new URL(activePage.url());
    target.finalOrigin = location.origin;
    target.finalPath = location.pathname;
  } catch {
    target.finalOrigin = "unavailable";
    target.finalPath = "unavailable";
  }
}

function safeCode(error: unknown) {
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]+$/.test(candidate) ? candidate : "LIVE_LOGIN_ACCEPTANCE_ERROR";
}

async function loadAuthoritativeEnvironmentPolicy(
  repository: Database,
  targetUrl: string,
): Promise<ExecutionPolicy> {
  const targetOrigin = new URL(targetUrl).origin;
  const result = await repository.query<{ policy: unknown; baseOrigin: string }>(
    `SELECT environment.policy,environment.base_origin AS "baseOrigin"
       FROM environments environment
      WHERE environment.id=$1`,
    [VITRACT_TEST_ENVIRONMENT_ID],
  );
  if (result.rowCount !== 1) throw new Error("LIVE_LOGIN_ENVIRONMENT_POLICY_UNAVAILABLE");
  const policy = executionPolicySchema.parse(result.rows[0]!.policy);
  if (
    new URL(result.rows[0]!.baseOrigin).origin !== targetOrigin ||
    !policy.allowedOrigins.includes(targetOrigin)
  ) throw new Error("LIVE_LOGIN_ENVIRONMENT_POLICY_INVALID");
  return policy;
}

function printOutput(value: AcceptanceOutput) {
  process.stdout.write([
    `failureStage: ${value.failureStage}`,
    `browserLaunchAttempted: ${value.browserLaunchAttempted}`,
    `navigationSucceeded: ${value.navigationSucceeded}`,
    `finalOrigin: ${value.finalOrigin}`,
    `finalPath: ${value.finalPath}`,
    `actionTimeoutMs: ${value.actionTimeoutMs}`,
    `nativeProbeBudgetMs: ${value.nativeProbeBudgetMs}`,
    `nativeAttempted: ${value.nativeAttempted}`,
    `nativeSucceeded: ${value.nativeSucceeded}`,
    `nativeFailureCode: ${value.nativeFailureCode}`,
    `praxisInvocationCount: ${value.praxisInvocationCount}`,
    `praxisResultSequence: ${JSON.stringify(value.praxisResultSequence)}`,
    `actionElapsedMs: ${value.actionElapsedMs}`,
    `fillDispatched: ${value.fillDispatched}`,
    `dispatchCount: ${value.dispatchCount}`,
    `loginClickCount: ${value.loginClickCount}`,
    `formSubmitObserved: ${value.formSubmitObserved}`,
    `finalInputValueMatchesSyntheticAcceptanceValue: ${value.finalInputValueMatchesSyntheticAcceptanceValue}`,
    `dispatchAfterDeadlineObserved: ${value.dispatchAfterDeadlineObserved}`,
    `result: ${value.result}`,
  ].join("\n") + "\n");
}
