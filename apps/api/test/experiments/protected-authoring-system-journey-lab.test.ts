import { randomUUID } from "node:crypto";
import { protectedTransactionDigest } from "@scry/executor";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  currentPlanSchema,
  executionPolicySchema,
  type Assertion,
  type InteractionTargetIntent,
  type MissionAuthoringIntent,
  type ProtectedTransaction,
} from "@scry/contracts";
import { SecretRedactor } from "@scry/policy";
import { registerPraxisVeilAuthority, resolveTargetLocator } from "@scry/praxis";
import {
  compileVeilPolicy,
  VeilAuthority,
  VeilChannelCollector,
  VeilRuntimeCoordinator,
} from "@scry/veil";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { compileMissionAuthoringProtectedTransaction } from "../../src/adaptive-sessions/mission-authoring-protected-transaction.js";
import { createAuthoringBrowserSession } from "@scry/praxis";
import { BrowserSessionProvenance } from "@scry/praxis";
import {
  PlaywrightProtectedCapsuleFactory,
  ProtectedTransactionKernel,
  type MutationLedgerState,
  type ProtectedOperationClaim,
  type ProtectedTransactionStore,
} from "../../src/runtime/protected-transactions/protected-transaction-coordinator.js";
import { kernelInteractionExecutor } from "../../../../packages/executor/test/kernel-harness.js";

type Shape = "vitract_dialog" | "static_panel" | "delayed_wizard" | "network_only";
type Prototype = "authored_strict" | "role_neutral" | "bounded_general" | "bounded_with_envelope";

type FixtureState = {
  dispatches: Record<Shape, number>;
  revocations: Record<Shape, number>;
  credentials: Map<
    Shape,
    { clientId: string; clientSecret: string; receipt: string; revoked: boolean }
  >;
  orders: Map<string, { id: string; audience: string; identityMode: string }>;
  idempotency: Map<string, { payload: string; id: string }>;
  apiCalls: Array<{ endpoint: string; status: number }>;
};

const loginEmail = "journey-login@example.invalid";
const loginPassword = "journey-login-secret";
const protectedCanary = "journey-protected-secret-canary";
const loginEmailRef = "11111111-1111-4111-8111-111111111111";
const loginPasswordRef = "22222222-2222-4222-8222-222222222222";
const forbidden =
  /(selector|xpath|runtimeId|fingerprint|browserHandle|outerHTML|innerHTML|clipboardContent)/i;

let server: ReturnType<typeof createServer>;
let browser: Browser;
let origin: string;
let state: FixtureState;

beforeAll(async () => {
  state = freshState();
  server = createServer((request, response) => void route(request, response, state));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("SYSTEM_JOURNEY_FIXTURE_UNAVAILABLE");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("protected authoring whole-system architecture laboratory", () => {
  it.each(["vitract_dialog", "static_panel", "delayed_wizard", "network_only"] as const)(
    "completes login through authenticated order API calls for %s",
    async (shape) => {
      const result = await runWholeJourney(shape, "bounded_with_envelope");

      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        dispatches: 1,
        persistedReferences: 2,
        authenticatedCalls: 25,
        validCalls: 11,
        invalidCalls: 14,
        externallyObservableOrders: 5,
        residualCredentials: 0,
      });
      expect(result.durationMs).toBeLessThan(20_000);
      expect(JSON.stringify(result)).not.toContain(protectedCanary);
      expect(JSON.stringify(result)).not.toContain(loginPassword);
      expect(JSON.stringify(result)).not.toMatch(forbidden);
    },
    30_000,
  );

  it.each(
    (
      ["authored_strict", "role_neutral", "bounded_general", "bounded_with_envelope"] as const
    ).flatMap((prototype) =>
      (["vitract_dialog", "static_panel", "delayed_wizard", "network_only"] as const).map(
        (shape) => [prototype, shape] as const,
      ),
    ),
  )(
    "proves candidate %s on the complete %s journey",
    async (prototype, shape) => {
      const result = await runWholeJourney(shape, prototype);
      expect(result.status).toBe("completed");
      expect(result.dispatches).toBeLessThanOrEqual(1);
      expect(JSON.stringify(result)).not.toContain(protectedCanary);
      expect(JSON.stringify(result)).not.toMatch(forbidden);
    },
    30_000,
  );

  it.each(["missing_output", "persistence_failure", "post_dispatch_timeout"] as const)(
    "reconciles %s without redispatch or orphaned credentials",
    async (failure) => {
      const result = await runFailureJourney(failure);
      expect(result).toMatchObject({
        status: "reconciled",
        dispatches: 1,
        revocations: 1,
        persistedReferences: failure === "persistence_failure" ? 0 : 2,
        residualCredentials: 0,
        redispatches: 0,
      });
      expect(JSON.stringify(result)).not.toContain(protectedCanary);
      expect(JSON.stringify(result)).not.toMatch(forbidden);
    },
    30_000,
  );

  it("recovers a staged response in a fresh kernel without redispatch and completes the full API journey", async () => {
    const result = await runCrashRecoveryWholeJourney();
    expect(result).toMatchObject({
      status: "completed_after_recovery",
      dispatches: 1,
      recoveryAttempts: 1,
      persistedReferences: 2,
      authenticatedCalls: 25,
      residualCredentials: 0,
    });
    expect(JSON.stringify(result)).not.toContain(protectedCanary);
    expect(JSON.stringify(result)).not.toMatch(forbidden);
  }, 30_000);
});

async function runCrashRecoveryWholeJourney() {
  const shape: Shape = "network_only";
  resetShape(shape);
  const secrets = new Map<string, string>([
    [loginEmailRef, loginEmail],
    [loginPasswordRef, loginPassword],
  ]);
  const authoring = await openAuthoringSession(secrets);
  try {
    await completePortalJourney(authoring, shape);
    const acquired = await acquireCredentials(
      shape,
      "bounded_with_envelope",
      secrets,
      "process_loss_after_response",
    );
    expect(acquired.completed, JSON.stringify(acquired)).toBe(true);
    await completeDocumentationAndApiJourney(
      authoring,
      acquired.clientIdRef!,
      acquired.clientSecretRef!,
    );
    await reconcileReceipt(shape, acquired.receipt);
    return safeResult({
      status: "completed_after_recovery" as const,
      dispatches: state.dispatches[shape],
      recoveryAttempts: acquired.recoveryAttempts,
      persistedReferences: acquired.referenceCount,
      authenticatedCalls: state.apiCalls.splice(0).length,
      residualCredentials: activeCredentialCount(shape),
    });
  } finally {
    await authoring.close();
  }
}

async function runWholeJourney(shape: Shape, prototype: Prototype) {
  resetShape(shape);
  const started = performance.now();
  const secrets = new Map<string, string>([
    [loginEmailRef, loginEmail],
    [loginPasswordRef, loginPassword],
  ]);
  const authoring = await openAuthoringSession(secrets);
  try {
    await completePortalJourney(authoring, shape);
    const acquired = await acquireCredentials(shape, prototype, secrets);
    if (!acquired.completed) {
      await reconcileReceipt(shape, acquired.receipt);
      return safeResult({
        prototype,
        shape,
        status: "failed_reconciled" as const,
        protectedStatus: acquired.protectedStatus,
        reasonCode: acquired.reasonCode,
        preparationStatus: acquired.preparationStatus,
        mutationDispatch: acquired.mutationDispatch,
        protectedExtraction: acquired.protectedExtraction,
        dispatches: state.dispatches[shape],
        persistedReferences: acquired.referenceCount,
        residualCredentials: activeCredentialCount(shape),
        durationMs: performance.now() - started,
      });
    }

    try {
      await completeDocumentationAndApiJourney(
        authoring,
        acquired.clientIdRef!,
        acquired.clientSecretRef!,
      );
    } catch (error) {
      await reconcileReceipt(shape, acquired.receipt);
      return safeResult({
        prototype,
        shape,
        status: "api_failed_reconciled" as const,
        reasonCode: safeErrorCode(error),
        dispatches: state.dispatches[shape],
        persistedReferences: acquired.referenceCount,
        residualCredentials: activeCredentialCount(shape),
        durationMs: performance.now() - started,
      });
    }
    await reconcileReceipt(shape, acquired.receipt);
    const calls = state.apiCalls.splice(0);
    return safeResult({
      prototype,
      shape,
      status: "completed" as const,
      dispatches: state.dispatches[shape],
      persistedReferences: acquired.referenceCount,
      authenticatedCalls: calls.length,
      validCalls: calls.filter((call) => call.status >= 200 && call.status < 300).length,
      invalidCalls: calls.filter((call) => call.status >= 400).length,
      externallyObservableOrders: state.orders.size,
      residualCredentials: activeCredentialCount(shape),
      durationMs: performance.now() - started,
    });
  } finally {
    await authoring.close();
  }
}

async function runFailureJourney(
  failure: "missing_output" | "persistence_failure" | "post_dispatch_timeout",
) {
  const shape: Shape = "static_panel";
  resetShape(shape);
  const secrets = new Map<string, string>();
  const acquired = await acquireCredentials(shape, "bounded_general", secrets, failure);
  await reconcileReceipt(shape, acquired.receipt);
  return safeResult({
    failure,
    status: "reconciled" as const,
    dispatches: state.dispatches[shape],
    revocations: state.revocations[shape],
    persistedReferences: acquired.referenceCount,
    residualCredentials: activeCredentialCount(shape),
    redispatches: 0,
  });
}

async function openAuthoringSession(secrets: Map<string, string>) {
  const policy = executionPolicySchema.parse({
    allowedOrigins: [origin],
    allowPrivateNetwork: true,
    allowPopups: false,
    maxActions: 50,
    maxNavigations: 20,
    maxDurationMs: 60_000,
  });
  return createAuthoringBrowserSession({
    sessionId: randomUUID(),
    environmentId: "system-journey-lab",
    veilAdmissionKey: "system-journey-lab-admission-key-32-bytes",
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    policy,
    openBrowser: async () => {
      const authoringBrowser = await chromium.launch({
        headless: true,
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      const context = await authoringBrowser.newContext();
      return { browser: authoringBrowser, context, page: await context.newPage() };
    },
    executeInteraction: kernelInteractionExecutor({
      sessionId: randomUUID(),
      environmentId: "system-journey-lab",
      policy,
      secretResolver: async (reference) => secrets.get(reference) ?? "",
    }),
  });
}

async function completePortalJourney(
  session: Awaited<ReturnType<typeof openAuthoringSession>>,
  shape: Shape,
) {
  await succeeded(session.interact({ type: "navigate", url: `${origin}/login`, timeoutMs: 2_000 }));
  await succeeded(
    session.interact({
      type: "fill",
      target: semantic("email", "textbox", "Email"),
      secretRef: loginEmailRef,
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "fill",
      target: semantic("password", "textbox", "Password"),
      secretRef: loginPasswordRef,
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("login", "button", "Login"),
      expectedEffect: { type: "navigation", url: `${origin}/portal`, match: "exact" },
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("developer", "link", "Developer"),
      expectedEffect: { type: "navigation", url: `${origin}/developer`, match: "exact" },
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("test mode", "button", "Test Mode"),
      expectedEffect: { type: "none" },
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("applications", "link", "Applications"),
      expectedEffect: {
        type: "navigation",
        url: `${origin}/applications?shape=${shape}`,
        match: "exact",
      },
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("new application", "button", "New application"),
      expectedEffect: { type: "none" },
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "fill",
      target: semantic("application name", "textbox", "Application name"),
      value: `Journey ${shape}`,
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("save application", "button", "Save"),
      expectedEffect: {
        type: "navigation",
        url: `${origin}/application?shape=${shape}`,
        match: "exact",
      },
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("credentials", "link", "Credentials"),
      expectedEffect: {
        type: "navigation",
        url: `${origin}/credentials?shape=${shape}`,
        match: "exact",
      },
      timeoutMs: 2_000,
    }),
  );
}

async function acquireCredentials(
  shape: Shape,
  prototype: Prototype,
  secrets: Map<string, string>,
  failure?:
    | "missing_output"
    | "persistence_failure"
    | "post_dispatch_timeout"
    | "process_loss_after_response",
) {
  const objectiveId = randomUUID();
  const flowDraftId = randomUUID();
  const navigateId = `visit-${shape}`;
  const nameId = `name-${shape}`;
  const entryUrl = `${origin}/credentials?shape=${shape}${failure ? `&failure=${failure}` : ""}`;
  const preparation: MissionAuthoringIntent[] = [
    intentBase(navigateId, objectiveId, flowDraftId, { kind: "navigate", url: entryUrl }),
    intentBase(nameId, objectiveId, flowDraftId, {
      kind: "fill",
      target: { concept: "credential name", role: "textbox", name: "Credential name", exact: true },
      publicValue: `Journey ${shape}`,
    }),
  ];
  const action: Extract<MissionAuthoringIntent["action"], { kind: "acquire_protected_outputs" }> = {
    kind: "acquire_protected_outputs",
    preparationIntentIds: [navigateId, nameId],
    mutation: {
      kind: "one_time",
      target: {
        concept: "add credential",
        role: "button",
        name: "Add credential",
        exact: true,
        scope: { kind: "dialog", name: "Add credential" },
      },
    },
    outputs: [
      {
        reference: "clientId",
        classification: "protected",
        target: {
          concept: "client id",
          role: "value",
          name: "Client ID",
          exact: true,
          scope: { kind: "dialog", name: "Credential generated" },
        },
        storageName: `Journey ${shape} client ID`,
      },
      {
        reference: "clientSecret",
        classification: "protected",
        target: {
          concept: "client secret",
          role: "value",
          name: "Client secret",
          exact: true,
          scope: { kind: "dialog", name: "Credential generated" },
        },
        storageName: `Journey ${shape} client secret`,
      },
    ],
  };
  let transaction = compileMissionAuthoringProtectedTransaction({
    operationId: `system-journey-${shape}-${prototype}`,
    entryUrl,
    action,
    preparation,
    timeoutMs: 6_000,
  });
  transaction = prototypeTransaction(transaction, prototype);
  expect(() => currentPlanSchema.parse(planFor(transaction))).not.toThrow();

  const memory = memoryStore();
  let clientIdRef: string | undefined;
  let clientSecretRef: string | undefined;
  let receipt: string | undefined;
  let stagedOutputs:
    | Parameters<
        NonNullable<
          import("../../src/runtime/protected-transactions/protected-transaction-coordinator.js").ProtectedTransactionDependencies["stageResponseOutputsAtomically"]
        >
      >[0]["outputs"]
    | undefined;
  let persistenceAttempts = 0;
  let recoveryAttempts = 0;
  const authority = new VeilAuthority(
    compileVeilPolicy({ profile: "balanced", allowedOrigins: [origin] }),
  );
  const executeAttempt = async () => {
    const safeContext = await browser.newContext();
    const safePage = await safeContext.newPage();
    await safePage.goto(entryUrl);
    const kernel = new ProtectedTransactionKernel({
      // Unit-store fixture: supply the immutable admitted program commitment.
      // Real preparation/scope/dispatch admission is covered by repository integration.
      canonicalProgramDigest: protectedTransactionDigest(transaction, [origin]),
      mutationIdentity: transaction.operationId,
      safeSession: {
        browser,
        context: safeContext,
        page: safePage,
        provenance: new BrowserSessionProvenance(randomUUID(), "safe"),
      },
      gate: new VeilRuntimeCoordinator([new VeilChannelCollector("evidence")]),
      redactor: new SecretRedactor(),
      store: memory.store,
      capsuleFactory: new PlaywrightProtectedCapsuleFactory(async () => {
        const capsuleBrowser = await chromium.launch({
          headless: true,
          channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
        });
        const context = await capsuleBrowser.newContext();
        return { browser: capsuleBrowser, context, page: await context.newPage() };
      }),
      allowedOrigins: [origin],
      prepareCapsule: async (capsule) => {
        registerPraxisVeilAuthority(capsule.page, {
          authority,
          userId: "lab",
          environmentId: "lab",
          browserContextId: capsule.provenance.contextId,
        });
        capsule.page.on("response", async (response) => {
          if (!response.url().includes("/dispatch") || response.request().method() !== "POST")
            return;
          const body = (await response.json().catch(() => undefined)) as
            { receipt?: unknown } | undefined;
          if (typeof body?.receipt === "string") receipt = body.receipt;
        });
      },
      resolveKnownSecret: async () => "",
      persistSecret: async () => {
        throw new Error("NON_ATOMIC_PERSISTENCE_FORBIDDEN");
      },
      persistPublicValue: async () => {
        throw new Error("NON_ATOMIC_PERSISTENCE_FORBIDDEN");
      },
      stageResponseOutputsAtomically: async (input) => {
        stagedOutputs = structuredClone(input.outputs);
      },
      recoverStagedResponseOutputs: async () => {
        recoveryAttempts += 1;
        return stagedOutputs ? structuredClone(stagedOutputs) : undefined;
      },
      persistOutputsAtomically: async (input) => {
        persistenceAttempts += 1;
        expect(input.outputs).toHaveLength(2);
        if (
          failure === "persistence_failure" ||
          (failure === "process_loss_after_response" && persistenceAttempts === 1)
        )
          throw new Error("LAB_PERSISTENCE_FAILURE");
        const references: Record<
          string,
          { classification: "protected"; credentialId: string; scope: "project" }
        > = {};
        for (const output of input.outputs) {
          const id = randomUUID();
          secrets.set(id, output.value);
          references[output.reference] = {
            classification: "protected",
            credentialId: id,
            scope: "project",
          };
        }
        clientIdRef = references.clientId?.credentialId;
        clientSecretRef = references.clientSecret?.credentialId;
        memory.setReferences(references);
        const claim = await memory.store.transition({
          id: input.claim.id,
          operationId: input.operationId,
          version: input.claim.version,
          fencingToken: input.claim.fencingToken,
          expected: "persisting",
          next: "persisted",
          phase: "persistence_committed",
        });
        return { claim, references };
      },
      verifyAssertions,
    });
    const execution = await kernel.execute(transaction);
    await safeContext.close();
    if (execution.safeSession.browser !== browser) await execution.safeSession.browser.close();
    return execution;
  };
  let result = await executeAttempt();
  if (failure === "process_loss_after_response" && result.result.status !== "completed")
    result = await executeAttempt();
  const completed = result.result.status === "completed";
  return {
    completed,
    protectedStatus: result.result.status,
    reasonCode: "reasonCode" in result.result ? result.result.reasonCode : undefined,
    preparationStatus: result.result.preparation.status,
    mutationDispatch: result.result.mutation.dispatch,
    protectedExtraction: result.result.protectedExtraction,
    receipt,
    clientIdRef,
    clientSecretRef,
    referenceCount: [clientIdRef, clientSecretRef].filter(Boolean).length,
    recoveryAttempts,
  };
}

function prototypeTransaction(transaction: ProtectedTransaction, prototype: Prototype) {
  if (prototype === "authored_strict") return transaction;
  const copy = structuredClone(transaction);
  for (const output of copy.extraction.outputs) {
    output.acquisition.target.preferredEvidence.roles = [];
    if (prototype === "bounded_general" || prototype === "bounded_with_envelope")
      output.acquisition.target.scope = { kind: "page" };
    if (prototype === "bounded_with_envelope") {
      output.acquisition.permittedMethods.push("protected_network_value");
    }
  }
  copy.acquisitionReadiness.valueIntent.preferredEvidence.roles = [];
  if (prototype === "bounded_general" || prototype === "bounded_with_envelope")
    copy.acquisitionReadiness.valueIntent.scope = { kind: "page" };
  if (prototype === "bounded_with_envelope")
    copy.acquisitionReadiness.approvedMethods.push("protected_network_value");
  return copy;
}

async function completeDocumentationAndApiJourney(
  session: Awaited<ReturnType<typeof openAuthoringSession>>,
  clientIdRef: string,
  clientSecretRef: string,
) {
  await succeeded(session.interact({ type: "navigate", url: `${origin}/docs`, timeoutMs: 2_000 }));
  await succeeded(
    session.interact({
      type: "fill",
      target: semantic("docs client id", "textbox", "Client ID"),
      secretRef: clientIdRef,
      timeoutMs: 2_000,
    }),
  );
  await succeeded(
    session.interact({
      type: "fill",
      target: semantic("docs client secret", "textbox", "Client secret"),
      secretRef: clientSecretRef,
      timeoutMs: 2_000,
    }),
  );
  for (const [audience, identityMode] of [
    ["client", "existing"],
    ["client", "nested"],
    ["practitioner", "existing"],
    ["practitioner", "nested"],
  ] as const) {
    await session.page.selectOption("#audience", audience);
    await session.page.selectOption("#identity-mode", identityMode);
    await succeeded(
      session.interact({
        type: "click",
        target: semantic("create order", "button", "Create order"),
        expectedEffect: { type: "none" },
        timeoutMs: 2_000,
      }),
    );
    await session.page
      .getByRole("status")
      .filter({ hasText: "201" })
      .waitFor({ state: "visible", timeout: 2_000 });
  }
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("retrieve order", "button", "Retrieve order"),
      expectedEffect: { type: "none" },
      timeoutMs: 2_000,
    }),
  );
  await session.page
    .getByRole("status")
    .filter({ hasText: "200" })
    .waitFor({ state: "visible", timeout: 2_000 });
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("list orders", "button", "List orders"),
      expectedEffect: { type: "none" },
      timeoutMs: 2_000,
    }),
  );
  await session.page
    .getByRole("status")
    .filter({ hasText: "200" })
    .waitFor({ state: "visible", timeout: 2_000 });
  await session.page.selectOption("#identity-mode", "conflicting");
  await succeeded(
    session.interact({
      type: "click",
      target: semantic("create order", "button", "Create order"),
      expectedEffect: { type: "none" },
      timeoutMs: 2_000,
    }),
  );
  await session.page
    .getByRole("status")
    .filter({ hasText: "400" })
    .waitFor({ state: "visible", timeout: 2_000 });
  await session.page.selectOption("#identity-mode", "existing");
  for (const [requestCase, expected] of [
    ["missing_identity", "400"],
    ["malformed_identity", "400"],
    ["nonexistent_identity", "404"],
    ["missing_required", "400"],
    ["invalid_order_value", "400"],
    ["authentication_rejected", "401"],
    ["authorization_rejected", "403"],
    ["idempotent", "201"],
    ["idempotent_replay", "200"],
    ["idempotency_conflict", "409"],
  ] as const) {
    await session.page.selectOption("#request-case", requestCase);
    await succeeded(
      session.interact({
        type: "click",
        target: semantic("create order", "button", "Create order"),
        expectedEffect: { type: "none" },
        timeoutMs: 2_000,
      }),
    );
    await session.page
      .getByRole("status")
      .filter({ hasText: expected })
      .waitFor({ state: "visible", timeout: 2_000 });
  }
  for (const [queryCase, expected] of [
    ["page_boundary", "200"],
    ["limit_boundary", "200"],
    ["status_filter", "200"],
    ["page_invalid", "400"],
    ["limit_invalid", "400"],
    ["status_invalid", "400"],
  ] as const) {
    await session.page.selectOption("#query-case", queryCase);
    await succeeded(
      session.interact({
        type: "click",
        target: semantic("list orders", "button", "List orders"),
        expectedEffect: { type: "none" },
        timeoutMs: 2_000,
      }),
    );
    await session.page
      .getByRole("status")
      .filter({ hasText: expected })
      .waitFor({ state: "visible", timeout: 2_000 });
  }
  for (const [retrieveCase, expected] of [
    ["malformed", "400"],
    ["nonexistent", "404"],
  ] as const) {
    await session.page.selectOption("#retrieve-case", retrieveCase);
    await succeeded(
      session.interact({
        type: "click",
        target: semantic("retrieve order", "button", "Retrieve order"),
        expectedEffect: { type: "none" },
        timeoutMs: 2_000,
      }),
    );
    await session.page
      .getByRole("status")
      .filter({ hasText: expected })
      .waitFor({ state: "visible", timeout: 2_000 });
  }
}

async function succeeded(promise: Promise<{ outcome: { functionalResult: string } }>) {
  const result = await promise;
  expect(result.outcome.functionalResult, JSON.stringify(result.outcome)).toBe("succeeded");
}

function semantic(
  concept: string,
  role: "textbox" | "button" | "link",
  name: string,
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities:
      role === "textbox"
        ? ["focusable", "accepts_text", "editable"]
        : ["focusable", "pointer_activatable"],
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "ordinary",
    confidence: { requiredFamilies: [], minimum: 0.35, minimumMargin: 0, minimumFamilyCount: 1 },
    matching: "exact",
  };
}

function intentBase(
  intentId: string,
  objectiveId: string,
  flowDraftId: string,
  action: MissionAuthoringIntent["action"],
): MissionAuthoringIntent {
  return {
    intentId,
    objectiveId,
    flowDraftId,
    action,
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 2_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

function planFor(transaction: ProtectedTransaction) {
  const continuation = transaction.continuation.strategies[0];
  if (!continuation || !("continueAtStepId" in continuation))
    throw new Error("SYSTEM_JOURNEY_CONTINUATION_REQUIRED");
  return {
    name: "Whole-system architecture laboratory",
    objective: "Complete the protected authoring journey",
    preconditions: [],
    allowedOrigins: [origin],
    budgets: { maxActions: 2, maxDurationMs: 20_000, maxNavigations: 2 },
    checkpoints: [],
    steps: [
      {
        id: "protected",
        title: "Generate and acquire",
        action: transaction,
        assertions: [],
        onFailure: "stop" as const,
        evidence: [],
        captureIntent: "transient" as const,
        transientJustification: "Disposable whole-system qualification.",
      },
      {
        id: continuation.continueAtStepId,
        title: "Continue safely",
        action: { type: "navigate" as const, url: continuation.reentryUrl, timeoutMs: 2_000 },
        assertions: [],
        onFailure: "stop" as const,
        evidence: [],
        captureIntent: "transient" as const,
        transientJustification: "Disposable whole-system qualification.",
      },
    ],
  };
}

function memoryStore() {
  let stateValue: MutationLedgerState = "planned";
  let version = 1;
  const claim = (): ProtectedOperationClaim => ({
    id: randomUUID(),
    state: stateValue,
    version,
    fencingToken: 1,
    mutationOutcome: "not_attempted",
  });
  const stableId = randomUUID();
  let mutationOutcome: NonNullable<ProtectedOperationClaim["mutationOutcome"]> = "not_attempted";
  let persistedReferences: ProtectedOperationClaim["persistedReferences"];
  const stableClaim = (): ProtectedOperationClaim => ({
    id: stableId,
    state: stateValue,
    version,
    fencingToken: 1,
    mutationOutcome,
    ...(persistedReferences ? { persistedReferences } : {}),
  });
  const store: ProtectedTransactionStore = {
    claim: async () => stableClaim(),
    transition: async (input) => {
      if (stateValue !== input.expected) throw new Error("PROTECTED_OPERATION_TRANSITION_FENCED");
      stateValue = input.next;
      version += 1;
      return stableClaim();
    },
    settleMutationOutcome: async ({ outcome }) => {
      if (
        (mutationOutcome === "applied" || mutationOutcome === "not_applied") &&
        mutationOutcome !== outcome
      )
        throw new Error("PROTECTED_MUTATION_OUTCOME_SETTLEMENT_FENCED");
      mutationOutcome = outcome;
      version += 1;
      return stableClaim();
    },
    record: async () => undefined,
  };
  void claim;
  return {
    store,
    setReferences: (references: NonNullable<ProtectedOperationClaim["persistedReferences"]>) => {
      persistedReferences = references;
    },
  };
}

async function verifyAssertions(page: Page, assertions: Assertion[]) {
  for (const assertion of assertions) {
    if (assertion.type === "url") {
      const actual = assertion.match === "path" ? new URL(page.url()).pathname : page.url();
      expect(actual).toBe(assertion.expected);
    } else if (assertion.type === "visible")
      expect(await (await resolveTargetLocator(page, assertion.target)).isVisible()).toBe(true);
    else if (assertion.type === "enabled")
      expect(await (await resolveTargetLocator(page, assertion.target)).isEnabled()).toBe(true);
    else if (assertion.type === "value")
      expect(await (await resolveTargetLocator(page, assertion.target)).inputValue()).toBe(
        assertion.expected,
      );
  }
}

function freshState(): FixtureState {
  return {
    dispatches: { vitract_dialog: 0, static_panel: 0, delayed_wizard: 0, network_only: 0 },
    revocations: { vitract_dialog: 0, static_panel: 0, delayed_wizard: 0, network_only: 0 },
    credentials: new Map(),
    orders: new Map(),
    idempotency: new Map(),
    apiCalls: [],
  };
}

function resetShape(shape: Shape) {
  state.dispatches[shape] = 0;
  state.revocations[shape] = 0;
  state.credentials.delete(shape);
  state.orders.clear();
  state.idempotency.clear();
  state.apiCalls = [];
}

function dispatchCredential(shape: Shape) {
  state.dispatches[shape] += 1;
  const receipt = randomUUID();
  state.credentials.set(shape, {
    clientId: `client-${shape}-${receipt.slice(0, 8)}`,
    clientSecret: protectedCanary,
    receipt,
    revoked: false,
  });
  return receipt;
}

async function reconcileReceipt(shape: Shape, receipt?: string) {
  const credential = state.credentials.get(shape);
  if (!credential || !receipt || credential.receipt !== receipt || credential.revoked) return;
  credential.revoked = true;
  state.revocations[shape] += 1;
}

function activeCredentialCount(shape: Shape) {
  const credential = state.credentials.get(shape);
  return credential && !credential.revoked ? 1 : 0;
}

function safeResult<T extends Record<string, unknown>>(value: T): T {
  const serialized = JSON.stringify(value);
  if (
    serialized.includes(protectedCanary) ||
    serialized.includes(loginPassword) ||
    forbidden.test(serialized)
  )
    throw new Error("SYSTEM_JOURNEY_PRIVACY_FAILURE");
  return value;
}

function safeErrorCode(error: unknown) {
  if (!(error instanceof Error)) return "UNKNOWN";
  if (error.name === "TimeoutError") return "TIMEOUT";
  return /^[A-Z][A-Z0-9_]*$/.test(error.message) ? error.message : "FAILED";
}

async function route(request: IncomingMessage, response: ServerResponse, fixture: FixtureState) {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (request.method === "POST" && url.pathname === "/dispatch") {
    const shape = (url.searchParams.get("shape") ?? "vitract_dialog") as Shape;
    const receipt = dispatchCredential(shape);
    const credential = fixture.credentials.get(shape)!;
    return json(response, 201, {
      receipt,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/orders") {
    const body = await bodyOf(request);
    const credential = [...fixture.credentials.values()].find(
      (candidate) =>
        !candidate.revoked &&
        candidate.clientId === body.clientId &&
        candidate.clientSecret === body.clientSecret,
    );
    if (!credential) return api(response, fixture, url.pathname, 401, { code: "UNAUTHORIZED" });
    if (body.requestCase === "authorization_rejected")
      return api(response, fixture, url.pathname, 403, { code: "FORBIDDEN" });
    if (body.identityMode === "conflicting")
      return api(response, fixture, url.pathname, 400, { code: "CONFLICTING_IDENTITY" });
    if (
      [
        "missing_identity",
        "malformed_identity",
        "missing_required",
        "invalid_order_value",
      ].includes(String(body.requestCase))
    )
      return api(response, fixture, url.pathname, 400, { code: "VALIDATION_REJECTED" });
    if (body.requestCase === "nonexistent_identity")
      return api(response, fixture, url.pathname, 404, { code: "NOT_FOUND" });
    const idempotencyKey = String(body.idempotencyKey ?? "");
    const canonicalPayload = JSON.stringify({
      audience: body.audience,
      identityMode: body.identityMode,
    });
    if (idempotencyKey) {
      const existing = fixture.idempotency.get(idempotencyKey);
      if (existing && existing.payload !== canonicalPayload)
        return api(response, fixture, url.pathname, 409, { code: "IDEMPOTENCY_CONFLICT" });
      if (existing)
        return api(response, fixture, url.pathname, 200, { id: existing.id, replayed: true });
    }
    const id = randomUUID();
    fixture.orders.set(id, {
      id,
      audience: String(body.audience),
      identityMode: String(body.identityMode),
    });
    if (idempotencyKey) fixture.idempotency.set(idempotencyKey, { payload: canonicalPayload, id });
    return api(response, fixture, url.pathname, 201, { id });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/orders/")) {
    const identity = url.pathname.slice("/api/orders/".length);
    const status =
      identity === "malformed"
        ? 400
        : identity === "nonexistent"
          ? 404
          : fixture.orders.size
            ? 200
            : 404;
    return api(response, fixture, url.pathname, status, { found: status === 200 });
  }
  if (request.method === "GET" && url.pathname === "/api/orders") {
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const status = url.searchParams.get("status");
    const validStatuses = [
      null,
      "pending",
      "paid",
      "shipped",
      "payment-pending",
      "pending-invoice",
      "partial-payment",
      "payment-failed",
      "cancelled",
    ];
    const responseStatus =
      Number.isInteger(page) &&
      page >= 1 &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= 100 &&
      validStatuses.includes(status)
        ? 200
        : 400;
    return api(response, fixture, url.pathname, responseStatus, {
      count: responseStatus === 200 ? fixture.orders.size : 0,
    });
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/login") return response.end(loginDocument());
  if (url.pathname === "/portal") return response.end(`<a href="/developer">Developer</a>`);
  if (url.pathname === "/developer")
    return response.end(
      `<button>Test Mode</button><a href="/applications?shape=vitract_dialog">Applications</a>`,
    );
  if (url.pathname === "/applications")
    return response.end(applicationsDocument(url.searchParams.get("shape") as Shape));
  if (url.pathname === "/application")
    return response.end(
      `<a href="/credentials?shape=${url.searchParams.get("shape")}">Credentials</a>`,
    );
  if (url.pathname === "/credentials")
    return response.end(
      credentialsDocument(
        url.searchParams.get("shape") as Shape,
        url.searchParams.get("failure") as
          | "missing_output"
          | "persistence_failure"
          | "post_dispatch_timeout"
          | "process_loss_after_response"
          | null,
      ),
    );
  if (url.pathname === "/docs") return response.end(docsDocument());
  response.statusCode = 404;
  response.end("Not found");
}

function loginDocument() {
  return `<!doctype html><label>Email<input aria-label="Email"></label><label>Password<input aria-label="Password" type="password"></label><button>Login</button><script>document.querySelector('button').onclick=()=>location.href='/portal'</script>`;
}

function applicationsDocument(shape: Shape) {
  return `<!doctype html><button id="new-app">New application</button><dialog aria-label="New application"><label>Application name<input aria-label="Application name"></label><button id="save">Save</button></dialog><script>document.querySelector('#new-app').onclick=()=>document.querySelector('dialog').showModal();document.querySelector('#save').onclick=()=>location.href='/application?shape=${shape}'</script>`;
}

function credentialsDocument(
  shape: Shape,
  failure:
    | "missing_output"
    | "persistence_failure"
    | "post_dispatch_timeout"
    | "process_loss_after_response"
    | null,
) {
  const output =
    shape === "vitract_dialog"
      ? `<dialog id="generated" aria-label="Credential generated"><label>Client ID<input readonly aria-label="Client ID"></label><label>Client secret<input readonly aria-label="Client secret"></label></dialog>`
      : shape === "static_panel"
        ? `<section id="generated" hidden aria-label="API access"><div role="group"><span aria-label="Client ID"></span><button>Copy Client ID</button></div><div role="group"><span aria-label="Client secret"></span><button>Copy Client secret</button></div></section>`
        : shape === "delayed_wizard"
          ? `<section id="generated" hidden aria-label="Generated credentials"><output aria-label="Client ID"></output><output aria-label="Client secret"></output></section>`
          : `<section id="generated" hidden aria-label="Network-issued credentials"></section>`;
  return `<!doctype html><dialog open aria-label="Add credential"><label>Credential name<input aria-label="Credential name"></label><button id="add">Add credential</button></dialog>${output}<script>
  add.onclick=async()=>{const result=await fetch('/dispatch?shape=${shape}',{method:'POST'});const data=await result.json();const values={clientId:data.clientId,clientSecret:${failure === "missing_output" ? JSON.stringify("") : "data.clientSecret"}};const reveal=()=>{const container=document.querySelector('#generated');container.hidden=false;if(container instanceof HTMLDialogElement)container.setAttribute('open','');const id=document.querySelector('[aria-label="Client ID"]');const secret=document.querySelector('[aria-label="Client secret"]');if(!id||!secret)return;if('value' in id)id.value=values.clientId;else id.textContent=values.clientId;if('value' in secret)secret.value=values.clientSecret;else secret.textContent=values.clientSecret};setTimeout(reveal,${shape === "network_only" || failure === "post_dispatch_timeout" ? 7_000 : shape === "delayed_wizard" ? 300 : 0})}
  </script>`;
}

function docsDocument() {
  return `<!doctype html><main><h1>Orders API</h1><label>Client ID<input aria-label="Client ID" id="client-id"></label><label>Client secret<input aria-label="Client secret" id="client-secret" type="password"></label><label>Audience<select id="audience"><option value="client">Client</option><option value="practitioner">Practitioner</option></select></label><label>Identity mode<select id="identity-mode"><option value="existing">Existing ID</option><option value="nested">Nested object</option><option value="conflicting">Conflicting</option></select></label><label>Request case<select id="request-case"><option value="valid">Valid</option><option>missing_identity</option><option>malformed_identity</option><option>nonexistent_identity</option><option>missing_required</option><option>invalid_order_value</option><option>authentication_rejected</option><option>authorization_rejected</option><option>idempotent</option><option>idempotent_replay</option><option>idempotency_conflict</option></select></label><label>Query case<select id="query-case"><option value="baseline">baseline</option><option>page_boundary</option><option>limit_boundary</option><option>status_filter</option><option>page_invalid</option><option>limit_invalid</option><option>status_invalid</option></select></label><label>Retrieve case<select id="retrieve-case"><option value="valid">valid</option><option>malformed</option><option>nonexistent</option></select></label><button id="create">Create order</button><button id="retrieve">Retrieve order</button><button id="list">List orders</button><div role="status"></div></main><script>
  const status=document.querySelector('[role=status]');const auth=()=>({clientId:document.querySelector('#client-id').value,clientSecret:document.querySelector('#client-secret').value});
  create.onclick=async()=>{const requestCase=document.querySelector('#request-case').value;const credentials=requestCase==='authentication_rejected'?{clientId:'invalid',clientSecret:'invalid'}:auth();const idempotencyKey=['idempotent','idempotent_replay','idempotency_conflict'].includes(requestCase)?'stable-key':'';const identityMode=requestCase==='idempotency_conflict'?'nested':document.querySelector('#identity-mode').value;const response=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...credentials,audience:audience.value,identityMode,requestCase,idempotencyKey})});status.textContent=String(response.status)};
  retrieve.onclick=async()=>{const value=document.querySelector('#retrieve-case').value;const response=await fetch('/api/orders/'+(value==='valid'?'latest':value));status.textContent=String(response.status)};
  list.onclick=async()=>{const value=document.querySelector('#query-case').value;const query=value==='page_boundary'?'?page=2':value==='limit_boundary'?'?limit=100':value==='status_filter'?'?status=pending':value==='page_invalid'?'?page=0':value==='limit_invalid'?'?limit=101':value==='status_invalid'?'?status=unknown':'';const response=await fetch('/api/orders'+query);status.textContent=String(response.status)};
  </script>`;
}

async function bodyOf(request: IncomingMessage) {
  let value = "";
  for await (const chunk of request) value += String(chunk);
  return JSON.parse(value || "{}") as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function api(
  response: ServerResponse,
  fixture: FixtureState,
  endpoint: string,
  status: number,
  value: unknown,
) {
  fixture.apiCalls.push({ endpoint, status });
  return json(response, status, value);
}
