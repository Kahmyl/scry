import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueueEvents, Worker } from "bullmq";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuthenticatedEvidenceStore,
  SanitizedBrowserRecorder,
  renderSanitizedReplay,
} from "@scry/browser-runtime";
import { ProtectedCaptureVault, ProtectionAuthority } from "@scry/veil";

import {
  BrowserExecutionQueueService,
  BROWSER_EXECUTION_QUEUE,
} from "../src/browser-execution/browser-execution-queue.service.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BROWSER_RUNTIME_CAPABILITY_ID } from "../src/browser-execution/browser-runtime-capability.js";
import { Database } from "../src/infrastructure/database.js";
import { RedisConnection } from "../src/infrastructure/redis.js";

const databaseUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = databaseUrl && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
run("browser execution baseline queued long journey", () => {
  const loginPassword = "login-fixture-password-7712";
  const generatedSecret = "tok_fixture_generated_998877665544";
  const credentialId = `cred-${randomUUID()}`;
  const clientId = `client-${randomUUID()}`;
  const orderId = `order-${randomUUID()}`;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let database: Database;
  let redis: RedisConnection;
  let repository: BrowserExecutionRepository;
  let queue: BrowserExecutionQueueService;
  let sessionId: string;
  let runId: string;
  let root: string;
  let fixtureEffects = { credentialCreates: 0, orderCreates: 0, orderReads: 0 };

  beforeAll(async () => {
    server = createServer((request, response) => void handleFixture(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_address_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    root = await mkdtemp(path.join(os.tmpdir(), "browser-long-journey-"));
    process.env.DATABASE_URL = databaseUrl;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.SCRY_BROWSER_ENABLED = "true";
    database = new Database();
    redis = new RedisConnection();
    repository = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
    queue = new BrowserExecutionQueueService(
      redis,
      repository,
      new BrowserCommandRepository(database, new BrowserProtectedValueCipher()),
    );
    const seeded = await seedMission(database, origin);
    sessionId = seeded.sessionId;
    runId = seeded.runId;
    await repository.createSession({
      id: sessionId,
      runId,
      projectId: seeded.projectId,
      missionId: seeded.missionId,
      objectiveId: seeded.objectiveId,
      environmentId: seeded.environmentId,
      agentSessionId: seeded.agentSessionId,
      authenticationCommitLimit: 1,
      businessCommitLimit: 2,
      allowedFirstPartyOrigins: [origin],
      idempotencyKey: `browser-session-${sessionId}`,
    });
  });

  afterAll(async () => {
    if (queue) await queue.onModuleDestroy();
    if (redis) await redis.onModuleDestroy();
    if (database) await database.onModuleDestroy();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });

  it("executes login, credential creation, protected reuse, order creation, retrieval, recording, and finalization", async () => {
    const queueEvents = new QueueEvents(BROWSER_EXECUTION_QUEUE, { connection: redis.client });
    const worker = new Worker(
      BROWSER_EXECUTION_QUEUE,
      async (job) => {
        expect(job.data.sessionId).toBe(sessionId);
        expect(job.data.runtimeCapabilityId).toBe(BROWSER_RUNTIME_CAPABILITY_ID);
        return executeJourney();
      },
      { connection: redis.client, concurrency: 1 },
    );
    try {
      expect(await queue.dispatchPending()).toBe(1);
      const job = await queue.queue.getJob(sessionId);
      expect(job).not.toBeNull();
      const result = await job!.waitUntilFinished(queueEvents, 60_000);
      expect(result).toMatchObject({ completed: true, networkRequestsDuringReplay: 0 });
      expect(await queue.dispatchPending()).toBe(0);
    } finally {
      await worker.close();
      await queueEvents.close();
    }

    expect(fixtureEffects).toEqual({ credentialCreates: 1, orderCreates: 1, orderReads: 1 });
    const state = await database.query<{
      state: string;
      authentication_commits_used: number;
      business_commits_used: number;
    }>(
      "SELECT state,authentication_commits_used,business_commits_used FROM browser_execution_sessions WHERE id=$1",
      [sessionId],
    );
    expect(state.rows[0]).toMatchObject({
      state: "completed",
      authentication_commits_used: 1,
      business_commits_used: 1,
    });
    const effects = await database.query<{ mutation_outcome: string; publication_state: string }>(
      "SELECT mutation_outcome,publication_state FROM browser_effects WHERE session_id=$1 ORDER BY effect_ordinal",
      [sessionId],
    );
    expect(effects.rows).toEqual([
      { mutation_outcome: "applied", publication_state: "published" },
      { mutation_outcome: "applied", publication_state: "published" },
    ]);
    const serializedFiles = await allPersistedText(root);
    expect(serializedFiles).not.toContain(loginPassword);
    expect(serializedFiles).not.toContain(generatedSecret);
  }, 90_000);

  async function executeJourney(): Promise<{
    completed: true;
    networkRequestsDuringReplay: number;
  }> {
    const owner = await repository.claimOwner(sessionId, "long-journey-worker", 60_000);
    const evidenceDirectory = path.join(root, "evidence");
    const captureDirectory = path.join(root, "captures");
    const outputDirectory = path.join(root, "rendered");
    const ledgerPath = path.join(root, "action-ledger.jsonl");
    const authority = new ProtectionAuthority({
      scope: {
        projectId: "fixture-project",
        missionId: "fixture-mission",
        runId,
        sessionId,
        origin,
      },
      protectedValues: { LOGIN_PASSWORD: loginPassword, GENERATED_SECRET: generatedSecret },
      disclosureMode: "trusted_application_output",
    });
    const store = await new AuthenticatedEvidenceStore<Record<string, unknown>>({
      directory: evidenceDirectory,
      runId,
      scopeId: sessionId,
      encryptionKey: randomBytes(32),
      maxSessionBytes: 2 * 1024 * 1024,
    }).initialize();
    const vault = await new ProtectedCaptureVault({
      directory: captureDirectory,
      runId,
      scopeId: sessionId,
      authority,
    }).initialize();
    const browser = await chromium.launch({ headless: true, channel: "chrome" });
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = new SanitizedBrowserRecorder({
      store,
      authority,
    });
    const actions: Array<Record<string, unknown>> = [];
    const recordAction = async (tool: string, element: string, perform: () => Promise<void>) => {
      const started = Date.now();
      await perform();
      actions.push({
        at: new Date(started).toISOString(),
        tool,
        arguments: { element },
        outcome: "succeeded",
        durationMs: Date.now() - started,
      });
    };
    await recorder.start(context);
    try {
      await page.goto(`${origin}/login`);
      await recordAction("fill", "email", () =>
        page.getByLabel("Email").fill("agent@example.test"),
      );
      await recordAction("fill", "password", () => page.getByLabel("Password").fill(loginPassword));
      await recordAction("click", "Sign in", async () => {
        await Promise.all([
          page.waitForURL(`${origin}/dashboard`),
          page.getByRole("button", { name: "Sign in" }).click(),
        ]);
      });

      const authEffect = await repository.admitEffect({
        sessionId,
        ownerGeneration: owner.generation,
        documentEpoch: 1,
        idempotencyKey: "credential-create-1",
        effectClass: "authentication",
        expectedOrigin: origin,
        targetDigest: digest("create-credential-button"),
        actionDigest: digest("POST /api/credentials"),
        intentSummary: "Create one credential for the dependent order operation",
      });
      await repository.markDispatchStarted(authEffect.effect.id, owner.generation);
      const credentialBarrier = authority.begin(authEffect.effect.id);
      const credentialResponsePromise = page.waitForResponse(
        (response) => response.url() === `${origin}/api/credentials`,
      );
      await recordAction("click", "Create credential", () =>
        page.getByRole("button", { name: "Create credential" }).click(),
      );
      const credentialResponse = await credentialResponsePromise;
      const credentialBody = Buffer.from(await credentialResponse.body());
      const capturedCredential = await vault.captureHttpResponse({
        effectId: authEffect.effect.id,
        method: "POST",
        url: credentialResponse.url(),
        status: credentialResponse.status(),
        contentType: credentialResponse.headers()["content-type"] ?? "application/json",
        body: credentialBody,
        protectionBarrier: credentialBarrier,
      });
      const credentialRaw = await readFile(
        path.join(captureDirectory, "captures", `${capturedCredential.captureId}.raw.json`),
      );
      await repository.registerCapture({
        effectId: authEffect.effect.id,
        ownerGeneration: owner.generation,
        captureId: capturedCredential.captureId,
        evidenceFormat: 1,
        objectKey: `local://${path.join(captureDirectory, "captures", `${capturedCredential.captureId}.raw.json`)}`,
        ciphertextDigest: digest(credentialRaw),
        encryptedPayload: credentialRaw,
        encryptedPayloadDigest: digest(credentialRaw),
        responseStatus: credentialResponse.status(),
        authenticatedMetadata: { receiptDigest: digest(JSON.stringify(capturedCredential)) },
        contentClass: "http_json",
        byteSize: credentialBody.length,
        structuralIndex: capturedCredential.structuralIndex,
        capturedAt: new Date(capturedCredential.capturedAt),
        expiresAt: new Date(capturedCredential.expiresAt),
      });
      const credentialOutputs = await vault.publish(capturedCredential.captureId, [
        {
          key: "credentialId",
          semantic: "credentialId",
          path: ["data", "credentialId"],
          classification: "public",
        },
        {
          key: "clientId",
          semantic: "clientId",
          path: ["data", "clientId"],
          classification: "public",
        },
        { key: "clientSecret", path: ["data", "clientSecret"], classification: "protected" },
      ]);
      let secretForPersistence = "";
      await vault.deliverProtectedToBrowser(
        credentialOutputs.protectedOutputs.clientSecret!.reference,
        {
          fill: async (value) => {
            secretForPersistence = value;
          },
        },
      );
      await repository.publishOutputs({
        effectId: authEffect.effect.id,
        ownerGeneration: owner.generation,
        captureId: capturedCredential.captureId,
        selectionDigest: digest("credential-output-selection-v1"),
        publicOutputs: credentialOutputs.publicOutputs,
        protectedOutputs: { clientSecret: secretForPersistence },
        decisions: credentialOutputs.decisions,
      });
      secretForPersistence = "";
      await repository.determine(
        authEffect.effect.id,
        owner.generation,
        "applied",
        "credential_identity_present_and_unique",
      );

      await recordAction("click", "Documentation", async () => {
        await Promise.all([
          page.waitForURL(`${origin}/docs`),
          page.getByRole("link", { name: "Documentation" }).click(),
        ]);
      });
      expect(await page.getByRole("heading", { name: "Create an order" }).isVisible()).toBe(true);
      await recordAction("click", "Open order workspace", async () => {
        await Promise.all([
          page.waitForURL(`${origin}/orders`),
          page.getByRole("link", { name: "Open order workspace" }).click(),
        ]);
      });
      await page.getByLabel("Client ID").fill(String(credentialOutputs.publicOutputs.clientId));
      await vault.deliverProtectedToBrowser(
        credentialOutputs.protectedOutputs.clientSecret!.reference,
        { fill: (value) => page.getByLabel("Client secret").fill(value) },
      );

      const businessEffect = await repository.admitEffect({
        sessionId,
        ownerGeneration: owner.generation,
        documentEpoch: 4,
        idempotencyKey: "order-create-1",
        effectClass: "business",
        expectedOrigin: origin,
        targetDigest: digest("create-order-button"),
        actionDigest: digest("POST /api/orders"),
        intentSummary: "Create one order and retrieve the exact returned identity",
      });
      await repository.markDispatchStarted(businessEffect.effect.id, owner.generation);
      const orderBarrier = authority.begin(businessEffect.effect.id);
      const orderResponsePromise = page.waitForResponse(
        (response) =>
          response.url() === `${origin}/api/orders` && response.request().method() === "POST",
      );
      await recordAction("click", "Create order", () =>
        page.getByRole("button", { name: "Create order" }).click(),
      );
      const orderResponse = await orderResponsePromise;
      const orderBody = Buffer.from(await orderResponse.body());
      const capturedOrder = await vault.captureHttpResponse({
        effectId: businessEffect.effect.id,
        method: "POST",
        url: orderResponse.url(),
        status: orderResponse.status(),
        contentType: "application/json",
        body: orderBody,
        protectionBarrier: orderBarrier,
      });
      const orderRaw = await readFile(
        path.join(captureDirectory, "captures", `${capturedOrder.captureId}.raw.json`),
      );
      await repository.registerCapture({
        effectId: businessEffect.effect.id,
        ownerGeneration: owner.generation,
        captureId: capturedOrder.captureId,
        evidenceFormat: 1,
        objectKey: `local://${path.join(captureDirectory, "captures", `${capturedOrder.captureId}.raw.json`)}`,
        ciphertextDigest: digest(orderRaw),
        encryptedPayload: orderRaw,
        encryptedPayloadDigest: digest(orderRaw),
        responseStatus: orderResponse.status(),
        authenticatedMetadata: { receiptDigest: digest(JSON.stringify(capturedOrder)) },
        contentClass: "http_json",
        byteSize: orderBody.length,
        structuralIndex: capturedOrder.structuralIndex,
        capturedAt: new Date(capturedOrder.capturedAt),
        expiresAt: new Date(capturedOrder.expiresAt),
      });
      const orderOutputs = await vault.publish(capturedOrder.captureId, [
        {
          key: "orderId",
          semantic: "orderId",
          path: ["data", "orderId"],
          classification: "public",
        },
        {
          key: "completed",
          semantic: "completed",
          path: ["data", "completed"],
          classification: "public",
        },
      ]);
      await repository.publishOutputs({
        effectId: businessEffect.effect.id,
        ownerGeneration: owner.generation,
        captureId: capturedOrder.captureId,
        selectionDigest: digest("order-output-selection-v1"),
        publicOutputs: orderOutputs.publicOutputs,
        protectedOutputs: {},
        decisions: orderOutputs.decisions,
      });
      await repository.determine(
        businessEffect.effect.id,
        owner.generation,
        "applied",
        "exact_order_identity_retrieved",
      );
      const retrieveResponse = await page.request.get(
        `${origin}/api/orders/${String(orderOutputs.publicOutputs.orderId)}`,
      );
      expect(await retrieveResponse.json()).toEqual({
        data: { orderId, completed: true, credentialId },
      });
      fixtureEffects.orderReads += 1;
      await page.goto(`${origin}/orders/${orderId}`);
      expect(await page.getByText(orderId).isVisible()).toBe(true);
      await page.waitForTimeout(750);
    } finally {
      const diagnostics = await recorder.flush();
      expect(diagnostics.errors).toEqual([]);
      await recorder.close();
      await context.close();
      await browser.close();
    }

    await writeFile(ledgerPath, `${actions.map((action) => JSON.stringify(action)).join("\n")}\n`, {
      mode: 0o600,
    });
    const verified = await store.verify();
    expect(JSON.stringify(verified.events)).not.toContain(loginPassword);
    expect(JSON.stringify(verified.events)).not.toContain(generatedSecret);
    const publication = await renderSanitizedReplay({
      events: verified.events,
      ledgerPath,
      outputDirectory,
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      framesPerSecond: 2,
    });
    await database.query(
      `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,
         replay_artifact_key,video_artifact_key,retention_expires_at,completed_at)
       VALUES($1,$2,$3,'complete',$4,$5,$6,$7,$8,now()+interval '30 days',now())`,
      [
        randomUUID(),
        sessionId,
        runId,
        verified.lastDigest,
        verified.chunks,
        verified.storedBytes,
        `local://${evidenceDirectory}`,
        `local://${publication.videoPath}`,
      ],
    );
    await repository.finalizeSession(sessionId, owner.generation);
    return { completed: true, networkRequestsDuringReplay: publication.networkRequests };
  }

  async function handleFixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/login") return html(response, loginPage());
    if (request.method === "POST" && url.pathname === "/login") {
      const body = await bodyText(request);
      if (!body.includes(encodeURIComponent(loginPassword)))
        return json(response, 401, { error: "invalid_login" });
      response.writeHead(302, {
        location: "/dashboard",
        "set-cookie": "fixture_session=active; HttpOnly; SameSite=Lax",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard")
      return html(response, dashboardPage());
    if (request.method === "POST" && url.pathname === "/api/credentials") {
      fixtureEffects.credentialCreates += 1;
      return json(response, 201, {
        data: { credentialId, clientId, clientSecret: generatedSecret },
      });
    }
    if (request.method === "GET" && url.pathname === "/docs") return html(response, docsPage());
    if (request.method === "GET" && url.pathname === "/orders") return html(response, orderPage());
    if (request.method === "POST" && url.pathname === "/api/orders") {
      const body = JSON.parse(await bodyText(request)) as {
        clientId?: string;
        clientSecret?: string;
      };
      if (body.clientId !== clientId || body.clientSecret !== generatedSecret)
        return json(response, 403, { error: "credential_rejected" });
      fixtureEffects.orderCreates += 1;
      return json(response, 201, { data: { orderId, completed: true } });
    }
    if (request.method === "GET" && url.pathname === `/api/orders/${orderId}`)
      return json(response, 200, { data: { orderId, completed: true, credentialId } });
    if (request.method === "GET" && url.pathname === `/orders/${orderId}`)
      return html(response, `<!doctype html><h1>Order complete</h1><p>${orderId}</p>`);
    response.writeHead(404).end();
  }
});

async function seedMission(database: Database, origin: string) {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const missionId = randomUUID();
  const agentSessionId = randomUUID();
  const objectiveId = randomUUID();
  const environmentId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  await database.transaction(async (client) => {
    await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
      userId,
      randomUUID(),
      `${userId}@example.test`,
    ]);
    await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'long journey',$2)", [
      workspaceId,
      `long-${workspaceId}`,
    ]);
    await client.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, userId],
    );
    await client.query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)", [
      projectId,
      workspaceId,
      `project-${projectId}`,
    ]);
    await client.query(
      "INSERT INTO missions(id,project_id,title,original_instruction,idempotency_key) VALUES($1,$2,'long journey','authenticate, create credentials, read documentation, create and retrieve an order','long-mission-1')",
      [missionId, projectId],
    );
    await client.query(
      "INSERT INTO agent_sessions(id,mission_id,project_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,'codex','long journey','agent-long')",
      [agentSessionId, missionId, projectId],
    );
    await client.query(
      "INSERT INTO mission_objectives(id,mission_id,project_id,title,completion_criteria,objective_order,idempotency_key) VALUES($1,$2,$3,'complete order',$4::jsonb,0,'long-objective-1')",
      [
        objectiveId,
        missionId,
        projectId,
        JSON.stringify({ orderCreated: true, orderRetrieved: true }),
      ],
    );
    await client.query(
      "INSERT INTO environments(id,project_id,name,base_origin,disclosure_mode) VALUES($1,$2,'fixture',$3,'trusted_application_output')",
      [environmentId, projectId, origin],
    );
    await client.query(
      "INSERT INTO flows(id,project_id,mission_id,created_by_agent_session_id,name,idempotency_key) VALUES($1,$2,$3,$4,'agent selected flow','flow-long')",
      [flowId, projectId, missionId, agentSessionId],
    );
    await client.query(
      "INSERT INTO flow_revisions(id,flow_id,mission_id,project_id,revision,state,created_by_agent_session_id,activated_at) VALUES($1,$2,$3,$4,1,'active',$5,now())",
      [flowRevisionId, flowId, missionId, projectId, agentSessionId],
    );
    await client.query(
      `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'run-long','running')`,
      [
        runId,
        projectId,
        missionId,
        objectiveId,
        agentSessionId,
        flowId,
        flowRevisionId,
        environmentId,
      ],
    );
  });
  return { projectId, missionId, agentSessionId, objectiveId, environmentId, runId, sessionId };
}

function loginPage() {
  return `<!doctype html><form method="post"><label>Email<input aria-label="Email" name="email"></label><label>Password<input aria-label="Password" type="password" name="password"></label><button>Sign in</button></form>`;
}
function dashboardPage() {
  return `<!doctype html><h1>Dashboard</h1><button id="create">Create credential</button><a href="/docs">Documentation</a><div id="result"></div><script>document.querySelector('#create').onclick=async()=>{const r=await fetch('/api/credentials',{method:'POST'});const x=await r.json();document.querySelector('#result').innerHTML='<div role="dialog"><p>'+x.data.credentialId+'</p><p>'+x.data.clientId+'</p><p data-scry-protected>'+x.data.clientSecret+'</p></div>'}</script>`;
}
function docsPage() {
  return `<!doctype html><h1>Create an order</h1><p>Use the generated client ID and client secret. POST once, then GET the returned order ID.</p><a href="/orders">Open order workspace</a>`;
}
function orderPage() {
  return `<!doctype html><label>Client ID<input aria-label="Client ID" id="client-id"></label><label>Client secret<input aria-label="Client secret" id="client-secret" type="password"></label><button id="create-order">Create order</button><div id="order-result"></div><script>document.querySelector('#create-order').onclick=async()=>{const r=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:document.querySelector('#client-id').value,clientSecret:document.querySelector('#client-secret').value})});const x=await r.json();document.querySelector('#order-result').textContent=JSON.stringify(x)}</script>`;
}
function html(response: ServerResponse, body: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
async function allPersistedText(root: string): Promise<string> {
  const { readdir, stat } = await import("node:fs/promises");
  const values: string[] = [];
  for (const name of await readdir(root, { recursive: true })) {
    const target = path.join(root, name);
    if ((await stat(target)).isFile()) values.push(await readFile(target, "utf8").catch(() => ""));
  }
  return values.join("\n");
}
