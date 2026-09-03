import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { QueueEvents, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserCommandV2 } from "@scry/contracts";

import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import {
  BROWSER_COMMAND_V2_QUEUE,
  BROWSER_EXECUTION_V2_QUEUE,
  BrowserExecutionQueueService,
} from "../src/browser-execution/browser-execution-queue.service.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserLifecycleController } from "../src/browser-execution/controllers/browser-lifecycle.controller.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserV2WorkerEngine } from "../src/browser-execution/browser-v2-worker-engine.js";
import { Database } from "../src/infrastructure/database.js";
import { RedisConnection } from "../src/infrastructure/redis.js";

const databaseUrl = process.env.BROWSER_V2_TEST_DATABASE_URL;
const run = databaseUrl && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;

run("browser v2 durable command worker", () => {
  const secret = "tok_worker_fixture_112233445566";
  const credentialId = `cred-${randomUUID()}`;
  const clientId = `client-${randomUUID()}`;
  const orderId = `order-${randomUUID()}`;
  let effects = { login: 0, credentials: 0, orders: 0 };
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let database: Database;
  let redis: RedisConnection;
  let lifecycle: BrowserLifecycleRepository;
  let effectRepository: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;
  let queue: BrowserExecutionQueueService;
  let engine: BrowserV2WorkerEngine;
  let sessionWorker: Worker;
  let commandWorker: Worker;
  let events: QueueEvents;

  beforeAll(async () => {
    server = createServer((request, response) => void fixture(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BROWSER_V2_ENABLED = "true";
    process.env.BROWSER_V2_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.BROWSER_V2_ARTIFACT_ROOT = `/tmp/browser-v2-worker-${randomUUID()}`;
    database = new Database();
    redis = new RedisConnection();
    const cipher = new BrowserProtectedValueCipher();
    lifecycle = new BrowserLifecycleRepository(database);
    effectRepository = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
    queue = new BrowserExecutionQueueService(redis, effectRepository, commands);
    engine = new BrowserV2WorkerEngine(commands, effectRepository);
    events = new QueueEvents(BROWSER_COMMAND_V2_QUEUE, { connection: redis.client });
    sessionWorker = new Worker(
      BROWSER_EXECUTION_V2_QUEUE,
      (job) => engine.open(job.data.sessionId),
      { connection: redis.client },
    );
    commandWorker = new Worker(
      BROWSER_COMMAND_V2_QUEUE,
      async (job) => {
        const command = await commands.claim(job.data.commandId);
        if (!command) return { replay: true };
        const claimToken = command.claim_token;
        if (!claimToken) throw new Error("claim_token_missing");
        try {
          const result = await engine.execute(command.session_id, command.safe_input);
          await commands.complete(command.id, claimToken, result);
          return result;
        } catch (error) {
          await commands.fail(command.id, claimToken, error);
          return { failed: true };
        }
      },
      { connection: redis.client },
    );
  });

  afterAll(async () => {
    await Promise.allSettled([sessionWorker?.close(), commandWorker?.close(), events?.close()]);
    if (engine) await engine.closeAll();
    if (queue) await queue.onModuleDestroy();
    if (redis) await redis.onModuleDestroy();
    if (database) await database.onModuleDestroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("completes a protected dependent mutation journey only through durable commands", async () => {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const projectId = randomUUID();
    const environmentId = randomUUID();
    await database.transaction(async (client) => {
      await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
        userId,
        randomUUID(),
        `${userId}@example.test`,
      ]);
      await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'worker',$2)", [
        workspaceId,
        `worker-${workspaceId}`,
      ]);
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'worker project')",
        [projectId, workspaceId],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin,disclosure_mode) VALUES($1,$2,'fixture',$3,'trusted_application_output')",
        [environmentId, projectId, origin],
      );
    });
    const loginPassword = await commands.createProtectedInput(workspaceId, {
      projectId,
      displayName: "login_password",
      value: "fixture-login-pass",
      expiresInSeconds: 3_600,
      idempotencyKey: "worker-login-password",
    });
    expect(
      (
        await commands.createProtectedInput(workspaceId, {
          projectId,
          displayName: "login_password",
          value: "fixture-login-pass",
          expiresInSeconds: 3_600,
          idempotencyKey: "worker-login-password",
        })
      ).replay,
    ).toBe(true);
    const unboundInput = await commands.createProtectedInput(workspaceId, {
      projectId,
      displayName: "unbound_password",
      value: "must-never-cross-session-boundary",
      expiresInSeconds: 3_600,
      idempotencyKey: "worker-unbound-password",
    });
    const mission = await lifecycle.startMission(workspaceId, {
      projectId,
      title: "Worker journey",
      instruction: "Create credentials then one order",
      provider: "codex",
      settings: {},
      idempotencyKey: "worker-mission-1",
    });
    const objective = await lifecycle.createObjective(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      title: "Create order",
      description: "",
      completionCriteria: { exactOrder: true },
      objectiveOrder: 0,
      idempotencyKey: "worker-objective-1",
    });
    const flow = await lifecycle.createFlow(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: "agent flow",
      purpose: "complete dependent operations",
      definition: {},
      idempotencyKey: "worker-flow-1",
    });
    const started = await lifecycle.startRun(workspaceId, {
      projectId,
      missionId: mission.missionId,
      objectiveId: objective.objectiveId,
      agentSessionId: mission.agentSessionId,
      flowId: flow.flowId,
      flowRevisionId: flow.flowRevisionId,
      environmentId,
      idempotencyKey: "worker-run-1",
      authenticationCommitLimit: 2,
      businessCommitLimit: 1,
      protectedInputIds: [loginPassword.protectedValueId],
    });
    expect(await queue.dispatchPending()).toBeGreaterThanOrEqual(1);
    await waitFor(() =>
      commands.sessionContext(started.browserSessionId).then((value) => value.ownerGeneration > 0),
    );
    expect((await lifecycle.observeMission(workspaceId, mission.missionId)).runs[0]).toMatchObject({
      disclosureMode: "trusted_application_output",
    });
    const leased = await commands.submit(started.browserSessionId, {
      idempotencyKey: "lease-probe",
      command: { kind: "observe" },
    });
    const firstClaim = await commands.claim(leased.commandId, 30_000);
    expect(firstClaim?.claim_token).toBeTruthy();
    await expect(commands.claim(leased.commandId, 30_000)).rejects.toThrow(
      "BROWSER_V2_COMMAND_ALREADY_RUNNING",
    );
    await database.query(
      "UPDATE browser_commands SET claim_lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [leased.commandId],
    );
    const recoveredClaim = await commands.claim(leased.commandId, 30_000);
    expect(recoveredClaim?.claim_token).not.toBe(firstClaim?.claim_token);
    await expect(
      commands.complete(leased.commandId, firstClaim!.claim_token!, { stale: true }),
    ).rejects.toThrow("BROWSER_V2_COMMAND_COMPLETION_CONFLICT");
    await commands.complete(leased.commandId, recoveredClaim!.claim_token!, { recovered: true });
    expect(await commands.observe(leased.commandId)).toMatchObject({
      state: "completed",
      result: { recovered: true },
    });
    await expect(
      commands.protectedValueForBrowser(started.browserSessionId, unboundInput.protectedValueId),
    ).rejects.toThrow("BROWSER_V2_PROTECTED_VALUE_UNAVAILABLE");
    const storedInput = await database.query<{ ciphertext: Buffer }>(
      "SELECT ciphertext FROM protected_values WHERE id=$1",
      [loginPassword.protectedValueId],
    );
    expect(storedInput.rows[0]?.ciphertext.toString("utf8")).not.toContain("fixture-login-pass");

    const loginPage = await command(
      started.browserSessionId,
      { kind: "navigate", url: `${origin}/login` },
      "navigate-login",
    );
    await command(
      started.browserSessionId,
      {
        kind: "fill",
        reference: control(loginPage, "Email"),
        publicValue: "operator@example.test",
      },
      "fill-email",
    );
    await command(
      started.browserSessionId,
      {
        kind: "fill",
        reference: control(loginPage, "Password"),
        protectedValueId: loginPassword.protectedValueId,
      },
      "fill-password",
    );
    const loginCommit = await command(
      started.browserSessionId,
      {
        kind: "commit",
        reference: control(loginPage, "Log in"),
        effectClass: "authentication",
        effectIdempotencyKey: "worker-login-effect",
        intentSummary: "Log in exactly once",
        timeoutMs: 2_000,
      },
      "commit-login",
    );
    expect(loginCommit.capture).toMatchObject({
      status: 303,
      contentClass: "http_text",
      redirectChain: [{ status: 303, sameOrigin: true }],
    });
    expect((loginCommit.successorObservation as { text: string }).text).toBe("[QUARANTINED]");
    const loginEffectId = String(loginCommit.effectId);
    const loginCapture = loginCommit.capture as { captureId: string };
    await command(
      started.browserSessionId,
      {
        kind: "discard_capture",
        effectId: loginEffectId,
        captureId: loginCapture.captureId,
      },
      "discard-login-response-with-no-required-output",
    );
    await failedCommand(
      started.browserSessionId,
      { kind: "close" },
      "close-with-pending-login-outcome",
      `BROWSER_V2_EFFECT_OUTCOME_PENDING:${loginEffectId}`,
    );
    await command(
      started.browserSessionId,
      {
        kind: "determine",
        effectId: loginEffectId,
        outcome: "applied",
        source: "owned_login_response",
      },
      "determine-login",
    );

    const navigateHome = { kind: "navigate", url: `${origin}/` } as const;
    const first = await command(started.browserSessionId, navigateHome, "navigate-home");
    const navigateReplay = await commands.submit(started.browserSessionId, {
      idempotencyKey: "navigate-home".padEnd(8, "-"),
      command: navigateHome,
    });
    expect(navigateReplay).toMatchObject({ replay: true, state: "completed" });
    const createCredentialRef = control(first, "Create credential");
    await failedCommand(
      started.browserSessionId,
      { kind: "click", reference: createCredentialRef },
      "unsafe-ordinary-click",
      "BROWSER_V2_MUTATION_REQUIRES_COMMIT",
    );
    expect(effects.credentials).toBe(0);
    const credentialCommit = await command(
      started.browserSessionId,
      {
        kind: "commit",
        reference: createCredentialRef,
        effectClass: "authentication",
        effectIdempotencyKey: "worker-credential-effect",
        intentSummary: "Create exactly one credential",
        timeoutMs: 10_000,
      },
      "commit-credential",
    );
    const credentialEffectId = String(credentialCommit.effectId);
    const credentialCapture = credentialCommit.capture as { captureId: string };
    const recoveredCommit = await command(
      started.browserSessionId,
      {
        kind: "commit",
        reference: createCredentialRef,
        effectClass: "authentication",
        effectIdempotencyKey: "worker-credential-effect",
        intentSummary: "Create exactly one credential",
        timeoutMs: 10_000,
      },
      "recover-lost-commit-ack",
    );
    expect(recoveredCommit).toMatchObject({
      replay: true,
      effectId: credentialEffectId,
      capture: { captureId: credentialCapture.captureId },
    });
    expect(effects.credentials).toBe(1);
    const credentialPublished = await command(
      started.browserSessionId,
      {
        kind: "publish_capture",
        effectId: credentialEffectId,
        captureId: credentialCapture.captureId,
        selections: [
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
        ],
      },
      "publish-credential",
    );
    await command(
      started.browserSessionId,
      {
        kind: "determine",
        effectId: credentialEffectId,
        outcome: "applied",
        source: "exact_credential_identity_in_owned_response",
      },
      "determine-credential",
    );

    const credentialPage = await command(
      started.browserSessionId,
      { kind: "observe" },
      "observe-credential-dialog",
    );
    const domCapture = await command(
      started.browserSessionId,
      {
        kind: "capture_dom",
        effectId: credentialEffectId,
        reference: region(credentialPage, "Generated credential"),
      },
      "capture-credential-dialog",
    );
    const domReceipt = domCapture.capture as {
      captureId: string;
      structuralIndex: Array<{ path: Array<string | number>; publicValue?: unknown }>;
    };
    expect(
      domReceipt.structuralIndex.find((node) => node.path.join(".") === "children.0.semanticHint"),
    ).toMatchObject({ classification: "uncertain", kind: "string" });
    const domPublished = await command(
      started.browserSessionId,
      {
        kind: "publish_capture",
        effectId: credentialEffectId,
        captureId: domReceipt.captureId,
        selections: [
          { key: "dialogSecret", path: ["children", 0, "text"], classification: "protected" },
        ],
      },
      "publish-credential-dialog",
    );
    expect((domPublished.protectedReferences as Record<string, string>).dialogSecret).toMatch(
      /^[0-9a-f-]{36}$/u,
    );

    const orderPage = await command(
      started.browserSessionId,
      { kind: "navigate", url: `${origin}/orders` },
      "navigate-orders",
    );
    await command(
      started.browserSessionId,
      { kind: "fill", reference: control(orderPage, "Client ID"), publicValue: clientId },
      "fill-client-id",
    );
    await command(
      started.browserSessionId,
      {
        kind: "fill",
        reference: control(orderPage, "Client secret"),
        protectedValueId: String(
          (credentialPublished.protectedReferences as Record<string, string>).clientSecret,
        ),
      },
      "fill-client-secret",
    );
    const refreshed = await command(
      started.browserSessionId,
      { kind: "observe" },
      "observe-orders",
    );
    const orderCommit = await command(
      started.browserSessionId,
      {
        kind: "commit",
        reference: control(refreshed, "Create order"),
        effectClass: "business",
        effectIdempotencyKey: "worker-order-effect",
        intentSummary: "Create exactly one order",
        timeoutMs: 10_000,
      },
      "commit-order",
    );
    const orderEffectId = String(orderCommit.effectId);
    const orderCapture = orderCommit.capture as { captureId: string };
    await command(
      started.browserSessionId,
      {
        kind: "publish_capture",
        effectId: orderEffectId,
        captureId: orderCapture.captureId,
        selections: [
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
        ],
      },
      "publish-order",
    );
    await command(
      started.browserSessionId,
      {
        kind: "determine",
        effectId: orderEffectId,
        outcome: "applied",
        source: "exact_order_identity_in_owned_response",
      },
      "determine-order",
    );
    const owner = await commands.sessionContext(started.browserSessionId);
    const controller = new BrowserLifecycleController(lifecycle, effectRepository, commands, queue);
    await controller.finalizeRun(
      started.runId,
      {
        kind: "user",
        subject: userId,
        userId,
        email: `${userId}@example.test`,
        workspaceId,
        role: "owner",
      },
      {
        ownerGeneration: owner.ownerGeneration,
        outcome: "passed",
        conclusion: "Credential and exact order created once",
      },
    );
    expect(await commands.evidenceComplete(started.browserSessionId)).toBe(true);
    await lifecycle.publishReport(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      summary: `Passed without exposing ${secret}`,
      safeReport: { orderId, completed: true, attemptedLeak: secret },
    });
    expect(await commands.publicValuesForSession(started.browserSessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: credentialId }),
        expect.objectContaining({ value: clientId }),
        expect.objectContaining({ value: orderId }),
      ]),
    );
    expect(effects).toEqual({ login: 1, credentials: 1, orders: 1 });
    const stored = await database.query<{ state: string }>(
      "SELECT state FROM missions WHERE id=$1",
      [mission.missionId],
    );
    expect(stored.rows[0]?.state).toBe("completed");
    const storedReport = await database.query<{ summary: string; safe_report: unknown }>(
      "SELECT summary,safe_report FROM mission_reports WHERE mission_id=$1",
      [mission.missionId],
    );
    expect(JSON.stringify(storedReport.rows[0])).not.toContain(secret);
    expect(JSON.stringify(storedReport.rows[0])).toContain(orderId);
    const publicDecisions = await database.query<{
      admissionMode: string | null;
      semantic: string | null;
      evidenceDigest: string | null;
      proposalDigest: string | null;
    }>(
      `SELECT public_admission_mode AS "admissionMode",public_semantic AS semantic,
         public_evidence_digest AS "evidenceDigest",public_proposal_digest AS "proposalDigest"
       FROM browser_protection_decisions WHERE session_id=$1 AND label='public'`,
      [started.browserSessionId],
    );
    expect(publicDecisions.rowCount).toBeGreaterThan(0);
    expect(publicDecisions.rows.every((decision) => Object.values(decision).every(Boolean))).toBe(
      true,
    );
  }, 90_000);

  async function command(
    sessionId: string,
    value: BrowserCommandV2,
    key: string,
  ): Promise<Record<string, unknown>> {
    const submitted = await commands.submit(sessionId, {
      idempotencyKey: key.padEnd(8, "-"),
      command: value,
    });
    await queue.dispatchPendingCommands();
    const job = await queue.commandQueue.getJob(submitted.commandId);
    await job!.waitUntilFinished(events, 30_000);
    const observed = (await commands.observe(submitted.commandId)) as unknown as {
      state: string;
      result: Record<string, unknown>;
      errorCode?: string;
    };
    expect(observed.state, observed.errorCode).toBe("completed");
    return observed.result;
  }

  async function failedCommand(
    sessionId: string,
    value: BrowserCommandV2,
    key: string,
    errorCode: string,
  ): Promise<void> {
    const submitted = await commands.submit(sessionId, {
      idempotencyKey: key.padEnd(8, "-"),
      command: value,
    });
    await queue.dispatchPendingCommands();
    const job = await queue.commandQueue.getJob(submitted.commandId);
    await job!.waitUntilFinished(events, 30_000);
    const observed = (await commands.observe(submitted.commandId)) as unknown as {
      state: string;
      errorCode: string;
    };
    expect(observed).toMatchObject({ state: "failed", errorCode });
  }

  function control(observation: Record<string, unknown>, name: string): string {
    const found = (observation.controls as Array<{ reference: string; name: string }>).find(
      (item) => item.name === name,
    );
    if (!found) throw new Error(`control_not_found:${name}`);
    return found.reference;
  }

  function region(observation: Record<string, unknown>, name: string): string {
    const found = (observation.regions as Array<{ reference: string; name: string }>).find(
      (item) => item.name === name,
    );
    if (!found) throw new Error(`region_not_found:${name}`);
    return found.reference;
  }

  async function fixture(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/login")
      return html(
        response,
        `<!doctype html><form method="post" action="/api/login"><label>Email<input aria-label="Email" name="email"></label><label>Password<input aria-label="Password" name="password" type="password"></label><button type="submit">Log in</button></form>`,
      );
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = new URLSearchParams(await bodyText(request));
      if (
        body.get("email") !== "operator@example.test" ||
        body.get("password") !== "fixture-login-pass"
      )
        return json(response, 403, { error: "forbidden" });
      effects.login += 1;
      response.writeHead(303, { location: "/authenticated", "content-type": "text/html" });
      return response.end('<!doctype html><a href="/authenticated">Continue</a>');
    }
    if (request.method === "GET" && url.pathname === "/authenticated")
      return html(response, "<!doctype html><main>Authenticated</main>");
    if (request.method === "GET" && url.pathname === "/")
      return html(
        response,
        `<!doctype html><button id="credential">Create credential</button><script>credential.onclick=async()=>{const r=await fetch('/api/credentials',{method:'POST'});const data=(await r.json()).data;document.body.dataset.done=data.credentialId;const dialog=document.createElement('dialog');dialog.open=true;dialog.setAttribute('aria-label','Generated credential');const secret=document.createElement('span');secret.setAttribute('aria-label','Client secret');secret.textContent=data.clientSecret;dialog.append(secret);document.body.append(dialog)}</script>`,
      );
    if (request.method === "POST" && url.pathname === "/api/credentials") {
      effects.credentials += 1;
      return json(response, 201, { data: { credentialId, clientId, clientSecret: secret } });
    }
    if (request.method === "GET" && url.pathname === "/orders")
      return html(
        response,
        `<!doctype html><label>Client ID<input aria-label="Client ID" id="client"></label><label>Client secret<input aria-label="Client secret" id="secret" type="password"></label><button id="order">Create order</button><script>order.onclick=async()=>{await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientId:client.value,clientSecret:secret.value})})}</script>`,
      );
    if (request.method === "POST" && url.pathname === "/api/orders") {
      const body = JSON.parse(await bodyText(request)) as {
        clientId: string;
        clientSecret: string;
      };
      if (body.clientId !== clientId || body.clientSecret !== secret)
        return json(response, 403, { error: "forbidden" });
      effects.orders += 1;
      return json(response, 201, { data: { orderId, completed: true } });
    }
    response.writeHead(404).end();
  }
});

function html(response: ServerResponse, body: string) {
  response.writeHead(200, { "content-type": "text/html" });
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
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("wait_timeout");
}
