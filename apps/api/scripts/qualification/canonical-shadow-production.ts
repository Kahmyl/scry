/** Fresh production topology; only the external provider network is substituted. */
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  configureShadowBrowserNetwork,
  startShadowVitractNetwork,
} from "./shadow-vitract-network.js";
import {
  deriveRepositorySourceIdentity,
  sourceIdentityEnvironment,
} from "../../../../scripts/source-identity.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runId = process.argv[2] ?? `production-development-${Date.now()}`;
if (!/^production-[a-z0-9-]+$/.test(runId)) throw new Error("SHADOW_RUN_ID_INVALID");
const directory = path.join(root, "artifacts/production-architecture-20260830", runId);
await mkdir(directory, { recursive: false });
const source = deriveRepositorySourceIdentity(root);
const schema = execFileSync(process.execPath, ["scripts/schema-fingerprint.mjs"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const databaseName = `scry_shadow_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = `postgres://scry:scry-local@127.0.0.1:54329/${databaseName}`;
const admin = new pg.Client({
  connectionString: "postgres://scry:scry-local@127.0.0.1:54329/postgres",
});
await admin.connect();
await admin.query(`CREATE DATABASE ${databaseName}`);
await admin.end();
const network = await startShadowVitractNetwork();
const redisPort = await freePort(),
  apiPort = await freePort(),
  mcpPort = await freePort(),
  webPort = await freePort();
Object.assign(process.env, sourceIdentityEnvironment(source), {
  DATABASE_URL: databaseUrl,
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  SCRY_RELEASE_ID: "canonical-shadow-production",
  SCRY_SCHEMA_FINGERPRINT: schema,
  SCRY_SERVICE_TOKEN: randomBytes(32).toString("hex"),
  SCRY_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  VEIL_ADMISSION_KEY: randomBytes(32).toString("hex"),
  ARTIFACT_ROOT: path.join(directory, "runtime"),
  SCRY_SHADOW_PROXY_URL: network.proxyUrl,
  SCRY_API_BASE_URL: `http://127.0.0.1:${apiPort}/api`,
  SCRY_PUBLIC_API_BASE_URL: `http://127.0.0.1:${apiPort}/api`,
  MCP_PORT: String(mcpPort),
  MCP_HOST: "127.0.0.1",
  SCRY_MCP_PROFILE: "general",
  SUPABASE_URL: "",
  NODE_ENV: "test",
});
const children: ChildProcess[] = [];
const childLogs = new Map<string, string>();
let app: NestFastifyApplication | undefined;
let closeOwner: (() => Promise<unknown>) | undefined;
const stages: Record<string, unknown> = {};
const record = async (stage: string, evidence: unknown) => {
  stages[stage] = evidence;
  await writeFile(
    path.join(directory, "evidence.json"),
    JSON.stringify(
      { runId, source, schema, databaseName, stages, counts: network.counts() },
      null,
      2,
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ stage, ...(stage === "failure" ? { evidence } : { counts: network.counts() }) })}\n`,
  );
};
function child(
  name: string,
  command: string,
  args: string[],
  cwd = root,
  extra: NodeJS.ProcessEnv = {},
) {
  const processChild = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(processChild);
  childLogs.set(name, "");
  for (const stream of [processChild.stdout, processChild.stderr])
    stream?.on("data", (chunk) =>
      childLogs.set(name, (childLogs.get(name)! + chunk.toString()).slice(-100_000)),
    );
  return processChild;
}
try {
  execFileSync("pnpm", ["--filter", "@scry/api", "exec", "tsx", "scripts/migrate.ts"], {
    cwd: root,
    env: process.env,
    stdio: "pipe",
  });
  child("redis", "redis-server", [
    "--bind",
    "127.0.0.1",
    "--port",
    String(redisPort),
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  configureShadowBrowserNetwork(network.proxyUrl);
  const { AppModule } = await import("../../src/app.module.js");
  const { Database, OperationalEvents, installApiRequestObservability } =
    await import("../../src/infrastructure/index.js");
  const { ReleaseAdmissionService } =
    await import("../../src/runtime/services/release-admission.service.js");
  const adapter = new FastifyAdapter();
  app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ["error", "warn"],
    abortOnError: false,
  });
  installApiRequestObservability(adapter.getInstance(), app.get(OperationalEvents));
  app.enableCors();
  await app.listen(apiPort, "127.0.0.1");
  child(
    "worker",
    "pnpm",
    ["exec", "tsx", "scripts/qualification/shadow-production-worker.ts"],
    path.join(root, "apps/api"),
  );
  await until(
    async () => (await app!.get(ReleaseAdmissionService).status()).ready,
    "RELEASE_READY",
  );
  child("mcp", "pnpm", ["exec", "tsx", "src/http.ts"], path.join(root, "apps/mcp"));
  child(
    "web",
    "pnpm",
    ["exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    path.join(root, "apps/web"),
    {
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      VITE_SUPABASE_URL: `http://127.0.0.1:${apiPort}/shadow-auth`,
      VITE_SUPABASE_PUBLISHABLE_KEY: "shadow-no-external-auth",
    },
  );
  await until(async () => (await fetch(`http://127.0.0.1:${mcpPort}/health`)).ok, "MCP_READY");
  await until(async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok, "WEB_READY");
  await record("J0", {
    status: "PASS",
    admission: await app.get(ReleaseAdmissionService).status(),
    apiPort,
    mcpPort,
    webPort,
    redisPort,
  });
  const database = app.get(Database);
  const { IdentityRepository } = await import("../../src/auth/repositories/identity.repository.js");
  const { McpTokenRepository } =
    await import("../../src/auth/repositories/mcp-token.repository.js");
  const { Q5ScopeBootstrapRepository } =
    await import("../../src/runtime/repositories/q5-scope-bootstrap.repository.js");
  const { bootstrapQ5CanonicalScope } = await import("../../src/runtime/q5-scope-bootstrap.js");
  const { ProjectConfigurationRepository } =
    await import("../../src/access/repositories/project-configuration.repository.js");
  const { VitractCredentialIssuancePreparationService } =
    await import("../../src/adaptive-sessions/services/vitract-credential-issuance-preparation.js");
  const { OrchestrationService } = await import("../../src/orchestration/orchestration.service.js");
  const principal = await app
    .get(IdentityRepository)
    .provisionUser(randomUUID(), `shadow-${randomUUID()}@example.test`);
  const token = await app.get(McpTokenRepository).create(principal, runId);
  async function api(route: string, body?: unknown): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${route}:${response.status}:${JSON.stringify(result)}`);
    return result;
  }
  async function blindDiscovery(praxisSessionId: string): Promise<any> {
    const reader = spawn(
      process.execPath,
      [path.join(root, "apps/api/scripts/qualification/blind-semantic-reader.mjs")],
      {
        cwd: directory,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    reader.stdout.on("data", (chunk) => (output += chunk));
    reader.stderr.on("data", (chunk) => (error += chunk));
    reader.stdin.end(
      JSON.stringify({
        endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
        token: token.token,
        praxisSessionId,
      }),
    );
    const status = await new Promise<number | null>((resolve) => reader.once("exit", resolve));
    if (status !== 0) throw new Error(`BLIND_MCP_DISCOVERY_FAILED:${error}`);
    return JSON.parse(output);
  }
  const facts = {
    sourceCommit: source.commitSha,
    sourceManifest: source.manifestSha256,
    schemaFingerprint: schema,
    migrationIdentity: createHash("sha256")
      .update(
        await readFile(path.join(root, "apps/api/migrations/canonical-execution-authority.sql")),
      )
      .digest("hex"),
  };
  const store = new Q5ScopeBootstrapRepository(database, principal.workspaceId);
  const bootstrap = await bootstrapQ5CanonicalScope(store, facts);
  assert.equal(bootstrap.status, "credential_issuance_required");
  if (bootstrap.status !== "credential_issuance_required") throw new Error("FRESH_SCOPE_REQUIRED");
  const scope = bootstrap;
  const configuration = new ProjectConfigurationRepository(database);
  const email = await configuration.createCredential(principal, scope.projectId, {
    name: "Shadow login email",
    value: "shadow@example.test",
  });
  const password = await configuration.createCredential(principal, scope.projectId, {
    name: "Shadow login password",
    value: randomBytes(24).toString("hex"),
  });
  const composition = app.get(VitractCredentialIssuancePreparationService);
  const applicationResourceScope = `shadow-${randomUUID()}`;
  const credentialName = `Shadow ${runId}`;
  const lifecycle = await composition.createLifecycle(principal, {
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    loginEmailReferenceId: email.id,
    loginPasswordReferenceId: password.id,
    applicationResourceScope,
    credentialName,
    idempotencyKey: runId,
    distinctMissionReason: "Fresh isolated production architecture qualification",
    distinctMissionAuthority: {
      confirmedUserAuthorized: true,
      selection: "start_distinct_mission",
      source: "current_request_explicit",
    },
  });
  closeOwner = () => composition.closePrepared(principal, lifecycle, `${runId}-close`);
  await record("J1", {
    status: "PASS",
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    lifecycle,
  });
  await composition.prepareObservedSurface(principal, {
    lifecycle,
    loginEmailReferenceId: email.id,
    loginPasswordReferenceId: password.id,
    applicationResourceScope,
    idempotencyKey: runId,
  });
  const reserved = await composition.reserveObserved(principal, {
    lifecycle,
    credentialName,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  await record("J2", {
    status: "PASS",
    protectedOperationId: reserved.protectedOperationId,
    preparedExecutionCapabilityId: reserved.preparedExecutionCapabilityId,
  });
  const context = {
    missionId: lifecycle.missionId,
    objectiveId: lifecycle.objectiveId,
    agentSessionId: lifecycle.agentSessionId,
  };
  const draft = await api(`/flow-drafts/${lifecycle.flowDraftId}`);
  const publication = await api(`/flow-drafts/${lifecycle.flowDraftId}/publish`, {
    ...context,
    expectedVersion: draft.version,
    visibility: "mission_local",
    purpose: "primary",
    reason: "Production shadow durable Run across three owners",
    idempotencyKey: `${runId}-publish`,
  });
  const runReceipt = await api(`/projects/${scope.projectId}/runs`, {
    ...context,
    environmentId: scope.environmentId,
    flowRevisionId: publication.revisionId,
    praxisSessionId: lifecycle.authoringSessionId,
    idempotencyKey: `${runId}-run`,
  });
  assert.equal(typeof runReceipt.runId, "string", JSON.stringify(runReceipt));
  const run = { id: runReceipt.runId };
  await record("runOpened", { runId: run.id, publication });
  await record("J3", { status: "PASS", mechanicalAdmission: true, ownerApprovalRequired: false });
  const { MissionFlowAuthoringService } =
    await import("../../src/adaptive-sessions/mission-flow-authoring.service.js");
  const authoring = app.get(MissionFlowAuthoringService);
  const dispatched = await api(`/runs/${run.id}/prepared-operations`, {
    ...reserved.immutableResume,
    praxisSessionId: lifecycle.authoringSessionId,
  });
  assert.equal(dispatched.state, "completed", JSON.stringify(dispatched));
  assert.equal(network.counts().issuance, 1);
  await record("J4", { status: "PASS", dispatched });
  const prepared = await bootstrapQ5CanonicalScope(store, facts);
  assert.equal(prepared.status, "prepared");
  await record("J5", { status: "PASS", prepared });
  await closeOwner();
  closeOwner = undefined;
  const durableIssuance = await blindDiscovery(lifecycle.authoringSessionId);
  assert(durableIssuance.semantics.observation.contracts.length > 0);
  assert(durableIssuance.semantics.observation.contracts.every((item: any) => !item.interaction));
  async function freshOwner(label: string) {
    const owner = await authoring.start(principal, {
      ...context,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      flowDraftId: lifecycle.flowDraftId,
      objective: "Create and retrieve one shadow order using canonical generated values",
      allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
      initialProtectedReferenceIds: [],
      turnBudgets: { maxOperations: 20, maxDurationMs: 900_000 },
      correlationId: randomUUID(),
      idempotencyKey: `${runId}-${label}`,
      protection: "protected",
    });
    closeOwner = () => authoring.close(principal, owner.id, `${runId}-${label}-close`);
    await api(`/runs/${run.id}/praxis-session`, {
      praxisSessionId: owner.id,
      idempotencyKey: `${runId}-${label}-attach`,
    });
    let turn: any = await authoring.advance(principal, owner.id, {
      kind: "intents",
      intents: [
        {
          intentId: `${runId}-${label}-docs`,
          objectiveId: lifecycle.objectiveId,
          flowDraftId: lifecycle.flowDraftId,
          action: { kind: "navigate", url: "https://preview-api.vitract.com/api/docs/partner-api" },
          expectedEffect: { kind: "none" },
          constraints: { timeoutMs: 30_000, allowNewPage: false, allowNonExact: false },
          authorization: { kind: "live_read" },
          protectedInputReferences: [],
        },
      ],
      budgets: { maxOperations: 1, maxDurationMs: 60_000 },
      idempotencyKey: `${runId}-${label}-navigate`,
    });
    await until(async () => {
      if (turn.state === "pending")
        turn = await authoring.advance(principal, owner.id, {
          kind: "continue",
          turnId: turn.turnId,
          budgets: { maxOperations: 1, maxDurationMs: 60_000 },
          idempotencyKey: `${runId}-${label}-poll-${randomUUID()}`,
        });
      if (turn.state !== "pending" && turn.state !== "completed")
        throw new Error(`DOCS_NAVIGATION_${turn.state}`);
      return turn.state === "completed";
    }, "DOCS_NAVIGATION");
    return owner;
  }
  const ownerB = await freshOwner("create-owner");
  const discoveryB = await blindDiscovery(ownerB.id);
  const contracts = discoveryB.semantics.observation.contracts;
  const create = contracts.find(
    (item: any) =>
      item.revision.facts.operation.semantics.dispatch === "mutation" &&
      item.revision.facts.response.continuation === "read_only_retrieve",
  );
  assert(create?.interaction, "CREATE_SEMANTICS_AND_CURRENT_INTERACTION_REQUIRED");
  await record("J7", { status: "PASS", ownerId: ownerB.id, contractCount: contracts.length });
  await record("J8", { status: "PASS", repositoryBlindClient: true, durableIssuance, discoveryB });
  async function reserveFromDiscovery(
    ownerId: string,
    contract: any,
    discovery: any,
    continuationReference?: string,
  ) {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const values = [];
    for (const field of contract.revision.facts.inputs) {
      if (
        continuationReference &&
        field.key === contract.revision.facts.retrieval?.canonicalTargetFieldKey
      )
        continue;
      let source: any;
      if (field.syntheticInput)
        source = {
          kind: "synthetic_protected",
          declaration: { ...field.syntheticInput, semantic: field.key },
        };
      else {
        const asset = discovery.values.result.items.find(
          (item: any) => item.canonicalOutputKey === field.key && item.state === "active",
        );
        assert(asset, `MCP_VALUE_ASSET_REQUIRED:${field.key}`);
        source = {
          kind: asset.classification === "protected" ? "generated_protected" : "generated_safe",
          valueAssetId: asset.valueAssetId,
        };
      }
      values.push({
        canonicalFieldKey: field.key,
        targetReference: contract.interaction.inputControlReferences[field.key],
        presentationClass: field.acceptedPresentations[0],
        source,
      });
    }
    return authoring.reservePreparedOperation(principal, ownerId, {
      ...context,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      publicOperationId: `shadow-${randomUUID()}`,
      operationContractRevisionId: contract.revision.id,
      operationContractRevisionDigest: contract.revision.digest,
      runtimeInteractionCapabilityId: contract.interaction.id,
      values,
      continuationReference,
      expectedOutputs: contract.revision.facts.response.outputs.map(
        ({ key, classification }: any) => ({ key, classification }),
      ),
      expiresAt,
    });
  }
  async function dispatchPrepared(ownerId: string, reservation: any) {
    const immutable = {
      protectedOperationId: reservation.protectedOperationId,
      preparedExecutionCapabilityId: reservation.preparedExecutionCapabilityId,
      publicOperationId: reservation.publicOperationId,
    };
    return api(`/runs/${run.id}/prepared-operations`, { ...immutable, praxisSessionId: ownerId });
  }
  const createReservation = await reserveFromDiscovery(ownerB.id, create, discoveryB);
  const createResult = await dispatchPrepared(ownerB.id, createReservation);
  assert.equal(createResult.state, "completed", JSON.stringify(createResult));
  assert.equal(network.counts().create, 1);
  assert.equal(network.counts().authenticatedRequests, 1);
  await record("J6", {
    status: "PASS",
    mechanism:
      "Per-request protected credential presentation through exact ValueUseGrants/Veil, externally validated during Create",
    standaloneAuthenticationEndpoint: false,
  });
  await record("J9", { status: "PASS", createResult });
  const checkpoints = await authoring.listMissionOperationCheckpoints(principal, ownerB.id);
  await record("J10", { status: "PASS", checkpoints });
  await closeOwner!();
  closeOwner = undefined;
  const ownerC = await freshOwner("retrieve-owner");
  const discoveryC = await blindDiscovery(ownerC.id);
  const retrieve = discoveryC.semantics.observation.contracts.find(
    (item: any) => item.revision.facts.operation.semantics.dispatch === "read_only",
  );
  assert(retrieve?.interaction);
  const checkpoint = checkpoints.checkpoints.find(
    (item: any) => item.sourceProtectedOperationId === createReservation.protectedOperationId,
  );
  assert(checkpoint);
  const identityKey = create.revision.facts.response.outputs.find(
    (item: any) => item.identityRole === "resource_identity",
  ).key;
  const identity = checkpoint.persistedReferences[identityKey] as { valueAssetId: string };
  assert(identity?.valueAssetId);
  const retrieveReservation = await reserveFromDiscovery(
    ownerC.id,
    retrieve,
    discoveryC,
    checkpoint.id,
  );
  await record("J11", { status: "PASS", continuationReference: checkpoint.id });
  const retrieveResult = await dispatchPrepared(ownerC.id, retrieveReservation);
  assert.equal(retrieveResult.state, "completed", JSON.stringify(retrieveResult));
  assert.equal(network.counts().retrieve, 1);
  await record("J12", { status: "PASS", retrieveResult });
  const finalCheckpoints = await authoring.listMissionOperationCheckpoints(principal, ownerC.id);
  const finalCheckpoint = finalCheckpoints.checkpoints.find(
    (item: any) => item.id === checkpoint.id,
  );
  assert.equal(finalCheckpoint?.identityMatches, true);
  await record("J13", { status: "PASS", finalCheckpoint });
  await closeOwner!();
  closeOwner = undefined;
  const finalizedRun = await api(`/runs/${run.id}/finalize`, {
    praxisSessionId: ownerC.id,
    outcome: "passed",
    reason:
      "Canonical exact identity equality across issuance/Create/Retrieve owners; protected channels remain suppressed",
    idempotencyKey: `${runId}-finalize-run`,
  });
  assert.equal(finalizedRun.state, "passed");
  await api(`/runs/${run.id}/classification`, {
    missionId: lifecycle.missionId,
    agentSessionId: lifecycle.agentSessionId,
    role: "accepted",
    reason: "One issuance, one Create, one exact Retrieve with canonical identity equality",
  });
  await api(`/objectives/${lifecycle.objectiveId}/evidence`, {
    missionId: lifecycle.missionId,
    agentSessionId: lifecycle.agentSessionId,
    runId: run.id,
    artifactIds: [],
    conclusion:
      "Protected output persistence, exact consumer grants and Chronicle identity equality proven by durable Run evidence",
  });
  // Accepted Run evidence already terminalizes the Objective. Keep the reporting
  // agent active until publication, as required by the production lifecycle.
  const settledMission = await api(`/missions/${lifecycle.missionId}`);
  await api(`/missions/${lifecycle.missionId}/recording-selection`, {
    missionId: lifecycle.missionId,
    agentSessionId: lifecycle.agentSessionId,
    orderedRunIds: [run.id],
    expectedMissionRevision: settledMission.revision,
    idempotencyKey: `${runId}-recording-selection`,
  });
  const finalMission = await api(`/missions/${lifecycle.missionId}`);
  const report = await api(`/missions/${lifecycle.missionId}/reports`, {
    missionId: lifecycle.missionId,
    agentSessionId: lifecycle.agentSessionId,
    overallConclusion:
      "Isolated production architecture shadow journey passed without real external effects",
    journeySummary: [
      "One shadow issuance",
      "One exact generated-pair-authenticated Create",
      "One Chronicle-authorized read-only Retrieve on a fresh owner",
      "Canonical created/retrieved identity equality",
    ],
    remainingActions: [],
    expectedRevision: finalMission.revision,
    idempotencyKey: `${runId}-report`,
  });
  const finalizedAgent = await api(`/agent-sessions/${lifecycle.agentSessionId}/end`, {
    status: "completed",
  });
  await record("J14", {
    status: "PASS",
    finalizedRun,
    finalizedAgent,
    report,
    run: await api(`/runs/${run.id}`),
  });
  const { Q5_MCP_PROFILE, Q5_MCP_CONTRACT_DIGEST } = await import("@scry/contracts");
  const q5Port = await freePort();
  child("q5-mcp", "pnpm", ["exec", "tsx", "src/http.ts"], path.join(root, "apps/mcp"), {
    MCP_PORT: String(q5Port),
    SCRY_MCP_PROFILE: Q5_MCP_PROFILE,
  });
  await until(async () => (await fetch(`http://127.0.0.1:${q5Port}/health`)).ok, "Q5_MCP_READY");
  const q5Health: any = await (await fetch(`http://127.0.0.1:${q5Port}/health`)).json();
  assert.equal(q5Health.q5Contract.digest, Q5_MCP_CONTRACT_DIGEST);
  const attemptCount = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM q5_authoritative_attempts",
  );
  assert.equal(attemptCount.rows[0]?.count, "0");
  const endScope = await bootstrapQ5CanonicalScope(store, facts);
  assert.equal(endScope.status, "prepared");
  await record("J15", {
    status: "PREPARED_SCOPE_PASS_AUTHORIZATION_MODEL_UNRESOLVED",
    endScope,
    q5Health,
    authoritativeAttempts: 0,
  });
  assert.equal(network.counts().issuance, 1);
  assert.equal(network.counts().create, 1);
  assert.equal(network.counts().retrieve, 1);
  assert.equal(network.counts().clientErrors, 0);
  await record("journey", {
    status: "DEVELOPMENT_OWNER_SUPERVISED_PASS",
    finalA2Eligible: false,
    blocker: "Q5_EXACT_AUTHORIZATION_MODEL_UNRESOLVED",
    stages: Array.from({ length: 16 }, (_, index) => `J${index}`),
    sourceAfter: deriveRepositorySourceIdentity(root),
  });
} catch (error) {
  const response =
    error && typeof error === "object" && "getResponse" in error
      ? (error as { getResponse(): unknown }).getResponse()
      : undefined;
  await record("failure", {
    message: error instanceof Error ? error.message : "UNKNOWN",
    response,
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
} finally {
  if (closeOwner) await closeOwner().catch(() => undefined);
  for (const processChild of children.reverse())
    if (processChild.pid) {
      try {
        process.kill(-processChild.pid, "SIGTERM");
      } catch {}
    }
  if (app) await app.close().catch(() => undefined);
  await network.close();
  for (const [name, log] of childLogs) await writeFile(path.join(directory, `${name}.log`), log);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PORT_UNAVAILABLE");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function until(check: () => Promise<boolean>, code: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`SHADOW_${code}_TIMEOUT`);
}
