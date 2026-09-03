/** Fresh production topology; only the external provider network is substituted. */
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
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
const laboratoryShape = process.argv[3] as "public" | "protected" | undefined;
if (laboratoryShape && !["public", "protected"].includes(laboratoryShape))
  throw new Error("LAB_SHAPE_INVALID");
const runId = process.argv[2] ?? `production-development-${Date.now()}`;
if (!/^production-[a-z0-9-]+$/.test(runId)) throw new Error("SHADOW_RUN_ID_INVALID");
const directory = path.join(root, "artifacts/thin-kernel-production/journeys", runId);
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
const network = await startShadowVitractNetwork({ liveReadOnly: true });
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
  const loginPassword = randomBytes(24).toString("hex");
  const password = await configuration.createCredential(principal, scope.projectId, {
    name: "Shadow login password",
    value: loginPassword,
  });
  const composition = app.get(VitractCredentialIssuancePreparationService);
  const applicationResourceScope = `shadow-${randomUUID()}`;
  const credentialName = `Shadow ${runId}`;
  const lifecycle = await composition.createLifecycle(principal, {
    maxBusinessMutationDispatches: laboratoryShape ? 1 : 2,
    ...(laboratoryShape
      ? {
          instruction: `Use the ${laboratoryShape} sample catalog to Create exactly one item, Retrieve it once, verify identity equality and settle this Mission. No credential issuance is requested.`,
        }
      : {
          instruction:
            "Observe and authenticate as needed, issue exactly one shadow credential pair, Create exactly one order, Retrieve it once, verify identity equality and complete Run, Objective and Mission report.",
        }),
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
  network.configureLogin({
    email: "shadow@example.test",
    password: loginPassword,
    applicationScope: applicationResourceScope,
  });
  await record("J2", { status: "AGENT_OWNED_SETUP_PENDING", harnessSemanticActions: 0 });
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
  closeOwner = async () => {
    const owners = await database.query<{ id: string }>(
      `SELECT id FROM adaptive_sessions WHERE mission_id=$1 ORDER BY created_at DESC`,
      [lifecycle.missionId],
    );
    const failures: Array<{ sessionId: string; message: string }> = [];
    for (const owner of owners.rows) {
      try {
        await composition.closePrepared(
          principal,
          { ...lifecycle, authoringSessionId: owner.id },
          `${runId}-close-${owner.id}`,
        );
      } catch (error) {
        failures.push({
          sessionId: owner.id,
          message: error instanceof Error ? error.message : "CLOSE_FAILED",
        });
      }
    }
    if (!stages.journey && failures.length === 0) {
      const current = await api(`/runs/${run.id}`);
      if (!["passed", "failed", "cancelled"].includes(current.run.state))
        await api(`/runs/${run.id}/finalize`, {
          praxisSessionId: current.run.praxisSessionId ?? owners.rows[0]!.id,
          outcome: "cancelled",
          reason:
            "Isolated qualification stopped before full journey completion; effect history preserved.",
          idempotencyKey: `${runId}-cleanup-run`,
        });
      const { OrchestrationService } = await import("../../src/orchestration/index.js");
      const { MissionService } = await import("../../src/missions/index.js");
      const mission = await api(`/missions/${lifecycle.missionId}`);
      if (!["completed", "failed", "cancelled"].includes(mission.status))
        await app!.get(OrchestrationService).control(principal, lifecycle.missionId, "cancel", {
          ...context,
          reason: "Isolated qualification stopped; no effect replay or historical rewriting.",
        });
      await app!
        .get(MissionService)
        .endSession(principal, lifecycle.agentSessionId, { status: "failed" });
    }
    await record("cleanup", { owners: owners.rows.length, failures });
  };
  await record("runOpened", { runId: run.id, publication });
  const agentDirectory = path.join(directory, "blind-agent");
  await mkdir(agentDirectory);
  const connectionPath = path.join(directory, "agent-connection.json");
  const blindScope = {
    loginReferenceIds: [email.id, password.id],
    attemptId: null,
    state: "preflight",
    campaignId: randomUUID(),
    canonicalApplicationId: randomUUID(),
    applicationIdentity: "vitract-preview-test",
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    ...context,
    externalRunId: randomUUID(),
    flowDraftId: lifecycle.flowDraftId,
    flowRevisionId: publication.revisionId,
    targetOrigin: "https://preview.vitract.com",
    allowedOrigins: ["https://preview.vitract.com", "https://preview-api.vitract.com"],
    clientIdValueAssetId: randomUUID(),
    clientSecretValueAssetId: randomUUID(),
    runId: run.id,
    praxisSessionId: lifecycle.authoringSessionId,
    praxisSessionIds: [lifecycle.authoringSessionId],
  };
  await writeFile(
    connectionPath,
    JSON.stringify({
      apiBaseUrl: process.env.SCRY_API_BASE_URL,
      serviceToken: process.env.SCRY_SERVICE_TOKEN,
      scope: blindScope,
    }),
    { mode: 0o600 },
  );
  let prompt = `Complete this Mission using only Scry MCP tools: observe the real public login/application and real Partner API documentation, authenticate to the isolated effect workspace as needed using the supplied protected login references, issue one credential pair, Create exactly one order, Retrieve it once, verify identity, and settle Run, Objective and Mission report successfully. You own all navigation, login, operation selection and completion decisions. No semantic setup or business effect has happened yet. Infrastructure may initialize the browser at an allowed base origin. Start from the workspace entry https://preview.vitract.com/experiment and observe its links. Public/login/docs reads go to live Vitract; authenticated login/issuance/Create/Retrieve effects are local shadows. Never submit shadow login credentials to the live login; use the explicitly labeled shadow authentication workspace. The Mission already requests these effects; no further owner approval is needed. Never read protected plaintext or bypass a safety refusal. Never blindly replay an applied or possibly applied effect. Choose operations from observations, with no supplied business routes or fields. Rotate fresh browser owners between issuance, Create and Retrieve. Use available continuations for exact generated resource reuse. Your exact scope: ${JSON.stringify({ projectId: scope.projectId, environmentId: scope.environmentId, ...context, runId: run.id, flowDraftId: lifecycle.flowDraftId, praxisSessionId: lifecycle.authoringSessionId, allowedOrigins: blindScope.allowedOrigins, protectedLogin: { emailReferenceId: email.id, passwordReferenceId: password.id } })}. Conclude with factual counts, identity verification and settlement states. No shell, repo, database, direct HTTP or other agents are available.`;
  if (laboratoryShape)
    prompt = `Complete this Mission using only Scry MCP tools: Create exactly one sample item in the ${laboratoryShape} catalog, Retrieve it once using its available continuation, verify identity equality, settle Run/Objective/Mission report. No issuance is requested. You own navigation, authentication when needed, operation selection and semantic recovery. Infrastructure may initialize the browser at an allowed base origin. Entry https://preview.vitract.com/laboratory/${laboratoryShape}/create . All laboratory surfaces/effects are local shadows. ${laboratoryShape === "protected" ? `Use this protected workspace access reference when the observed application requires it: ${password.id}. Never read its plaintext.` : "This public catalog requires no login."} Rotate owners between Create and Retrieve. Your exact scope: ${JSON.stringify({ projectId: scope.projectId, environmentId: scope.environmentId, ...context, runId: run.id, flowDraftId: lifecycle.flowDraftId, praxisSessionId: lifecycle.authoringSessionId, allowedOrigins: blindScope.allowedOrigins })}. No additional owner approval. Never replay an applied or possibly applied effect. Discover operations from the application; no business route/method/field answers are supplied. No shell/repo/database/direct HTTP/other agents.`;
  await writeFile(path.join(directory, "agent-prompt.txt"), prompt);
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C",
    agentDirectory,
    "--sandbox",
    "read-only",
    "--json",
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "skills.bundled.enabled=false",
    "--enable",
    "skip_host_skill_discovery",
  ];
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "view_image",
    "multi_agent",
    "workspace_dependencies",
  ])
    args.push("--disable", feature);
  args.push(
    "-c",
    `mcp_servers.scry={command="${process.execPath}",args=["--import","${path.join(root, "node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs")}","${path.join(root, "apps/mcp/src/qualification/production-shadow-stdio.ts")}"],env={SCRY_SHADOW_CONNECTION="${connectionPath}"},tool_timeout_sec=120,startup_timeout_sec=60}`,
  );
  const { Q5_MCP_TOOL_NAMES } = await import("@scry/contracts");
  // Explicit user authorization applies only to this isolated local scoped MCP server.
  for (const name of Q5_MCP_TOOL_NAMES)
    args.push("-c", `mcp_servers.scry.tools.${name}.approval_mode="approve"`);
  args.push(prompt);
  const agent = spawn("/Applications/ChatGPT.app/Contents/Resources/codex", args, {
    cwd: agentDirectory,
    env: {
      PATH: "/Applications/ChatGPT.app/Contents/Resources:" + process.env.PATH,
      HOME: process.env.HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let transcript = "",
    diagnostics = "";
  agent.stdout.on("data", (chunk) => {
    transcript += chunk;
    void writeFile(path.join(directory, "agent.jsonl"), transcript);
  });
  agent.stderr.on("data", (chunk) => {
    diagnostics += chunk;
    void writeFile(path.join(directory, "agent.stderr.log"), diagnostics);
  });
  const timer = setTimeout(() => agent.kill("SIGTERM"), 30 * 60_000);
  const code = await new Promise((resolve) => agent.once("exit", resolve));
  clearTimeout(timer);
  await record("agent", { exitCode: code, repositoryBlind: true, actualIntelligentAgent: true });
  const operations = await database.query(
    `SELECT id,state,dispatch_state,mutation_outcome,persistence_state,authorization_id FROM protected_operations ORDER BY created_at`,
  );
  const approvals = await database.query(
    `SELECT count(*)::int AS count FROM mission_authorizations `,
  );
  const selections = await database.query(
    `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name='mission_value_selections'`,
  );
  const attempts = await database.query(
    `SELECT count(*)::int AS count FROM q5_authoritative_attempts`,
  );
  const runState = await api(`/runs/${run.id}`);
  const missionState = await api(`/missions/${lifecycle.missionId}`);
  const unresolved = await database.query(
    `SELECT count(*)::int AS count FROM adaptive_operations operation
    JOIN adaptive_sessions session ON session.id=operation.session_id WHERE session.mission_id=$1
    AND operation.mutation_outcome='unknown' AND adaptive_operation_unknown_unresolved(operation.session_id,operation.operation_id)`,
    [lifecycle.missionId],
  );
  const identities = await database.query(
    `SELECT id,state,created_identity_digest,retrieved_identity_digest,
    created_identity_digest=retrieved_identity_digest AS matches FROM mission_operation_checkpoints
    WHERE mission_id=$1 AND 'read_only_retrieve'=ANY(permitted_continuations)`,
    [lifecycle.missionId],
  );

  const endScope = await bootstrapQ5CanonicalScope(store, facts);
  await record("liveReadOnly", { requests: network.liveReadEvidence() });
  await record("inspection", {
    operations: operations.rows,
    ownerApprovals: approvals.rows[0]!.count,
    semanticSelections: selections.rows[0]!.count,
    authoritativeAttempts: attempts.rows[0]!.count,
    run: runState,
    mission: missionState,
    unresolvedUnknown: unresolved.rows[0]!.count,
    identities: identities.rows,
    endScope,
  });
  assert.equal(code, 0);
  assert.equal(network.counts().issuance, laboratoryShape ? 0 : 1);
  assert.equal(network.counts().create, 1);
  assert.equal(network.counts().retrieve, 1);
  assert.equal(approvals.rows[0]!.count, 0);
  assert.equal(attempts.rows[0]!.count, 0);
  assert.equal(runState.run.state, "passed", "Run must settle successfully, not only effects");
  assert.equal(missionState.status, "completed", "Mission must settle successfully");
  assert.equal(
    missionState.objectives.find((item: any) => item.id === lifecycle.objectiveId)?.status,
    "passed",
  );
  assert.ok(missionState.finalReportId, "Final report required");
  assert.equal(unresolved.rows[0]!.count, 0);
  assert.equal(identities.rows.length, 1);
  assert.equal(identities.rows[0]!.matches, true);
  if (!laboratoryShape) {
    const live = network.liveReadEvidence();
    assert.ok(
      live.some((read) => read.url === "https://preview.vitract.com/login" && read.status === 200),
    );
    assert.ok(
      live.some(
        (read) =>
          read.url === "https://preview-api.vitract.com/api/docs/partner-api" &&
          read.status === 200,
      ),
    );
    assert.equal(endScope.status, "prepared");
  }
  const sourceAfter = deriveRepositorySourceIdentity(root);
  assert.equal(sourceAfter.manifestSha256, source.manifestSha256, "SOURCE_CHANGED_DURING_JOURNEY");
  await record("journey", {
    status: "PRODUCTION_THIN_COMPLETE_INTELLIGENT_JOURNEY_PASS",
    sourceAfter,
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
  if (closeOwner)
    await closeOwner().catch(async (error) => {
      process.exitCode = 1;
      await record("cleanupFailure", {
        message: error instanceof Error ? error.message : "CLEANUP_FAILED",
      });
    });
  for (const processChild of children.reverse())
    if (processChild.pid) {
      try {
        process.kill(-processChild.pid, "SIGTERM");
      } catch {}
    }
  if (app) await app.close().catch(() => undefined);
  await network.close();
  for (const [name, log] of childLogs) await writeFile(path.join(directory, `${name}.log`), log);
  const surfaces: string[] = [];
  async function collect(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.name !== "agent-connection.json") {
        surfaces.push((await readFile(file)).toString("utf8"));
        if (entry.name.endsWith(".zip"))
          surfaces.push(
            execFileSync("unzip", ["-p", file], {
              maxBuffer: 128 * 1024 * 1024,
              stdio: ["ignore", "pipe", "pipe"],
            }).toString("utf8"),
          );
      }
    }
  }
  await collect(directory);
  const privacy = network.countProtectedLeaks(surfaces);
  if (privacy.leaks) process.exitCode = 1;
  await record("privacyScan", {
    ...privacy,
    surfaces: surfaces.length,
    scope:
      "Protected login/generated secret/request payload canaries across exported bytes and decompressed trace ZIP contents; not OCR/video proof",
  });
}
process.exit(process.exitCode ?? 0);
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
