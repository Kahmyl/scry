import { dispatchRunOperationSchema, missionAuthoringIntentSchema } from "@scry/contracts";

import { Database } from "../../src/infrastructure/database.js";

const phase = process.argv[3] ?? "prepare";
const apiBase = process.env.SCRY_LAB_API_BASE_URL ?? "http://127.0.0.1:4400/api";
const serviceToken = required("SCRY_SERVICE_TOKEN");
const runId = process.env.SCRY_LAB_RUN_ID ?? "e603f666-8623-49ec-ad84-c775958a10d7";
const label = required("SCRY_LAB_LABEL");
const prefix = required("SCRY_LAB_INTENT_PREFIX");
const statePath = process.env.SCRY_LAB_STATE_PATH ?? `/private/tmp/${prefix}.json`;

const fixed = {
  projectId: "953a8ca7-fb7b-4d31-bcc7-fcfb8c982f78",
  missionId: "91e78a95-6331-47b7-9e8e-da452726f170",
  objectiveId: "df71471c-23a0-4ea7-a0d8-bf6155f1d0c4",
  flowDraftId: "9f291c78-2400-4d45-9188-c0f19834613b",
  environmentId: "faca3dad-9ff7-4633-b058-1239d0aefb65",
  agentSessionId: "16c99c89-6d82-4883-8261-cf4a0b427f4a",
  credentialUrl:
    "https://preview.vitract.com/partner/developer/applications/vtr_app_sandbox_05fe8985-f69b-f111-9b33-00224854e25a/credentials",
  applicationId: "vtr_app_sandbox_05fe8985-f69b-f111-9b33-00224854e25a",
  loginEmailReference: "950c756d-c595-4f09-9f05-d64ceeab5cf9",
  loginPasswordReference: "ecc3f126-9a68-4994-9869-dc63a987786c",
} as const;

type SafeState = {
  praxisSessionId: string;
  generationIntentId: string;
  openIntentId: string;
  fillIntentId: string;
  submitReference: string;
  submitScope: { kind: string; name?: string; direct?: boolean };
  label: string;
};

if (phase === "prepare") await prepare();
else if (phase === "generate") await generate();
else throw new Error(`UNKNOWN_PROTECTED_CREDENTIAL_GENERATION_PHASE:${phase}`);

async function prepare() {
  const praxis = await post<{ id: string }>("/praxis-sessions", {
    projectId: fixed.projectId,
    missionId: fixed.missionId,
    objectiveId: fixed.objectiveId,
    flowDraftId: fixed.flowDraftId,
    environmentId: fixed.environmentId,
    agentSessionId: fixed.agentSessionId,
    objective: "Qualify real protected Vitract credential generation.",
    allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
    idempotencyKey: `${prefix}-praxis`,
    turnBudgets: { maxOperations: 20, maxDurationMs: 60_000 },
    initialProtectedReferenceIds: [fixed.loginEmailReference, fixed.loginPasswordReference],
    protection: "protected",
  });
  await post(`/runs/${runId}/praxis-session`, {
    praxisSessionId: praxis.id,
    idempotencyKey: `${prefix}-attach`,
  });

  let currentPage = await observe(praxis.id);
  if (currentPage.url !== fixed.credentialUrl) {
    await navigateToCredentials(praxis.id, `${prefix}-nav`);
    currentPage = await observe(praxis.id);
  }
  if (new URL(currentPage.url).pathname.startsWith("/login")) {
    const login = await observeUntil(praxis.id, ({ controls }) =>
      controls.some((control) => control.role === "textbox" && control.name === "Enter your email"),
    "login form");
    const email = one(login.controls, (control) =>
      control.role === "textbox" && control.name === "Enter your email", "login email");
    const password = one(login.controls, (control) =>
      control.role === "textbox" && control.semanticPurpose === "password", "login password");
    const loginSubmit = one(login.controls, (control) =>
      control.role === "button" && control.name === "Login", "login submit");
    await dispatch(praxis.id, {
      intentId: `${prefix}-auth`, objectiveId: fixed.objectiveId, flowDraftId: fixed.flowDraftId,
      action: {
        kind: "authenticate",
        fields: [
          { target: exact("login email", email.reference), protectedReferenceId: fixed.loginEmailReference },
          { target: exact("login password", password.reference), protectedReferenceId: fixed.loginPasswordReference },
        ],
        submitTarget: exact("login submit", loginSubmit.reference),
      },
      authorization: { kind: "authentication" },
      expectedEffect: { kind: "none" },
      constraints: constraints(30_000),
      protectedInputReferences: [fixed.loginEmailReference, fixed.loginPasswordReference],
    });
    await observeUntil(praxis.id, ({ url }) => !new URL(url).pathname.startsWith("/login"), "authenticated page");
    await navigateToCredentials(praxis.id, `${prefix}-nav-authenticated`);
    await observeUntil(praxis.id, ({ url }) => url === fixed.credentialUrl, "authenticated credentials page");
  }
  const page = await observeUntil(praxis.id, ({ controls }) =>
    controls.some((control) => control.role === "button" && control.name === "Add credential" && control.group === "Credentials"),
  "credentials page");
  const add = one(page.controls, (control) =>
    control.role === "button" && control.name === "Add credential" && control.group === "Credentials",
  "outer Add credential");
  const openIntentId = `${prefix}-open`;
  await dispatch(praxis.id, {
    intentId: openIntentId, objectiveId: fixed.objectiveId, flowDraftId: fixed.flowDraftId,
    action: { kind: "activate", target: exact("Add credential", add.reference), semanticEffect: "read_context_transition" },
    authorization: { kind: "live_read" }, expectedEffect: { kind: "none" },
    constraints: constraints(30_000), protectedInputReferences: [],
  });
  const modal = await observeUntil(praxis.id, ({ controls }) =>
    controls.some((control) => control.role === "textbox" && control.name === "Name"),
  "credential dialog");
  const name = one(modal.controls, (control) => control.role === "textbox" && control.name === "Name", "credential label");
  const fillIntentId = `${prefix}-fill`;
  await dispatch(praxis.id, {
    intentId: fillIntentId, objectiveId: fixed.objectiveId, flowDraftId: fixed.flowDraftId,
    action: { kind: "fill", target: exact("credential label", name.reference), publicValue: label },
    authorization: { kind: "ordinary" }, expectedEffect: { kind: "none" },
    constraints: constraints(30_000), protectedInputReferences: [],
  });
  const current = await observeUntil(praxis.id, ({ controls }) =>
    controls.some((control) => control.role === "button" && control.name === "Add credential" && control.boundary?.kind === "form"),
  "credential dialog submit");
  const submit = one(current.controls, (control) =>
    control.role === "button" && control.name === "Add credential" && control.boundary?.kind === "form",
  "modal Add credential submit");
  if (!submit.boundary) throw new Error("FACTUAL_SUBMIT_BOUNDARY_REQUIRED");
  const state: SafeState = {
    praxisSessionId: praxis.id,
    generationIntentId: `${prefix}-generate`, openIntentId, fillIntentId,
    submitReference: submit.reference, submitScope: { ...submit.boundary, direct: true }, label,
  };
  const fs = await import("node:fs/promises");
  await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  print("PREPARED", { ...state, statePath });
}

async function navigateToCredentials(praxisSessionId: string, intentId: string) {
  await dispatch(praxisSessionId, {
    intentId, objectiveId: fixed.objectiveId, flowDraftId: fixed.flowDraftId,
    action: { kind: "navigate", url: fixed.credentialUrl }, authorization: { kind: "live_read" },
    expectedEffect: { kind: "none" },
    constraints: constraints(30_000), protectedInputReferences: [],
  });
}

async function generate() {
  const fs = await import("node:fs/promises");
  const state = JSON.parse(await fs.readFile(statePath, "utf8")) as SafeState;
  const authorizationId = required("SCRY_LAB_AUTHORIZATION_ID");
  const current = await observe(state.praxisSessionId);
  const submit = one(current.controls, (control) =>
    control.reference === state.submitReference && control.role === "button" &&
    control.name === "Add credential" && control.boundary?.kind === state.submitScope.kind &&
    control.boundary?.name === state.submitScope.name,
  "current modal Add credential submit");
  const intent = missionAuthoringIntentSchema.parse({
    intentId: state.generationIntentId,
    objectiveId: fixed.objectiveId,
    flowDraftId: fixed.flowDraftId,
    action: {
      kind: "acquire_protected_outputs",
      preparationIntentIds: [state.openIntentId, state.fillIntentId],
      mutation: {
        kind: "one_time",
        target: {
          concept: "confirm add credential", role: "button", name: "Add credential",
          scope: state.submitScope, reference: submit.reference, exact: true,
        },
      },
      outputs: [
        output("credentialRecordIdentity", "public", "credential id", "id", "Vitract credential record identity"),
        output("credentialClientId", "public", "client id", "Client ID", "Vitract credential Client ID"),
        output("credentialClientSecret", "protected", "client secret", "Client secret", "Vitract credential Client secret"),
      ],
      externalResourceBindings: [{
        status: "active", identityReference: "credentialRecordIdentity", provider: "vitract",
        resourceKind: "credential_record", resourceScope: fixed.applicationId,
        identityContractVersion: 1, identitySource: "response", requiredForDestructiveLifecycle: true,
      }],
      resourceEffect: {
        operation: "create", provider: "vitract", resourceKind: "credential_record",
        resourceScope: fixed.applicationId, identityContractVersion: 1,
        correlation: { field: "label", value: state.label, uniqueness: "resource_scope" },
      },
    },
    expectedEffect: { kind: "none" },
    authorization: { kind: "protected_mutation", authorizationId },
    protectedInputReferences: [], constraints: constraints(60_000),
  });
  const database = new Database();
  try {
    const before = await counts(database, state, authorizationId);
    if (before.adaptive !== 0 || before.protected !== 0 || before.authorization !== 1)
      throw new Error(`LIVE_GENERATION_PREFLIGHT_INVALID:${JSON.stringify(before)}`);
    console.log(`==========================================\nLIVE LAB GENERATION ${prefix}\nONE ATTEMPT FOR THIS INTENT\n==========================================`);
    const result = await post(`/runs/${runId}/operations`, dispatchRunOperationSchema.parse({
      praxisSessionId: state.praxisSessionId, intent,
    }));
    const durable = await reconcile(database, state.generationIntentId, state.praxisSessionId);
    print("RESULT", { result, durable });
  } finally {
    await database.onModuleDestroy();
  }
}

type Control = {
  reference: string; role: string; name: string; group?: string; semanticPurpose?: string;
  boundary?: { kind: string; name?: string };
};

async function observe(praxisSessionId: string) {
  const observation = await get<{ url: string; semanticPageContext: { controls: Control[] } }>(
    `/praxis-sessions/${praxisSessionId}/observation`,
  );
  return { url: observation.url, controls: observation.semanticPageContext.controls };
}

async function observeUntil(
  praxisSessionId: string,
  ready: (observation: Awaited<ReturnType<typeof observe>>) => boolean,
  label: string,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const observation = await observe(praxisSessionId);
    if (ready(observation)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`FACTUAL_OBSERVATION_TIMEOUT:${label}`);
}

function one(controls: Control[], predicate: (control: Control) => boolean, label: string) {
  const matches = controls.filter(predicate);
  if (matches.length !== 1) throw new Error(`FACTUAL_CONTROL_CARDINALITY:${label}:${matches.length}`);
  return matches[0]!;
}

function exact(concept: string, reference: string) { return { concept, reference, exact: true }; }
function constraints(timeoutMs: number) { return { timeoutMs, allowNewPage: false, allowNonExact: false }; }
function output(reference: string, classification: "public" | "protected", concept: string, name: string, storageName: string) {
  return { reference, classification, target: { concept, role: "value", name, exact: true }, storageName };
}

async function dispatch(praxisSessionId: string, intent: unknown) {
  return post(`/runs/${runId}/operations`, dispatchRunOperationSchema.parse({ praxisSessionId, intent }));
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}
async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}
async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SCRY_API_${response.status}:${text}`);
  return JSON.parse(text) as T;
}

async function counts(database: Database, state: SafeState, authorizationId: string) {
  const result = await database.query<{ adaptive: number; protected: number; authorization: number }>(
    `SELECT
       (SELECT count(*)::int FROM adaptive_operations WHERE session_id=$1 AND authoring_intent->>'intentId'=$2) adaptive,
       (SELECT count(*)::int FROM protected_operations WHERE authoring_session_id=$1 AND authorization_id=$3) protected,
       (SELECT count(*)::int FROM mission_authorizations WHERE id=$3 AND operation_id=$2
          AND praxis_session_id=$1 AND kind='protected_mutation' AND status='approved'
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())) authorization`,
    [state.praxisSessionId, state.generationIntentId, authorizationId],
  );
  return result.rows[0]!;
}

async function reconcile(database: Database, intentId: string, praxisSessionId: string) {
  const adaptive = await database.query<Record<string, unknown>>(
    `SELECT operation_id,state,dispatch_boundary,mutation_outcome,functional_result,privacy_result,
            safe_outcome->>'reasonCode' failure_code
       FROM adaptive_operations WHERE session_id=$1 AND authoring_intent->>'intentId'=$2`,
    [praxisSessionId, intentId],
  );
  const operationId = adaptive.rows[0]?.operation_id;
  const protectedResult = operationId
    ? await database.query<Record<string, unknown>>(
        `SELECT id,operation_id,state,phase,dispatch_state,mutation_outcome,acquisition_state,
                persistence_state,failure_code FROM protected_operations
          WHERE authoring_session_id=$1 AND operation_id=$2`,
        [praxisSessionId, operationId],
      )
    : { rows: [] };
  return { adaptive: adaptive.rows[0] ?? null, protected: protectedResult.rows[0] ?? null };
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function print(kind: string, value: unknown) { console.log(`${kind} ${JSON.stringify(value, null, 2)}`); }
