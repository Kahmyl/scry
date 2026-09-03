import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserCommandV2 } from "@scry/contracts";

import { BrowserCommandRepository } from "../src/browser-execution/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/browser-execution.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/browser-lifecycle.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserV2WorkerEngine } from "../src/browser-execution/browser-v2-worker-engine.js";
import { Database } from "../src/infrastructure/database.js";

const databaseUrl = process.env.BROWSER_V2_TEST_DATABASE_URL;
const run = databaseUrl && process.env.SCRY_BROWSER_E2E === "1" ? describe : describe.skip;

run("browser v2 failed Run finalization", () => {
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let database: Database;
  let lifecycle: BrowserLifecycleRepository;
  let effects: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;
  let engine: BrowserV2WorkerEngine;
  let fixtureEffects = 0;

  beforeAll(async () => {
    server = createServer((request, response) => void fixture(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.BROWSER_V2_ENABLED = "true";
    process.env.BROWSER_V2_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    process.env.BROWSER_V2_ARTIFACT_ROOT = `/private/tmp/browser-v2-failure-finalization-${randomUUID()}`;
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    lifecycle = new BrowserLifecycleRepository(database);
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
    engine = new BrowserV2WorkerEngine(commands, effects);
  });

  afterAll(async () => {
    await engine?.closeAll();
    await database?.onModuleDestroy();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });

  it("closes, preserves UNKNOWN, and publishes a failure report without redispatch", async () => {
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
      await client.query(
        "INSERT INTO workspaces(id,name,slug) VALUES($1,'failure finalization',$2)",
        [workspaceId, `failure-${workspaceId}`],
      );
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'failure project')",
        [projectId, workspaceId],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin) VALUES($1,$2,'fixture',$3)",
        [environmentId, projectId, origin],
      );
    });
    const mission = await lifecycle.startMission(workspaceId, {
      projectId,
      title: "Failure finalization",
      instruction: "Stop accurately after an unresolved outcome",
      idempotencyKey: `failure-mission-${projectId}`,
      provider: "codex",
      settings: {},
    });
    const objective = await lifecycle.createObjective(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      title: "Attempt item",
      description: "",
      completionCriteria: { exact: true },
      objectiveOrder: 0,
      idempotencyKey: `failure-objective-${projectId}`,
    });
    const flow = await lifecycle.createFlow(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: "attempt",
      purpose: "attempt once",
      definition: {},
      idempotencyKey: `failure-flow-${projectId}`,
    });
    const started = await lifecycle.startRun(workspaceId, {
      projectId,
      missionId: mission.missionId,
      objectiveId: objective.objectiveId,
      agentSessionId: mission.agentSessionId,
      flowId: flow.flowId,
      flowRevisionId: flow.flowRevisionId,
      environmentId,
      idempotencyKey: `failure-run-${projectId}`,
      authenticationCommitLimit: 0,
      businessCommitLimit: 1,
      protectedInputIds: [],
    });
    const owner = await engine.open(started.browserSessionId);
    const page = await command(
      started.browserSessionId,
      { kind: "navigate", url: origin },
      "navigate-failure-page",
    );
    const reference = (page.controls as Array<{ name: string; reference: string }>).find(
      ({ name }) => name === "Create item",
    )?.reference;
    if (!reference) throw new Error("create_control_missing");
    const committed = await command(
      started.browserSessionId,
      {
        kind: "commit",
        reference,
        effectClass: "business",
        effectIdempotencyKey: "failure-effect-once",
        intentSummary: "Create one item",
        timeoutMs: 5_000,
      },
      "commit-failure-item",
    );
    const effectId = String(committed.effectId);
    const captureId = String((committed.capture as { captureId: string }).captureId);
    await command(
      started.browserSessionId,
      { kind: "discard_capture", effectId, captureId },
      "discard-failure-capture",
    );
    await command(started.browserSessionId, { kind: "close_for_failure" }, "close-for-failure");
    expect(await commands.evidenceComplete(started.browserSessionId)).toBe(true);
    expect(await effects.observeEffect(effectId)).toMatchObject({
      dispatch_state: "acknowledged",
      mutation_outcome: "unknown",
      determination_source: "failure_finalized_after_dispatch",
      publication_state: "discarded",
    });
    await effects.finalizeFailedSession(started.browserSessionId, owner.ownerGeneration);
    await lifecycle.markRunTerminal(
      workspaceId,
      started.runId,
      "application_failure",
      "Stopped with unresolved effect and no replay",
    );
    const report = await lifecycle.publishReport(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      summary: "Failed safely",
      safeReport: { outcome: "application_failure", unknownEffects: 1 },
    });
    expect(report.replay).toBe(false);
    expect(fixtureEffects).toBe(1);
    const state = await database.query<{
      session_state: string;
      run_state: string;
      mission_state: string;
    }>(
      `SELECT s.state AS session_state,r.state AS run_state,m.state AS mission_state
       FROM browser_execution_sessions s JOIN runs r ON r.id=s.run_id JOIN missions m ON m.id=r.mission_id WHERE s.id=$1`,
      [started.browserSessionId],
    );
    expect(state.rows[0]).toEqual({
      session_state: "completed",
      run_state: "failed",
      mission_state: "completed",
    });
  }, 60_000);

  async function command(
    sessionId: string,
    value: BrowserCommandV2,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const submitted = await commands.submit(sessionId, { idempotencyKey, command: value });
    const claimed = await commands.claim(submitted.commandId);
    if (!claimed?.claim_token) throw new Error("command_claim_failed");
    try {
      const result = await engine.execute(sessionId, claimed.safe_input);
      await commands.complete(claimed.id, claimed.claim_token, result);
      return result;
    } catch (error) {
      await commands.fail(claimed.id, claimed.claim_token, error);
      throw error;
    }
  }

  async function fixture(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><button id="create">Create item</button><section aria-live="polite" id="result"></section><script>create.onclick=async()=>{const r=await fetch('/items',{method:'POST'});const x=await r.json();result.textContent='Created '+x.id}</script>`,
      );
      return;
    }
    if (request.method === "POST" && request.url === "/items") {
      fixtureEffects += 1;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `item-${fixtureEffects}` }));
      return;
    }
    response.writeHead(404).end();
  }
});
