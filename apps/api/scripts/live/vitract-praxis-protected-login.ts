import {
  executionPolicySchema,
  type ExecutionPolicy,
  type InteractionTargetIntent,
  type PraxisResult,
} from "@scry/contracts";
import {
  executePraxisConsumer,
  observeSemanticPageContext,
  registerPraxisVeilAuthority,
} from "@scry/praxis";
import { compileVeilPolicy, VeilAuthority } from "@scry/veil";
import type { Browser, BrowserContext, Page } from "playwright";

import { AdaptiveSessionRepository } from "../../src/adaptive-sessions/adaptive-session.repository.js";
import { Database } from "../../src/infrastructure/database.js";
import { NativeBrowserDriver } from "../../src/runtime/native-browser-driver/native-browser-driver.js";

const LOGIN_URL = "https://preview.vitract.com/login";

const ENVIRONMENT_ID =
  process.env.SCRY_LIVE_ENVIRONMENT_ID ??
  "faca3dad-9ff7-4633-b058-1239d0aefb65";

const CREDENTIAL_RESOLUTION_SESSION_ID =
  process.env.SCRY_LIVE_CREDENTIAL_SESSION_ID ??
  "0197cbc4-9560-43f7-8c47-3f69a11de8d2";

const EMAIL_REFERENCE =
  process.env.SCRY_LIVE_EMAIL_REFERENCE ??
  "950c756d-c595-4f09-9f05-d64ceeab5cf9";

const PASSWORD_REFERENCE =
  process.env.SCRY_LIVE_PASSWORD_REFERENCE ??
  "ecc3f126-9a68-4994-9869-dc63a987786c";

const TIMEOUT_MS = 20_000;

type SafePraxisResult = {
  stage: string;
  status: PraxisResult["status"];
  code: string;
  mutationOutcome: string;
  localVerification: string;
  effectVerification: string;
  durationMs: number;
};

type Output = {
  layer: "A_DIRECT_PRAXIS";
  controlPlaneAdmissionUsed: false;
  missionFlowUsed: false;
  runUsed: false;
  mcpUsed: false;

  failureStage: string;
  failureCode: string;

  browserLaunchAttempted: boolean;
  navigationSucceeded: boolean;

  initialControlCount: number;
  authenticatedControlCount: number;

  readinessAttempts: Array<{
    elapsedMs: number;
    readyState: string;
    rawCandidateCount: number;
    visibleCandidateCount: number;
    semanticControlCount: number;
  }>;

  resolverCalls: string[];
  mutationBoundaryEntries: string[];

  praxisResults: SafePraxisResult[];

  finalOrigin: string;
  finalPath: string;
  leftLoginPage: boolean;

  elapsedMs: number;
  result:
    | "LIVE_DIRECT_PRAXIS_PROTECTED_LOGIN_PASS"
    | "LIVE_DIRECT_PRAXIS_PROTECTED_LOGIN_FAIL";
};

const output: Output = {
  layer: "A_DIRECT_PRAXIS",
  controlPlaneAdmissionUsed: false,
  missionFlowUsed: false,
  runUsed: false,
  mcpUsed: false,

  failureStage: "BOOTSTRAP",
  failureCode: "none",

  browserLaunchAttempted: false,
  navigationSucceeded: false,

  initialControlCount: 0,
  authenticatedControlCount: 0,

  readinessAttempts: [],

  resolverCalls: [],
  mutationBoundaryEntries: [],

  praxisResults: [],

  finalOrigin: "unavailable",
  finalPath: "unavailable",
  leftLoginPage: false,

  elapsedMs: 0,
  result: "LIVE_DIRECT_PRAXIS_PROTECTED_LOGIN_FAIL",
};

const database = new Database();
const sessions = new AdaptiveSessionRepository(database);
const driver = new NativeBrowserDriver();

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let unregisterVeil: (() => void) | undefined;
let ordinal = 0;

const startedAt = performance.now();

try {
  output.failureStage = "ENVIRONMENT_POLICY";

  const policy = await loadEnvironmentPolicy(database);

  output.failureStage = "BROWSER_LAUNCH";
  output.browserLaunchAttempted = true;

  const opened = await driver.openBrowser();
  ({ browser, context, page } = opened);

  output.failureStage = "NAVIGATE_LOGIN";

  await driver.navigateAndWait(
    page,
    LOGIN_URL,
    policy.allowedOrigins,
    30_000,
    policy.trustedScriptOrigins ?? [],
  );

  output.navigationSucceeded = true;

  unregisterVeil = registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(
      compileVeilPolicy({
        profile: "balanced",
        allowedOrigins: policy.allowedOrigins,
      }),
    ),
    userId: "r07-direct-praxis-live-qualification",
    environmentId: ENVIRONMENT_ID,
    browserContextId: "r07-direct-praxis-live-browser",
  });

  output.failureStage = "OBSERVE_LOGIN";

  const readinessStartedAt = performance.now();
  let loginObservation = await observeSemanticPageContext(page);

  while (true) {
    const raw = await page.evaluate(() => {
      const selector = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "textarea",
        "select",
        "[role=button]",
        "[role=link]",
        "[role=tab]",
        "[role=menuitem]",
        "[role=checkbox]",
        "[role=radio]",
        "[role=combobox]",
      ].join(",");

      const candidates = Array.from(document.querySelectorAll(selector));

      const visible = candidates.filter((element) => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const rect = html.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          !element.closest('[aria-hidden="true"],[inert]')
        );
      });

      return {
        readyState: document.readyState,
        rawCandidateCount: candidates.length,
        visibleCandidateCount: visible.length,
      };
    });

    const elapsedMs = Math.round(
      performance.now() - readinessStartedAt,
    );

    output.readinessAttempts.push({
      elapsedMs,
      readyState: raw.readyState,
      rawCandidateCount: raw.rawCandidateCount,
      visibleCandidateCount: raw.visibleCandidateCount,
      semanticControlCount: loginObservation.controls.length,
    });

    if (loginObservation.controls.length >= 3)
      break;

    if (elapsedMs >= 15_000)
      throw coded("LIVE_PRAXIS_LOGIN_CONTROLS_INCOMPLETE");

    await page.waitForTimeout(250);
    loginObservation = await observeSemanticPageContext(page);
  }

  output.initialControlCount = loginObservation.controls.length;

  // Layer A must exercise the same agent-first target contract used by
  // production: choose from the bounded observation, then dispatch the exact
  // opaque context reference. Do not semantically re-resolve at dispatch time.
  const emailControls = loginObservation.controls.filter(
    (control) =>
      control.role === "textbox" &&
      /email/i.test(control.name) &&
      control.inputSources?.includes("protected_reference"),
  );

  const passwordControls = loginObservation.controls.filter(
    (control) =>
      control.role === "textbox" &&
      control.semanticPurpose === "password" &&
      control.inputSources?.includes("protected_reference"),
  );

  const loginControls = loginObservation.controls.filter(
    (control) =>
      control.role === "button" &&
      control.name.trim().toLowerCase() === "login",
  );

  const safeObservedControls = loginObservation.controls.map((control) => ({
    reference: control.reference,
    role: control.role,
    name: control.name,
    semanticPurpose: control.semanticPurpose ?? null,
    capabilities: [...control.capabilities],
    inputSources: control.inputSources ? [...control.inputSources] : [],
    disabled: Boolean(control.disabled),
    current: Boolean(control.current),
  }));

  process.stdout.write(
    [
      `safeObservedControls: ${JSON.stringify(safeObservedControls)}`,
      `emailCandidateCount: ${emailControls.length}`,
      `passwordCandidateCount: ${passwordControls.length}`,
      `loginCandidateCount: ${loginControls.length}`,
      `loginCandidates: ${JSON.stringify(
        loginControls.map((control) => ({
          reference: control.reference,
          role: control.role,
          name: control.name,
          capabilities: [...control.capabilities],
          disabled: Boolean(control.disabled),
          current: Boolean(control.current),
        })),
      )}`,
      "",
    ].join("\n"),
  );

  if (emailControls.length !== 1)
    throw coded("LIVE_PRAXIS_EMAIL_REFERENCE_NOT_UNIQUE");

  if (passwordControls.length !== 1)
    throw coded("LIVE_PRAXIS_PASSWORD_REFERENCE_NOT_UNIQUE");

  if (loginControls.length !== 1)
    throw coded("LIVE_PRAXIS_LOGIN_REFERENCE_NOT_UNIQUE");

  const emailReference = emailControls[0]!.reference;
  const passwordReference = passwordControls[0]!.reference;
  const loginReference = loginControls[0]!.reference;

  const resolveKnownSecret = async (
    reference: string,
    classification: "public" | "known_secret" | "captured_secret" | "captured_public",
  ) => {
    if (classification !== "known_secret")
      throw coded("LIVE_PRAXIS_UNEXPECTED_INPUT_CLASSIFICATION");

    let label: string;

    if (reference === EMAIL_REFERENCE) label = "login_email";
    else if (reference === PASSWORD_REFERENCE) label = "login_password";
    else throw coded("LIVE_PRAXIS_UNEXPECTED_PROTECTED_REFERENCE");

    output.resolverCalls.push(label);

    // Plaintext is returned directly into Praxis' input resolver call.
    // It is never written to stdout, evidence, the report, or this output structure.
    return sessions.resolveCredential(
      CREDENTIAL_RESOLUTION_SESSION_ID,
      reference,
    );
  };

  output.failureStage = "PROTECTED_EMAIL_FILL";

  await requireSuccess(
    "protected_email_fill",
    await executePraxisConsumer({
      page,
      intent: {
        ...textboxTarget("login email", "Enter your email"),
        authoritativeReference: emailReference,
        matching: "exact",
      },
      operation: {
        type: "enter_text",
        input: {
          reference: EMAIL_REFERENCE,
          classification: "known_secret",
        },
      },
      expectedEffect: { type: "none" },
      context: praxisContext(
        "protected",
        policy,
        "protected_email_fill",
      ),
      signal: new AbortController().signal,
      resolveInput: resolveKnownSecret,
    }),
  );

  output.failureStage = "PROTECTED_PASSWORD_FILL";

  await requireSuccess(
    "protected_password_fill",
    await executePraxisConsumer({
      page,
      intent: {
        ...textboxTarget("login password", "Enter your password"),
        authoritativeReference: passwordReference,
        matching: "exact",
      },
      operation: {
        type: "enter_text",
        input: {
          reference: PASSWORD_REFERENCE,
          classification: "known_secret",
        },
      },
      expectedEffect: { type: "none" },
      context: praxisContext(
        "protected",
        policy,
        "protected_password_fill",
      ),
      signal: new AbortController().signal,
      resolveInput: resolveKnownSecret,
    }),
  );

  output.failureStage = "LOGIN_ACTIVATE";

  await requireSuccess(
    "login_activate",
    await executePraxisConsumer({
      page,
      intent: {
        ...buttonTarget("login", "Login"),
        authoritativeReference: loginReference,
        matching: "exact",
      },
      operation: { type: "activate" },
      expectedEffect: { type: "none" },
      context: praxisContext(
        "action",
        policy,
        "login_activate",
      ),
      signal: new AbortController().signal,
    }),
  );

  output.failureStage = "AUTHENTICATED_READINESS";

  await page.waitForURL(
    (url) =>
      policy.allowedOrigins.includes(url.origin) &&
      url.pathname !== "/login" &&
      !url.pathname.endsWith("/login"),
    { timeout: 30_000 },
  );

  recordSafeLocation(page);

  output.leftLoginPage =
    output.finalOrigin === new URL(LOGIN_URL).origin &&
    output.finalPath !== "/login" &&
    !output.finalPath.endsWith("/login");

  if (!output.leftLoginPage)
    throw coded("LIVE_PRAXIS_AUTHENTICATED_NAVIGATION_NOT_PROVEN");

  output.failureStage = "AUTHENTICATED_OBSERVATION";

  const authenticatedObservation =
    await observeSemanticPageContext(page);

  output.authenticatedControlCount =
    authenticatedObservation.controls.length;

  // Positive post-login proof is intentionally mechanical:
  // same approved Vitract origin + no longer on /login + observation succeeds.
  if (output.authenticatedControlCount === 0)
    throw coded("LIVE_PRAXIS_AUTHENTICATED_OBSERVATION_EMPTY");

  output.failureStage = "none";
  output.failureCode = "none";
  output.result = "LIVE_DIRECT_PRAXIS_PROTECTED_LOGIN_PASS";
} catch (error) {
  output.failureCode = safeCode(error);
  if (page) recordSafeLocation(page);
} finally {
  output.elapsedMs = Math.round(performance.now() - startedAt);

  unregisterVeil?.();

  if (browser && context)
    await driver.closeBrowser(browser, context).catch(() => undefined);

  await database.onModuleDestroy();

  printOutput(output);

  process.exitCode =
    output.result === "LIVE_DIRECT_PRAXIS_PROTECTED_LOGIN_PASS"
      ? 0
      : 1;
}

function praxisContext(
  channel: "action" | "protected",
  policy: ExecutionPolicy,
  stage: string,
  dispatchSemantics: "read_only" | "mutation" = "mutation",
) {
  return {
    channel,
    ordinal: ++ordinal,
    allowedOrigins: policy.allowedOrigins,
    timeoutMs: TIMEOUT_MS,
    dispatchSemantics,
    privacy: {
      state: "protected",
      allowedChannels: ["public_dom", "accessibility"],
      suppressedChannels: ["visual", "ocr"],
    },
    beforeMutation: async () => {
      output.mutationBoundaryEntries.push(stage);
    },
  };
}

async function requireSuccess(
  stage: string,
  result: PraxisResult,
) {
  const verification =
    result.status === "succeeded"
      ? result.verification
      : result.report.verification;

  output.praxisResults.push({
    stage,
    status: result.status,
    code: result.status === "succeeded" ? "none" : result.code,
    mutationOutcome: result.mutationOutcome,
    localVerification: verification.local,
    effectVerification: verification.effect,
    durationMs: Math.round(result.timing.totalMs),
  });

  if (result.status !== "succeeded")
    throw coded(result.code);

  if (
    result.verification.local !== "passed" &&
    result.verification.local !== "not_required"
  )
    throw coded("LIVE_PRAXIS_LOCAL_VERIFICATION_NOT_PROVEN");
}

function textboxTarget(
  concept: string,
  placeholder: string,
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: [
      "focusable",
      "accepts_text",
      "editable",
    ],
    preferredEvidence: {
      roles: ["textbox"],
      names: [],
      labels: [],
      descriptions: [],
      placeholders: [placeholder],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "authentication",
    confidence: { requiredFamilies: [] },
  };
}

function buttonTarget(
  concept: string,
  name: string,
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: [
      "focusable",
      "pointer_activatable",
    ],
    preferredEvidence: {
      roles: ["button"],
      names: [name],
      labels: [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "authentication",
    confidence: { requiredFamilies: [] },
  };
}

async function loadEnvironmentPolicy(
  repository: Database,
): Promise<ExecutionPolicy> {
  const result = await repository.query<{
    policy: unknown;
    baseOrigin: string;
    secretRefs: string[];
  }>(
    `SELECT
       environment.policy,
       environment.base_origin AS "baseOrigin",
       environment.secret_refs AS "secretRefs"
     FROM environments environment
     WHERE environment.id=$1`,
    [ENVIRONMENT_ID],
  );

  if (result.rowCount !== 1)
    throw coded("LIVE_PRAXIS_ENVIRONMENT_UNAVAILABLE");

  const row = result.rows[0]!;
  const policy = executionPolicySchema.parse(row.policy);

  if (
    new URL(row.baseOrigin).origin !== new URL(LOGIN_URL).origin ||
    !policy.allowedOrigins.includes(new URL(LOGIN_URL).origin)
  )
    throw coded("LIVE_PRAXIS_ENVIRONMENT_ORIGIN_INVALID");

  const refs = new Set(row.secretRefs);

  if (
    !refs.has(EMAIL_REFERENCE) ||
    !refs.has(PASSWORD_REFERENCE)
  )
    throw coded("LIVE_PRAXIS_ENVIRONMENT_CREDENTIALS_UNAUTHORIZED");

  return policy;
}

function recordSafeLocation(activePage: Page) {
  try {
    const url = new URL(activePage.url());
    output.finalOrigin = url.origin;
    output.finalPath = url.pathname;
  } catch {
    output.finalOrigin = "unavailable";
    output.finalPath = "unavailable";
  }
}

function coded(code: string) {
  return Object.assign(new Error(code), { code });
}

function safeCode(error: unknown) {
  const candidate =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : error instanceof Error
        ? error.message
        : String(error);

  return /^[A-Z][A-Z0-9_]*$/.test(candidate)
    ? candidate
    : "LIVE_DIRECT_PRAXIS_UNCLASSIFIED_FAILURE";
}

function printOutput(value: Output) {
  process.stdout.write([
    "============================================================",
    "R0.7 LAYER A — DIRECT PRAXIS RESULT",
    "============================================================",
    `layer: ${value.layer}`,
    `controlPlaneAdmissionUsed: ${value.controlPlaneAdmissionUsed}`,
    `missionFlowUsed: ${value.missionFlowUsed}`,
    `runUsed: ${value.runUsed}`,
    `mcpUsed: ${value.mcpUsed}`,
    `failureStage: ${value.failureStage}`,
    `failureCode: ${value.failureCode}`,
    `browserLaunchAttempted: ${value.browserLaunchAttempted}`,
    `navigationSucceeded: ${value.navigationSucceeded}`,
    `initialControlCount: ${value.initialControlCount}`,
    `authenticatedControlCount: ${value.authenticatedControlCount}`,
    `readinessAttempts: ${JSON.stringify(value.readinessAttempts)}`,
    `resolverCalls: ${JSON.stringify(value.resolverCalls)}`,
    `mutationBoundaryEntries: ${JSON.stringify(value.mutationBoundaryEntries)}`,
    `praxisResults: ${JSON.stringify(value.praxisResults)}`,
    `finalOrigin: ${value.finalOrigin}`,
    `finalPath: ${value.finalPath}`,
    `leftLoginPage: ${value.leftLoginPage}`,
    `elapsedMs: ${value.elapsedMs}`,
    `result: ${value.result}`,
    "",
  ].join("\n"));
}
