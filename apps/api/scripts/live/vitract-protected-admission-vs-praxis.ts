import {
  executionPolicySchema,
  missionAuthoringIntentSchema,
  type ExecutionPolicy,
  type InteractionTargetIntent,
  type MissionAuthoringIntent,
  type PraxisResult,
} from "@scry/contracts";

import {
  executePraxisConsumer,
  observeSemanticPageContext,
  registerPraxisVeilAuthority,
} from "@scry/praxis";

import {
  compileVeilPolicy,
  VeilAuthority,
} from "@scry/veil";

import type {
  Browser,
  BrowserContext,
  Page,
} from "playwright";

import { AdaptiveSessionRepository } from "../../src/adaptive-sessions/adaptive-session.repository.js";
import { Database } from "../../src/infrastructure/database.js";
import { NativeBrowserDriver } from "../../src/runtime/native-browser-driver/native-browser-driver.js";

const LOGIN_URL = "https://preview.vitract.com/login";

const SESSION_ID =
  process.env.SCRY_LIVE_SESSION_ID ??
  "0197cbc4-9560-43f7-8c47-3f69a11de8d2";

const ENVIRONMENT_ID =
  process.env.SCRY_LIVE_ENVIRONMENT_ID ??
  "faca3dad-9ff7-4633-b058-1239d0aefb65";

const EMAIL_REFERENCE =
  process.env.SCRY_LIVE_EMAIL_REFERENCE ??
  "950c756d-c595-4f09-9f05-d64ceeab5cf9";

const PASSWORD_REFERENCE =
  process.env.SCRY_LIVE_PASSWORD_REFERENCE ??
  "ecc3f126-9a68-4994-9869-dc63a987786c";

const TIMEOUT_MS = 20_000;

type AdmissionResult = {
  credential: "email" | "password";
  admitted: boolean;
  code: string;
};

type DirectPraxisResult = {
  credential: "email" | "password";
  status: PraxisResult["status"];
  code: string;
  mutationOutcome: string;
  localVerification: string;
  durationMs: number;
};

type Output = {
  layer: "B_ADMISSION_VS_PRAXIS";

  missionProgressionUsed: false;
  flowProgressionUsed: false;
  runUsed: false;
  mcpUsed: false;

  failureStage: string;
  failureCode: string;

  sessionProtectedAllowlist: string[];

  emailEnvironmentAuthorized: boolean;
  passwordEnvironmentAuthorized: boolean;

  emailReferenceObserved: boolean;
  passwordReferenceObserved: boolean;

  admissionResults: AdmissionResult[];
  praxisResults: DirectPraxisResult[];

  resolverCalls: string[];

  contradictionProven: boolean;

  finalOrigin: string;
  finalPath: string;

  elapsedMs: number;

  result:
    | "LIVE_PROTECTED_ADMISSION_CONTRADICTION_PROVEN"
    | "LIVE_PROTECTED_ADMISSION_CONTRADICTION_NOT_PROVEN";
};

const output: Output = {
  layer: "B_ADMISSION_VS_PRAXIS",

  missionProgressionUsed: false,
  flowProgressionUsed: false,
  runUsed: false,
  mcpUsed: false,

  failureStage: "BOOTSTRAP",
  failureCode: "none",

  sessionProtectedAllowlist: [],

  emailEnvironmentAuthorized: false,
  passwordEnvironmentAuthorized: false,

  emailReferenceObserved: false,
  passwordReferenceObserved: false,

  admissionResults: [],
  praxisResults: [],

  resolverCalls: [],

  contradictionProven: false,

  finalOrigin: "unavailable",
  finalPath: "unavailable",

  elapsedMs: 0,

  result: "LIVE_PROTECTED_ADMISSION_CONTRADICTION_NOT_PROVEN",
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
  output.failureStage = "LOAD_SESSION";

  const fixture = await database.query<{
    projectId: string;
    environmentId: string;
    objectiveId: string;
    flowDraftId: string;
    protectedAllowlist: string[];
    policy: unknown;
    secretRefs: string[];
  }>(
    `SELECT
       session.project_id AS "projectId",
       session.environment_id AS "environmentId",
       session.active_objective_id AS "objectiveId",
       session.active_flow_draft_id AS "flowDraftId",
       session.protected_reference_allowlist AS "protectedAllowlist",
       environment.policy,
       environment.secret_refs AS "secretRefs"
     FROM adaptive_sessions session
     JOIN environments environment
       ON environment.id=session.environment_id
      AND environment.project_id=session.project_id
     WHERE session.id=$1`,
    [SESSION_ID],
  );

  if (fixture.rowCount !== 1)
    throw coded("LAYER_B_SESSION_UNAVAILABLE");

  const row = fixture.rows[0]!;

  if (row.environmentId !== ENVIRONMENT_ID)
    throw coded("LAYER_B_ENVIRONMENT_MISMATCH");

  output.sessionProtectedAllowlist =
    [...row.protectedAllowlist];

  output.emailEnvironmentAuthorized =
    row.secretRefs.includes(EMAIL_REFERENCE);

  output.passwordEnvironmentAuthorized =
    row.secretRefs.includes(PASSWORD_REFERENCE);

  if (
    !output.emailEnvironmentAuthorized ||
    !output.passwordEnvironmentAuthorized
  )
    throw coded("LAYER_B_ENVIRONMENT_AUTHORIZATION_MISSING");

  if (
    row.protectedAllowlist.includes(EMAIL_REFERENCE) ||
    row.protectedAllowlist.includes(PASSWORD_REFERENCE)
  )
    throw coded("LAYER_B_SESSION_ALREADY_CONTAINS_TEST_REFERENCES");

  const policy = executionPolicySchema.parse(row.policy);

  output.failureStage = "BROWSER_LAUNCH";

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

  unregisterVeil = registerPraxisVeilAuthority(page, {
    authority: new VeilAuthority(
      compileVeilPolicy({
        profile: "balanced",
        allowedOrigins: policy.allowedOrigins,
      }),
    ),
    userId: "r07-layer-b-live-qualification",
    environmentId: ENVIRONMENT_ID,
    browserContextId: "r07-layer-b-browser",
  });

  output.failureStage = "OBSERVE_LOGIN";

  const observation = await waitForLoginControls(page);

  const emailControls = observation.controls.filter(
    (control) =>
      control.role === "textbox" &&
      /email/i.test(control.name) &&
      control.inputSources?.includes("protected_reference"),
  );

  const passwordControls = observation.controls.filter(
    (control) =>
      control.role === "textbox" &&
      control.semanticPurpose === "password" &&
      control.inputSources?.includes("protected_reference"),
  );

  if (emailControls.length !== 1)
    throw coded("LAYER_B_EMAIL_REFERENCE_NOT_UNIQUE");

  if (passwordControls.length !== 1)
    throw coded("LAYER_B_PASSWORD_REFERENCE_NOT_UNIQUE");

  const emailTargetReference =
    emailControls[0]!.reference;

  const passwordTargetReference =
    passwordControls[0]!.reference;

  output.emailReferenceObserved = true;
  output.passwordReferenceObserved = true;

  const emailIntent = protectedFillIntent({
    intentId: "layer-b-email-fill",
    objectiveId: row.objectiveId,
    flowDraftId: row.flowDraftId,
    targetReference: emailTargetReference,
    concept: "login email",
    role: "textbox",
    placeholder: "Enter your email",
    credentialReference: EMAIL_REFERENCE,
  });

  const passwordIntent = protectedFillIntent({
    intentId: "layer-b-password-fill",
    objectiveId: row.objectiveId,
    flowDraftId: row.flowDraftId,
    targetReference: passwordTargetReference,
    concept: "login password",
    role: "textbox",
    credentialReference: PASSWORD_REFERENCE,
  });

  output.failureStage = "ADMISSION_EMAIL";

  output.admissionResults.push(
    await observeAdmission(
      sessions,
      "email",
      emailIntent,
    ),
  );

  output.failureStage = "ADMISSION_PASSWORD";

  output.admissionResults.push(
    await observeAdmission(
      sessions,
      "password",
      passwordIntent,
    ),
  );

  const resolveKnownSecret = async (
    reference: string,
    classification:
      | "public"
      | "known_secret"
      | "captured_secret"
      | "captured_public",
  ) => {
    if (classification !== "known_secret")
      throw coded("LAYER_B_UNEXPECTED_CLASSIFICATION");

    if (reference === EMAIL_REFERENCE)
      output.resolverCalls.push("login_email");
    else if (reference === PASSWORD_REFERENCE)
      output.resolverCalls.push("login_password");
    else
      throw coded("LAYER_B_UNEXPECTED_PROTECTED_REFERENCE");

    return sessions.resolveCredential(
      SESSION_ID,
      reference,
    );
  };

  output.failureStage = "DIRECT_PRAXIS_EMAIL";

  output.praxisResults.push(
    summarizePraxis(
      "email",
      await executePraxisConsumer({
        page,
        intent: praxisTarget({
          concept: "login email",
          placeholder: "Enter your email",
          reference: emailTargetReference,
        }),
        operation: {
          type: "enter_text",
          input: {
            reference: EMAIL_REFERENCE,
            classification: "known_secret",
          },
        },
        expectedEffect: { type: "none" },
        context: praxisContext(policy),
        signal: new AbortController().signal,
        resolveInput: resolveKnownSecret,
      }),
    ),
  );

  output.failureStage = "DIRECT_PRAXIS_PASSWORD";

  output.praxisResults.push(
    summarizePraxis(
      "password",
      await executePraxisConsumer({
        page,
        intent: praxisTarget({
          concept: "login password",
          reference: passwordTargetReference,
        }),
        operation: {
          type: "enter_text",
          input: {
            reference: PASSWORD_REFERENCE,
            classification: "known_secret",
          },
        },
        expectedEffect: { type: "none" },
        context: praxisContext(policy),
        signal: new AbortController().signal,
        resolveInput: resolveKnownSecret,
      }),
    ),
  );

  recordSafeLocation(page);

  const admissionRejectedCorrectly =
    output.admissionResults.length === 2 &&
    output.admissionResults.every(
      (result) =>
        !result.admitted &&
        result.code ===
          "MISSION_AUTHORING_PROTECTED_REFERENCE_NOT_ALLOWED",
    );

  const praxisSucceeded =
    output.praxisResults.length === 2 &&
    output.praxisResults.every(
      (result) =>
        result.status === "succeeded" &&
        result.mutationOutcome === "applied" &&
        result.localVerification === "passed",
    );

  output.contradictionProven =
    admissionRejectedCorrectly &&
    praxisSucceeded;

  if (!output.contradictionProven)
    throw coded("LAYER_B_CONTRADICTION_NOT_PROVEN");

  output.failureStage = "none";
  output.failureCode = "none";

  output.result =
    "LIVE_PROTECTED_ADMISSION_CONTRADICTION_PROVEN";
} catch (error) {
  output.failureCode = safeCode(error);

  if (page)
    recordSafeLocation(page);
} finally {
  output.elapsedMs =
    Math.round(performance.now() - startedAt);

  unregisterVeil?.();

  if (browser && context)
    await driver
      .closeBrowser(browser, context)
      .catch(() => undefined);

  await database.onModuleDestroy();

  printOutput(output);

  process.exitCode =
    output.result ===
    "LIVE_PROTECTED_ADMISSION_CONTRADICTION_PROVEN"
      ? 0
      : 1;
}

async function observeAdmission(
  repository: AdaptiveSessionRepository,
  credential: "email" | "password",
  intent: MissionAuthoringIntent,
): Promise<AdmissionResult> {
  try {
    await repository.validateIntentAdmission({
      sessionId: SESSION_ID,
      intent,
    });

    return {
      credential,
      admitted: true,
      code: "none",
    };
  } catch (error) {
    return {
      credential,
      admitted: false,
      code: nestCode(error),
    };
  }
}

function protectedFillIntent(input: {
  intentId: string;
  objectiveId: string;
  flowDraftId: string;
  targetReference: string;
  concept: string;
  role: "textbox";
  placeholder?: string;
  credentialReference: string;
}): MissionAuthoringIntent {
  return missionAuthoringIntentSchema.parse({
    intentId: input.intentId,
    objectiveId: input.objectiveId,
    flowDraftId: input.flowDraftId,

    action: {
      kind: "fill",

      target: {
        concept: input.concept,
        reference: input.targetReference,
        role: input.role,
        ...(input.placeholder
          ? { placeholder: input.placeholder }
          : {}),
        exact: true,
      },

      protectedReferenceId:
        input.credentialReference,
    },

    expectedEffect: {
      kind: "none",
    },

    constraints: {
      timeoutMs: TIMEOUT_MS,
      allowNewPage: false,
      allowNonExact: false,
    },

    authorization: {
      kind: "authentication",
    },

    protectedInputReferences: [
      input.credentialReference,
    ],
  });
}

function praxisTarget(input: {
  concept: string;
  reference: string;
  placeholder?: string;
}): InteractionTargetIntent {
  return {
    concept: input.concept,

    authoritativeReference: input.reference,

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
      placeholders: input.placeholder
        ? [input.placeholder]
        : [],
      inputTypes: [],
    },

    scope: { kind: "page" },

    relations: [],

    prohibited: [
      "hidden",
      "disabled",
    ],

    risk: "authentication",

    confidence: {
      requiredFamilies: [],
    },

    matching: "exact",
  };
}

function praxisContext(
  policy: ExecutionPolicy,
) {
  return {
    channel: "protected" as const,
    ordinal: ++ordinal,
    allowedOrigins: policy.allowedOrigins,
    timeoutMs: TIMEOUT_MS,
    dispatchSemantics: "mutation" as const,

    privacy: {
      state: "protected",
      allowedChannels: [
        "public_dom",
        "accessibility",
      ],
      suppressedChannels: [
        "visual",
        "ocr",
      ],
    },

    beforeMutation: async () => undefined,
  };
}

async function waitForLoginControls(
  activePage: Page,
) {
  const startedAt = performance.now();

  while (true) {
    const observation =
      await observeSemanticPageContext(activePage);

    const hasEmail =
      observation.controls.some(
        (control) =>
          control.role === "textbox" &&
          /email/i.test(control.name),
      );

    const hasPassword =
      observation.controls.some(
        (control) =>
          control.role === "textbox" &&
          control.semanticPurpose === "password",
      );

    if (hasEmail && hasPassword)
      return observation;

    if (
      performance.now() - startedAt >
      15_000
    )
      throw coded(
        "LAYER_B_LOGIN_CONTROLS_TIMEOUT",
      );

    await activePage.waitForTimeout(250);
  }
}

function summarizePraxis(
  credential: "email" | "password",
  result: PraxisResult,
): DirectPraxisResult {
  const verification =
    result.status === "succeeded"
      ? result.verification
      : result.report.verification;

  return {
    credential,
    status: result.status,
    code:
      result.status === "succeeded"
        ? "none"
        : result.code,
    mutationOutcome:
      result.mutationOutcome,
    localVerification:
      verification.local,
    durationMs:
      Math.round(result.timing.totalMs),
  };
}

function nestCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "getResponse" in error &&
    typeof (error as {
      getResponse?: unknown;
    }).getResponse === "function"
  ) {
    const response =
      (
        error as {
          getResponse(): unknown;
        }
      ).getResponse();

    if (
      typeof response === "object" &&
      response !== null &&
      "code" in response &&
      typeof (response as {
        code?: unknown;
      }).code === "string"
    )
      return (
        response as {
          code: string;
        }
      ).code;
  }

  return safeCode(error);
}

function recordSafeLocation(
  activePage: Page,
) {
  try {
    const location =
      new URL(activePage.url());

    output.finalOrigin =
      location.origin;

    output.finalPath =
      location.pathname;
  } catch {
    output.finalOrigin =
      "unavailable";

    output.finalPath =
      "unavailable";
  }
}

function coded(code: string) {
  return Object.assign(
    new Error(code),
    { code },
  );
}

function safeCode(error: unknown) {
  const candidate =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as {
      code?: unknown;
    }).code === "string"
      ? (
          error as {
            code: string;
          }
        ).code
      : error instanceof Error
        ? error.message
        : String(error);

  return /^[A-Z][A-Z0-9_]*$/.test(candidate)
    ? candidate
    : "LAYER_B_UNCLASSIFIED_FAILURE";
}

function printOutput(
  value: Output,
) {
  process.stdout.write(
    [
      "============================================================",
      "R0.7 LAYER B — ADMISSION VS PRAXIS",
      "============================================================",

      `layer: ${value.layer}`,

      `missionProgressionUsed: ${value.missionProgressionUsed}`,
      `flowProgressionUsed: ${value.flowProgressionUsed}`,
      `runUsed: ${value.runUsed}`,
      `mcpUsed: ${value.mcpUsed}`,

      `failureStage: ${value.failureStage}`,
      `failureCode: ${value.failureCode}`,

      `sessionProtectedAllowlist: ${JSON.stringify(
        value.sessionProtectedAllowlist,
      )}`,

      `emailEnvironmentAuthorized: ${value.emailEnvironmentAuthorized}`,
      `passwordEnvironmentAuthorized: ${value.passwordEnvironmentAuthorized}`,

      `emailReferenceObserved: ${value.emailReferenceObserved}`,
      `passwordReferenceObserved: ${value.passwordReferenceObserved}`,

      `admissionResults: ${JSON.stringify(
        value.admissionResults,
      )}`,

      `praxisResults: ${JSON.stringify(
        value.praxisResults,
      )}`,

      `resolverCalls: ${JSON.stringify(
        value.resolverCalls,
      )}`,

      `contradictionProven: ${value.contradictionProven}`,

      `finalOrigin: ${value.finalOrigin}`,
      `finalPath: ${value.finalPath}`,

      `elapsedMs: ${value.elapsedMs}`,

      `result: ${value.result}`,
      "",
    ].join("\n"),
  );
}
