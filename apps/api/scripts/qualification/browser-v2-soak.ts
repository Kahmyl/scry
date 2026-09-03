import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserCommandV2 } from "@scry/contracts";

import { BrowserCommandRepository } from "../../src/browser-execution/browser-command.repository.js";
import { BrowserExecutionRepository } from "../../src/browser-execution/browser-execution.repository.js";
import { BrowserLifecycleRepository } from "../../src/browser-execution/browser-lifecycle.repository.js";
import { BrowserProtectedValueCipher } from "../../src/browser-execution/protected-value-cipher.js";
import { BrowserV2WorkerEngine } from "../../src/browser-execution/browser-v2-worker-engine.js";
import { Database } from "../../src/infrastructure/database.js";

type Journey = "vitract" | "inventory" | "nested" | "async" | "workspace";
type Context = {
  journey: Journey;
  namespace: string;
  entryUrl: string;
  oracleUrl: string;
  projectId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  flowId: string;
  flowRevisionId: string;
  runId: string;
  sessionId: string;
  ownerGeneration: number;
  protectedInputIds: string[];
  commandOrdinal: number;
};

const databaseUrl = process.env.BROWSER_V2_DATABASE_URL;
const origin = process.env.BROWSER_V2_SOAK_ORIGIN;
const durationMs = Number(process.env.BROWSER_V2_SOAK_DURATION_MS ?? 60 * 60_000);
const intervalMs = Number(process.env.BROWSER_V2_SOAK_INTERVAL_MS ?? 60_000);
const outputPath = process.env.BROWSER_V2_SOAK_OUTPUT;
const expectedEntryTitles: Record<Journey, string> = {
  vitract: "Vitract Preview",
  inventory: "Inventory documentation",
  nested: "Collections",
  async: "Provisioning",
  workspace: "Browser workspace",
};
if (!databaseUrl) throw new Error("BROWSER_V2_DATABASE_URL_REQUIRED");
if (!origin || new URL(origin).origin !== origin)
  throw new Error("BROWSER_V2_SOAK_ORIGIN_REQUIRED");
if (!Number.isSafeInteger(durationMs) || durationMs < 1_000)
  throw new Error("BROWSER_V2_SOAK_DURATION_INVALID");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000)
  throw new Error("BROWSER_V2_SOAK_INTERVAL_INVALID");

process.env.DATABASE_URL = databaseUrl;
process.env.BROWSER_V2_ENABLED = "true";
process.env.BROWSER_V2_PROTECTED_KEY_BASE64 ??= randomBytes(32).toString("base64");
process.env.BROWSER_V2_ARTIFACT_ROOT ??= path.resolve(
  "/private/tmp",
  `browser-v2-soak-${Date.now()}`,
);
process.env.BROWSER_V2_RENDER_VIDEO = "false";

const database = new Database();
const cipher = new BrowserProtectedValueCipher();
const commands = new BrowserCommandRepository(database, cipher);
const effects = new BrowserExecutionRepository(database, cipher);
const lifecycle = new BrowserLifecycleRepository(database);
const engine = new BrowserV2WorkerEngine(commands, effects);
const cohort = `soak-${new Date()
  .toISOString()
  .replace(/[^0-9]/gu, "")
  .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date();
const events: Array<Record<string, unknown>> = [];
let contexts: Context[] = [];

try {
  const workspaceId = await createWorkspace();
  contexts = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      createContext(
        workspaceId,
        (["vitract", "inventory", "nested", "async", "workspace"] as Journey[])[index % 5]!,
        index,
      ),
    ),
  );
  await Promise.all(contexts.map((context) => engine.open(context.sessionId)));
  await Promise.all(contexts.map((context) => completeJourney(context)));
  await verify("journeys_completed");

  const deadline = Date.now() + durationMs;
  let iteration = 0;
  while (Date.now() < deadline) {
    iteration += 1;
    await Promise.all(
      contexts.map(async (context) => {
        const observed = await command(
          context,
          { kind: "navigate", url: context.entryUrl },
          `soak-navigate-${iteration}`,
        );
        if (
          observed.title !== expectedEntryTitles[context.journey] ||
          !Number.isSafeInteger(Number(observed.documentEpoch)) ||
          Number(observed.documentEpoch) < 1
        )
          throw new Error(`soak_navigation_mismatch:${context.namespace}`);
      }),
    );
    await verify(`minute_${iteration}`);
    const waitMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  await Promise.all(
    contexts.map(async (context) => {
      await command(context, { kind: "close" }, "soak-close");
      await effects.finalizeSession(context.sessionId, context.ownerGeneration);
      await lifecycle.markRunTerminal(
        workspaceId,
        context.runId,
        "passed",
        "Completed full journey and remained healthy for the mixed-session soak",
      );
      await lifecycle.publishReport(workspaceId, context.missionId, {
        agentSessionId: context.agentSessionId,
        summary: "Full isolated journey and soak completed",
        safeReport: { journey: context.journey, namespace: context.namespace },
      });
    }),
  );
  await verify("finalized");
  const result = {
    status: "PASS",
    cohort,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    durationRequiredMs: durationMs,
    sessions: contexts.length,
    events,
    artifactRoot: process.env.BROWSER_V2_ARTIFACT_ROOT,
  };
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const result = {
    status: "FAIL",
    cohort,
    startedAt: startedAt.toISOString(),
    failedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    error: error instanceof Error ? error.message : String(error),
    events,
  };
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
} finally {
  await engine.closeAll().catch(() => undefined);
  await database.onModuleDestroy();
}

async function createWorkspace(): Promise<string> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await database.transaction(async (client) => {
    await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
      userId,
      randomUUID(),
      `${cohort}@example.test`,
    ]);
    await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Browser v2 soak',$2)", [
      workspaceId,
      cohort,
    ]);
    await client.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, userId],
    );
  });
  return workspaceId;
}

async function createContext(
  workspaceId: string,
  journey: Journey,
  index: number,
): Promise<Context> {
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const namespace = `${cohort}-${journey}-${index}`;
  await database.query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)", [
    projectId,
    workspaceId,
    `${journey} soak ${index}`,
  ]);
  await database.query(
    "INSERT INTO environments(id,project_id,name,base_origin,disclosure_mode) VALUES($1,$2,$3,$4,'trusted_application_output')",
    [environmentId, projectId, `${journey} fixture`, origin],
  );
  const protectedInputIds: string[] = [];
  if (journey === "vitract") {
    const protectedValue = await commands.createProtectedInput(workspaceId, {
      projectId,
      displayName: "login_password",
      value: "fixture-login-pass",
      expiresInSeconds: 7_200,
      idempotencyKey: `${namespace}-login-password`,
    });
    protectedInputIds.push(protectedValue.protectedValueId);
  }
  const mission = await lifecycle.startMission(workspaceId, {
    projectId,
    title: `${journey} mixed soak`,
    instruction:
      "Complete the isolated fixture journey and remain available for soak observations.",
    idempotencyKey: `${namespace}-mission`,
    provider: "codex",
    model: "deterministic-soak-driver",
    settings: { cohort },
  });
  const objective = await lifecycle.createObjective(workspaceId, mission.missionId, {
    agentSessionId: mission.agentSessionId,
    title: "Complete journey",
    description: "Complete exact effects and verify identity",
    completionCriteria: { exactEffects: true },
    objectiveOrder: 0,
    idempotencyKey: `${namespace}-objective`,
  });
  const flow = await lifecycle.createFlow(workspaceId, mission.missionId, {
    agentSessionId: mission.agentSessionId,
    name: "Fixture journey",
    purpose: "Exercise the browser runtime",
    definition: { journey },
    idempotencyKey: `${namespace}-flow`,
  });
  const limits =
    journey === "vitract"
      ? { authenticationCommitLimit: 2, businessCommitLimit: 1 }
      : journey === "async" || journey === "workspace"
        ? { authenticationCommitLimit: 0, businessCommitLimit: 2 }
        : { authenticationCommitLimit: 0, businessCommitLimit: 1 };
  const started = await lifecycle.startRun(workspaceId, {
    projectId,
    missionId: mission.missionId,
    objectiveId: objective.objectiveId,
    agentSessionId: mission.agentSessionId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    environmentId,
    idempotencyKey: `${namespace}-run`,
    ...limits,
    protectedInputIds,
  });
  return {
    journey,
    namespace,
    entryUrl: `${origin}/${journey}/${namespace}/`,
    oracleUrl: `${origin}/__oracle/${journey}/${namespace}`,
    projectId,
    missionId: mission.missionId,
    objectiveId: objective.objectiveId,
    agentSessionId: mission.agentSessionId,
    flowId: flow.flowId,
    flowRevisionId: flow.flowRevisionId,
    runId: started.runId,
    sessionId: started.browserSessionId,
    ownerGeneration: 1,
    protectedInputIds,
    commandOrdinal: 0,
  };
}

async function completeJourney(context: Context): Promise<void> {
  if (context.journey === "vitract") return vitract(context);
  if (context.journey === "inventory") return inventory(context);
  if (context.journey === "nested") return nested(context);
  if (context.journey === "async") return asynchronous(context);
  return workspace(context);
}

async function vitract(context: Context): Promise<void> {
  const start = await command(
    context,
    { kind: "navigate", url: context.entryUrl },
    "navigate-entry",
  );
  await command(
    context,
    { kind: "fill", reference: control(start, "Email"), publicValue: "operator@example.test" },
    "fill-email",
  );
  await command(
    context,
    {
      kind: "fill",
      reference: control(start, "Password"),
      protectedValueId: context.protectedInputIds[0],
    },
    "fill-password",
  );
  const login = await commit(context, control(start, "Log in"), "authentication", "login-effect");
  await publish(
    context,
    login,
    [{ key: "authenticated", path: ["state"], classification: "public" }],
    "publish-login",
  );
  await determine(context, login.effectId, "owned_login_response", "determine-login");
  const loginSettled = await command(context, { kind: "observe" }, "observe-after-login");
  const applications = await command(
    context,
    { kind: "click", reference: control(loginSettled, "Applications") },
    "open-applications",
  );
  const credential = await commit(
    context,
    control(applications, "Add credentials"),
    "authentication",
    "credential-effect",
  );
  const credentialOutputs = await publish(
    context,
    credential,
    [
      {
        key: "credentialId",
        path: ["result", "application", "credential_id"],
        classification: "public",
      },
      {
        key: "clientId",
        path: ["result", "application", "client_identifier"],
        classification: "public",
      },
      { key: "clientSecret", path: ["result", "grants", 0, "value"], classification: "protected" },
    ],
    "publish-credential",
  );
  await determine(
    context,
    credential.effectId,
    "exact_credential_identity",
    "determine-credential",
  );
  const credentialSettled = await command(
    context,
    { kind: "observe" },
    "observe-after-credential",
  );
  const docs = await command(
    context,
    { kind: "click", reference: control(credentialSettled, "API documentation") },
    "open-docs",
  );
  await command(
    context,
    {
      kind: "fill",
      reference: control(docs, "Client ID"),
      publicValue: String(publicOutputs(credentialOutputs).clientId),
    },
    "fill-client-id",
  );
  await command(
    context,
    {
      kind: "fill",
      reference: control(docs, "Client secret"),
      protectedValueId: protectedReferences(credentialOutputs).clientSecret,
    },
    "fill-client-secret",
  );
  const order = await commit(context, control(docs, "Create order"), "business", "order-effect");
  const orderOutputs = await publish(
    context,
    order,
    [
      { key: "orderId", path: ["data", "order_id"], classification: "public" },
      { key: "completed", path: ["data", "state"], classification: "public" },
    ],
    "publish-order",
  );
  await determine(context, order.effectId, "exact_order_identity", "determine-order");
  const orderSettled = await command(context, { kind: "observe" }, "observe-after-order");
  const retrieve = await command(
    context,
    { kind: "click", reference: control(orderSettled, "Retrieve order") },
    "open-retrieve",
  );
  await command(
    context,
    {
      kind: "fill",
      reference: control(retrieve, "Order ID"),
      publicValue: String(publicOutputs(orderOutputs).orderId),
    },
    "fill-order-id",
  );
  const found = await command(
    context,
    { kind: "click", reference: control(retrieve, "Retrieve") },
    "retrieve-order",
  );
  if (
    !String(found.text).includes(String(publicOutputs(orderOutputs).orderId)) ||
    !String(found.text).includes("completed")
  )
    throw new Error(`vitract_verification_failed:${context.namespace}`);
}

async function inventory(context: Context): Promise<void> {
  const docs = await command(
    context,
    { kind: "navigate", url: context.entryUrl },
    "navigate-entry",
  );
  const consolePage = await command(
    context,
    { kind: "click", reference: control(docs, "Open inventory console") },
    "open-console",
  );
  const created = await commit(
    context,
    control(consolePage, "Create stock item"),
    "business",
    "create-stock-effect",
  );
  const outputs = await publish(
    context,
    created,
    [
      { key: "stockId", path: ["record", "stock_id"], classification: "public" },
      { key: "sku", path: ["record", "sku"], classification: "public" },
    ],
    "publish-stock",
  );
  await determine(context, created.effectId, "exact_stock_identity", "determine-stock");
  const observed = await command(context, { kind: "observe" }, "observe-console");
  await command(
    context,
    {
      kind: "fill",
      reference: control(observed, "Stock ID"),
      publicValue: String(publicOutputs(outputs).stockId),
    },
    "fill-stock-id",
  );
  const found = await command(
    context,
    { kind: "click", reference: control(observed, "Retrieve stock item") },
    "retrieve-stock",
  );
  if (
    !String(found.text).includes(String(publicOutputs(outputs).stockId)) ||
    !String(found.text).includes(String(publicOutputs(outputs).sku))
  )
    throw new Error(`inventory_verification_failed:${context.namespace}`);
}

async function nested(context: Context): Promise<void> {
  const page = await command(
    context,
    { kind: "navigate", url: context.entryUrl },
    "navigate-entry",
  );
  const created = await commit(
    context,
    control(page, "Create resource"),
    "business",
    "create-resource-effect",
  );
  const outputs = await publish(
    context,
    created,
    [
      {
        key: "resourceId",
        path: ["envelope", "candidates", 1, "uuid"],
        classification: "public",
      },
      { key: "marker", path: ["envelope", "candidates", 1, "marker"], classification: "public" },
    ],
    "publish-resource",
  );
  await determine(context, created.effectId, "marker_correlated_identity", "determine-resource");
  const observed = await command(context, { kind: "observe" }, "observe-resource-page");
  await command(
    context,
    {
      kind: "fill",
      reference: control(observed, "Resource ID"),
      publicValue: String(publicOutputs(outputs).resourceId),
    },
    "fill-resource-id",
  );
  const found = await command(
    context,
    { kind: "click", reference: control(observed, "Retrieve resource") },
    "retrieve-resource",
  );
  if (!String(found.text).includes(String(publicOutputs(outputs).marker)))
    throw new Error(`nested_verification_failed:${context.namespace}`);
}

async function asynchronous(context: Context): Promise<void> {
  const page = await command(
    context,
    { kind: "navigate", url: context.entryUrl },
    "navigate-entry",
  );
  const submitted = await commit(
    context,
    control(page, "Submit provisioning"),
    "business",
    "submit-provision-effect",
  );
  await publish(
    context,
    submitted,
    [{ key: "jobId", path: ["job", "id"], classification: "public" }],
    "publish-job",
  );
  await determine(context, submitted.effectId, "documented_job_identity", "determine-submit");
  let observed = await command(context, { kind: "observe" }, "observe-after-submit");
  for (let poll = 1; poll <= 5 && !hasRegion(observed, "Provisioned access"); poll += 1) {
    observed = await command(
      context,
      { kind: "click", reference: control(observed, "Check documented status") },
      `poll-${poll}`,
    );
  }
  if (!hasRegion(observed, "Provisioned access"))
    throw new Error(`async_never_ready:${context.namespace}`);
  const dom = await command(
    context,
    {
      kind: "capture_dom",
      effectId: submitted.effectId,
      reference: region(observed, "Provisioned access"),
    },
    "capture-provisioned-access",
  );
  const domCapture = capture(dom);
  const access = await command(
    context,
    {
      kind: "publish_capture",
      effectId: submitted.effectId,
      captureId: domCapture.captureId,
      selections: [
        { key: "accessToken", path: ["children", 1, "text"], classification: "protected" },
      ],
    },
    "publish-provisioned-access",
  );
  const current = await command(context, { kind: "observe" }, "observe-ready");
  await command(
    context,
    {
      kind: "fill",
      reference: control(current, "Access token"),
      protectedValueId: protectedReferences(access).accessToken,
    },
    "fill-access-token",
  );
  const activated = await commit(
    context,
    control(current, "Activate workspace"),
    "business",
    "activate-workspace-effect",
  );
  await publish(
    context,
    activated,
    [{ key: "state", path: ["state"], classification: "public" }],
    "publish-activation",
  );
  await determine(
    context,
    activated.effectId,
    "exact_workspace_activation",
    "determine-activation",
  );
  const activationSettled = await command(
    context,
    { kind: "observe" },
    "observe-after-activation",
  );
  if (!String(activationSettled.text).includes("Activated"))
    throw new Error(`async_activation_failed:${context.namespace}`);
}

async function workspace(context: Context): Promise<void> {
  const page = await command(
    context,
    { kind: "navigate", url: context.entryUrl },
    "navigate-entry",
  );
  const created = await commit(
    context,
    control(page, "Create workspace"),
    "business",
    "create-workspace-effect",
  );
  await publish(
    context,
    created,
    [{ key: "accepted", path: ["ok"], classification: "public" }],
    "publish-create-workspace",
  );
  await determine(
    context,
    created.effectId,
    "owned_submission_response",
    "determine-create-workspace",
  );
  const createdSettled = await command(
    context,
    { kind: "observe" },
    "observe-after-workspace-create",
  );
  const dom = await command(
    context,
    {
      kind: "capture_dom",
      effectId: created.effectId,
      reference: region(createdSettled, "One-time workspace result"),
    },
    "capture-workspace-result",
  );
  const domCapture = capture(dom);
  const recovered = await command(
    context,
    {
      kind: "publish_capture",
      effectId: created.effectId,
      captureId: domCapture.captureId,
      selections: [
        { key: "recoveryCode", path: ["children", 1, "text"], classification: "protected" },
      ],
    },
    "publish-workspace-result",
  );
  const current = await command(context, { kind: "observe" }, "observe-workspace");
  await command(
    context,
    {
      kind: "fill",
      reference: control(current, "Recovery code"),
      protectedValueId: protectedReferences(recovered).recoveryCode,
    },
    "fill-recovery-code",
  );
  const confirmed = await commit(
    context,
    control(current, "Confirm workspace"),
    "business",
    "confirm-workspace-effect",
  );
  await publish(
    context,
    confirmed,
    [{ key: "verified", path: ["verified"], classification: "public" }],
    "publish-confirmation",
  );
  await determine(
    context,
    confirmed.effectId,
    "exact_workspace_confirmation",
    "determine-confirmation",
  );
  const confirmationSettled = await command(
    context,
    { kind: "observe" },
    "observe-after-confirmation",
  );
  if (!String(confirmationSettled.text).includes("Workspace verified"))
    throw new Error(`workspace_confirmation_failed:${context.namespace}`);
}

async function command(
  context: Context,
  value: BrowserCommandV2,
  label: string,
): Promise<Record<string, unknown>> {
  context.commandOrdinal += 1;
  const key = `${label}-${context.commandOrdinal}`;
  const submitted = await commands.submit(context.sessionId, {
    idempotencyKey: key.length >= 8 ? key : key.padEnd(8, "-"),
    command: value,
  });
  const claimed = await commands.claim(submitted.commandId);
  if (!claimed?.claim_token) throw new Error(`soak_command_claim_failed:${label}`);
  try {
    const result = await engine.execute(context.sessionId, claimed.safe_input);
    await commands.complete(claimed.id, claimed.claim_token, result);
    return result;
  } catch (error) {
    await commands.fail(claimed.id, claimed.claim_token, error);
    throw new Error(
      `soak_command_failed:${context.journey}:${label}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function commit(
  context: Context,
  reference: string,
  effectClass: "authentication" | "business",
  key: string,
) {
  const result = await command(
    context,
    {
      kind: "commit",
      reference,
      effectClass,
      effectIdempotencyKey: `${context.namespace}-${key}`,
      intentSummary: key,
      timeoutMs: 10_000,
    },
    key,
  );
  return {
    effectId: String(result.effectId),
    capture: capture(result),
    successor: result.successorObservation as Record<string, unknown>,
  };
}

async function publish(
  context: Context,
  effect: { effectId: string; capture: { captureId: string } },
  selections: Array<{
    key: string;
    path: Array<string | number>;
    classification: "public" | "protected";
  }>,
  key: string,
) {
  const admittedSelections = selections.map((selection) =>
    selection.classification === "public"
      ? { ...selection, semantic: selection.key }
      : { ...selection, classification: "protected" as const },
  );
  return command(
    context,
    {
      kind: "publish_capture",
      effectId: effect.effectId,
      captureId: effect.capture.captureId,
      selections: admittedSelections,
    },
    key,
  );
}

async function determine(context: Context, effectId: string, source: string, key: string) {
  await command(context, { kind: "determine", effectId, outcome: "applied", source }, key);
}

function capture(value: Record<string, unknown>): { captureId: string } {
  const result = value.capture as { captureId?: unknown } | undefined;
  if (!result || typeof result.captureId !== "string") throw new Error("soak_capture_missing");
  return { captureId: result.captureId };
}

function control(value: Record<string, unknown>, name: string): string {
  const found = (value.controls as Array<{ reference: string; name: string }> | undefined)?.find(
    (item) => item.name === name,
  );
  if (!found) throw new Error(`soak_control_missing:${name}`);
  return found.reference;
}

function region(value: Record<string, unknown>, name: string): string {
  const found = (value.regions as Array<{ reference: string; name: string }> | undefined)?.find(
    (item) => item.name === name,
  );
  if (!found) throw new Error(`soak_region_missing:${name}`);
  return found.reference;
}

function hasRegion(value: Record<string, unknown>, name: string): boolean {
  return Boolean(
    (value.regions as Array<{ name: string }> | undefined)?.some((item) => item.name === name),
  );
}

function publicOutputs(value: Record<string, unknown>): Record<string, unknown> {
  return value.publicOutputs as Record<string, unknown>;
}

function protectedReferences(value: Record<string, unknown>): Record<string, string> {
  return value.protectedReferences as Record<string, string>;
}

async function verify(phase: string): Promise<void> {
  const oracle = await Promise.all(
    contexts.map(async (context) => ({
      context,
      value: (await fetch(context.oracleUrl).then((response) => response.json())) as {
        mutations: Record<string, number>;
        reads: number;
        statusPolls: number;
      },
    })),
  );
  for (const { context, value } of oracle) {
    const expected =
      context.journey === "vitract"
        ? { login: 1, credential: 1, order: 1 }
        : context.journey === "inventory"
          ? { stock: 1 }
          : context.journey === "nested"
            ? { resource: 1 }
            : context.journey === "async"
              ? { submit: 1, activate: 1 }
              : { create: 1, confirm: 1 };
    if (JSON.stringify(value.mutations) !== JSON.stringify(expected))
      throw new Error(
        `soak_effect_mismatch:${phase}:${context.namespace}:${JSON.stringify(value.mutations)}`,
      );
    if (["vitract", "inventory", "nested"].includes(context.journey) && value.reads !== 1)
      throw new Error(`soak_read_mismatch:${phase}:${context.namespace}:${value.reads}`);
    if (context.journey === "async" && (value.reads !== 3 || value.statusPolls !== 3))
      throw new Error(
        `soak_poll_mismatch:${phase}:${context.namespace}:${value.reads}:${value.statusPolls}`,
      );
  }
  const ids = contexts.map((context) => context.sessionId);
  const state = await database.query<{
    active: string;
    unknown: string;
    pending: string;
    effects: string;
    completeEvidence: string;
  }>(
    `SELECT
       count(DISTINCT s.id) FILTER (WHERE s.state='active')::text AS active,
       count(DISTINCT e.id) FILTER (WHERE e.mutation_outcome='unknown')::text AS unknown,
       count(DISTINCT e.id) FILTER (WHERE e.mutation_outcome='pending')::text AS pending,
       count(DISTINCT e.id)::text AS effects,
       count(DISTINCT ev.session_id) FILTER (WHERE ev.state='complete')::text AS "completeEvidence"
     FROM browser_execution_sessions s
     LEFT JOIN browser_effects e ON e.session_id=s.id
     LEFT JOIN browser_evidence_streams ev ON ev.session_id=s.id
     WHERE s.id=ANY($1::uuid[])`,
    [ids],
  );
  const snapshot = state.rows[0]!;
  if (Number(snapshot.unknown) !== 0 || Number(snapshot.pending) !== 0)
    throw new Error(`soak_unresolved_effect:${phase}:${JSON.stringify(snapshot)}`);
  events.push({
    phase,
    at: new Date().toISOString(),
    active: Number(snapshot.active),
    effects: Number(snapshot.effects),
    completeEvidence: Number(snapshot.completeEvidence),
  });
  process.stdout.write(`${JSON.stringify(events.at(-1))}\n`);
}
