import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";

const databaseUrl = process.env.BROWSER_V2_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("browser v2 Mission/Flow/Run lifecycle", () => {
  let database: Database;
  let lifecycle: BrowserLifecycleRepository;
  let execution: BrowserExecutionRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BROWSER_V2_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    lifecycle = new BrowserLifecycleRepository(database);
    execution = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
  });

  afterAll(async () => {
    if (database) await database.onModuleDestroy();
  });

  it("lets the agent create multiple Flows in one Mission and reports only after durable completion", async () => {
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
      await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'lifecycle',$2)", [
        workspaceId,
        `lifecycle-${workspaceId}`,
      ]);
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'lifecycle project')",
        [projectId, workspaceId],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin) VALUES($1,$2,'fixture','https://fixture.example')",
        [environmentId, projectId],
      );
    });
    const mission = await lifecycle.startMission(workspaceId, {
      projectId,
      title: "Complete a browser task",
      instruction: "Use as many flows as useful",
      idempotencyKey: "mission-lifecycle-1",
      provider: "codex",
      settings: {},
    });
    const objective = await lifecycle.createObjective(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      title: "Complete exact resource",
      description: "",
      completionCriteria: { exactIdentity: true },
      objectiveOrder: 0,
      idempotencyKey: "objective-lifecycle-1",
    });
    const primary = await lifecycle.createFlow(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: "primary exploration",
      purpose: "understand the app",
      definition: { approach: "browser" },
      idempotencyKey: "flow-lifecycle-primary",
    });
    const resumed = await lifecycle.createFlow(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: "resumed completion",
      purpose: "continue the same mission after learning",
      definition: { approach: "documented API" },
      idempotencyKey: "flow-lifecycle-resumed",
    });
    expect(primary.flowId).not.toBe(resumed.flowId);
    expect(
      await lifecycle.createFlow(workspaceId, mission.missionId, {
        agentSessionId: mission.agentSessionId,
        name: "resumed completion",
        purpose: "continue the same mission after learning",
        definition: { approach: "documented API" },
        idempotencyKey: "flow-lifecycle-resumed",
      }),
    ).toMatchObject({ flowId: resumed.flowId, replay: true });

    const started = await lifecycle.startRun(workspaceId, {
      projectId,
      missionId: mission.missionId,
      objectiveId: objective.objectiveId,
      agentSessionId: mission.agentSessionId,
      flowId: resumed.flowId,
      flowRevisionId: resumed.flowRevisionId,
      environmentId,
      idempotencyKey: "run-lifecycle-resumed",
      authenticationCommitLimit: 1,
      businessCommitLimit: 1,
      protectedInputIds: [],
    });
    const owner = await execution.claimOwner(started.browserSessionId, "lifecycle-worker", 60_000);
    const chainHead = createHash("sha256").update("authenticated-evidence-chain").digest("hex");
    await database.query(
      `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,
         replay_artifact_key,video_artifact_key,retention_expires_at,completed_at)
       VALUES($1,$2,$3,'complete',$4,1,128,'object://replay','object://video',now()+interval '30 days',now())`,
      [randomUUID(), started.browserSessionId, started.runId, chainHead],
    );
    await execution.finalizeSession(started.browserSessionId, owner.generation);
    await lifecycle.markRunTerminal(
      workspaceId,
      started.runId,
      "passed",
      "Exact resource completed and verified",
    );
    const report = await lifecycle.publishReport(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      summary: "Mission completed",
      safeReport: { result: "passed", flowsUsed: 1 },
    });
    expect(report.replay).toBe(false);
    const observed = (await lifecycle.observeMission(
      workspaceId,
      mission.missionId,
    )) as unknown as {
      state: string;
      flows: unknown[];
      runs: Array<{ flowId: string; state: string }>;
    };
    expect(observed.state).toBe("completed");
    expect(observed.flows).toHaveLength(2);
    expect(observed.runs).toEqual([
      expect.objectContaining({ flowId: resumed.flowId, state: "passed" }),
    ]);
    const storedReport = await database.query<{ evidence_digest: string }>(
      "SELECT evidence_digest FROM mission_reports WHERE id=$1",
      [report.reportId],
    );
    expect(storedReport.rows[0]?.evidence_digest).toBe(
      createHash("sha256")
        .update(JSON.stringify([chainHead]))
        .digest("hex"),
    );
  });

  it("publishes a terminal cancellation report without erasing an unrecoverable UNKNOWN", async () => {
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
      await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'cancel lifecycle',$2)", [
        workspaceId,
        `cancel-${workspaceId}`,
      ]);
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'cancel project')",
        [projectId, workspaceId],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin) VALUES($1,$2,'fixture','https://fixture.example')",
        [environmentId, projectId],
      );
    });
    const mission = await lifecycle.startMission(workspaceId, {
      projectId,
      title: "Cancel safely",
      instruction: "Stop accurately after a lost response",
      idempotencyKey: `cancel-mission-${projectId}`,
      provider: "codex",
      settings: {},
    });
    const objective = await lifecycle.createObjective(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      title: "Attempt exact resource",
      description: "",
      completionCriteria: { exactIdentity: true },
      objectiveOrder: 0,
      idempotencyKey: `cancel-objective-${projectId}`,
    });
    const flow = await lifecycle.createFlow(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: "single attempt",
      purpose: "exercise cancellation",
      definition: {},
      idempotencyKey: `cancel-flow-${projectId}`,
    });
    const started = await lifecycle.startRun(workspaceId, {
      projectId,
      missionId: mission.missionId,
      objectiveId: objective.objectiveId,
      agentSessionId: mission.agentSessionId,
      flowId: flow.flowId,
      flowRevisionId: flow.flowRevisionId,
      environmentId,
      idempotencyKey: `cancel-run-${projectId}`,
      authenticationCommitLimit: 0,
      businessCommitLimit: 1,
      protectedInputIds: [],
    });
    const owner = await execution.claimOwner(started.browserSessionId, "cancel-worker", 60_000);
    const admitted = await execution.admitEffect({
      sessionId: started.browserSessionId,
      ownerGeneration: owner.generation,
      documentEpoch: 1,
      idempotencyKey: "cancel-effect-unknown",
      effectClass: "business",
      expectedOrigin: "https://fixture.example",
      targetDigest: createHash("sha256").update("cancel-target").digest("hex"),
      actionDigest: createHash("sha256").update("cancel-action").digest("hex"),
      intentSummary: "submit once",
    });
    await execution.markDispatchStarted(admitted.effect.id, owner.generation);
    await execution.markUnknown(
      admitted.effect.id,
      owner.generation,
      "response_lost_after_dispatch",
    );
    const chainHead = createHash("sha256").update("cancel-evidence-chain").digest("hex");
    await database.query(
      `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,replay_artifact_key,retention_expires_at,completed_at)
       VALUES($1,$2,$3,'complete',$4,1,64,'local://cancel-evidence',now()+interval '30 days',now())`,
      [randomUUID(), started.browserSessionId, started.runId, chainHead],
    );
    await execution.finalizeFailedSession(started.browserSessionId, owner.generation);
    await lifecycle.markRunTerminal(
      workspaceId,
      started.runId,
      "cancelled",
      "Stopped after an unrecoverable response loss without replay",
    );
    const report = await lifecycle.publishReport(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      summary: "Cancelled safely with one unresolved effect",
      safeReport: { outcome: "cancelled", unknownEffects: 1 },
    });
    expect(report.replay).toBe(false);
    expect(await execution.observeEffect(admitted.effect.id)).toMatchObject({
      mutation_outcome: "unknown",
    });
    const observed = (await lifecycle.observeMission(
      workspaceId,
      mission.missionId,
    )) as unknown as {
      state: string;
      objectives: Array<{ state: string }>;
      runs: Array<{ state: string }>;
    };
    expect(observed).toMatchObject({
      state: "completed",
      objectives: [{ state: "failed" }],
      runs: [{ state: "cancelled" }],
    });
  });
});
