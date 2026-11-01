import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";
import { seedSession } from "./fixtures/browser-session.js";
import { publishFixtureEvidence } from "./fixtures/evidence-recording.js";

const target = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = target ? describe : describe.skip;
run("database-wide browser lifetime capacity", () => {
  let db: Database;
  let execution: BrowserExecutionRepository;
  let lifecycle: BrowserLifecycleRepository;
  let session: string;
  let baseline: number;
  let scope: {
    projectId: string;
    missionId: string;
    objectiveId: string;
    agentSessionId: string;
    environmentId: string;
    flowId: string;
    flowRevisionId: string;
    workspaceId: string;
  };
  const count = async () =>
    Number(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM browser_execution_sessions WHERE state='active'",
        )
      ).rows[0]!.n,
    );
  const start = () =>
    lifecycle.startRun(scope.workspaceId, {
      ...scope,
      idempotencyKey: randomUUID(),
      authenticationCommitLimit: 1,
      businessCommitLimit: 1,
      protectedInputIds: [],
    });
  const legacyInput = async () => {
    const id = randomUUID(),
      runId = randomUUID();
    await db.query(
      `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        runId,
        scope.projectId,
        scope.missionId,
        scope.objectiveId,
        scope.agentSessionId,
        scope.flowId,
        scope.flowRevisionId,
        scope.environmentId,
        randomUUID(),
      ],
    );
    return {
      ...scope,
      id,
      runId,
      authenticationCommitLimit: 1,
      businessCommitLimit: 1,
      allowedFirstPartyOrigins: ["https://fixture.example"],
      idempotencyKey: randomUUID(),
    };
  };
  // No physical browser exists in this relational fixture. The actual admitted
  // evidence/owner retirement lifecycle is used; native process proof is separate.
  const finish = async (id: string) => {
    const owner = await execution.claimOwner(id, "capacity-fixture", 60000);
    await publishFixtureEvidence(db, execution, id, owner.generation);
    await execution.retireOwner({
      owner: { sessionId: id, generation: owner.generation, leaseToken: owner.leaseToken },
      browserStopped: true,
      recordingDrained: true,
    });
    await execution.finalizeSession(id, owner.generation);
  };
  beforeAll(() => {
    process.env.DATABASE_URL = target;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    db = new Database();
    execution = new BrowserExecutionRepository(db, new BrowserProtectedValueCipher());
    lifecycle = new BrowserLifecycleRepository(db, new BrowserRuntimeVeilReportProtection());
  });
  beforeEach(async () => {
    baseline = await count();
    // Other tests leave metadata-only sessions, not live browsers. Reserve
    // exactly one remaining slot above that inventory, without deleting it.
    vi.stubEnv("SCRY_BROWSER_MAX_LIVE_SESSIONS", String(baseline + 1));
    session = await seedSession(db, execution, "https://fixture.example");
    scope = (
      await db.query<typeof scope>(
        `SELECT s.project_id AS "projectId",s.mission_id AS "missionId",
      s.objective_id AS "objectiveId",s.agent_session_id AS "agentSessionId",s.environment_id AS "environmentId",
      r.flow_id AS "flowId",r.flow_revision_id AS "flowRevisionId",p.workspace_id AS "workspaceId"
      FROM browser_execution_sessions s JOIN runs r ON r.id=s.run_id JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
        [session],
      )
    ).rows[0]!;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (db) await db.onModuleDestroy();
  });

  it("refuses both start paths without side effects, preserves exact retries, and serializes competing starts", async () => {
    expect(
      (
        await db.query(
          "SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='browser_execution_sessions_live_capacity_idx'",
        )
      ).rowCount,
    ).toBe(1);
    const existing = (
      await db.query<any>("SELECT * FROM browser_execution_sessions WHERE id=$1", [session])
    ).rows[0];
    await expect(
      execution.createSession({
        ...scope,
        id: session,
        runId: existing.run_id,
        authenticationCommitLimit: 1,
        businessCommitLimit: 0,
        allowedFirstPartyOrigins: ["https://fixture.example"],
        idempotencyKey: existing.idempotency_key,
      }),
    ).resolves.toMatchObject({ id: session });
    const legacy = await legacyInput();
    const before = await db.query("SELECT id FROM runs WHERE mission_id=$1", [scope.missionId]);
    const refusals = await Promise.allSettled([start(), execution.createSession(legacy)]);
    expect(refusals.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const result of refusals)
      if (result.status === "rejected")
        expect(String(result.reason)).toContain("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    expect(await count()).toBe(baseline + 1);
    expect(
      (await db.query("SELECT id FROM runs WHERE mission_id=$1", [scope.missionId])).rowCount,
    ).toBe(before.rowCount);
    expect(
      (await db.query("SELECT 1 FROM browser_execution_outbox WHERE session_id=$1", [legacy.id]))
        .rowCount,
    ).toBe(0);
    await lifecycle.markRunTerminal(
      scope.workspaceId,
      existing.run_id,
      "cancelled",
      "Fixture terminal label does not prove physical closure.",
    );
    await expect(start()).rejects.toThrow("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    await finish(session);
    const race = await Promise.allSettled([start(), execution.createSession(legacy), start()]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count()).toBe(baseline + 1);
    const winner = race.find((r) => r.status === "fulfilled")!;
    if (winner.status === "fulfilled") {
      const id =
        "browserSessionId" in winner.value ? winner.value.browserSessionId : winner.value.id;
      await finish(id);
    }
    expect(await count()).toBe(baseline);
    const duplicate = {
      ...scope,
      idempotencyKey: randomUUID(),
      authenticationCommitLimit: 1,
      businessCommitLimit: 1,
      protectedInputIds: [],
    };
    const retries = await Promise.all([
      lifecycle.startRun(scope.workspaceId, duplicate),
      lifecycle.startRun(scope.workspaceId, duplicate),
    ]);
    expect(new Set(retries.map((r) => r.runId)).size).toBe(1);
    expect(retries.map((r) => r.replay).sort()).toEqual([false, true]);
    await finish(retries[0]!.browserSessionId);
    await expect(
      lifecycle.startRun(scope.workspaceId, {
        ...duplicate,
        idempotencyKey: randomUUID(),
        flowRevisionId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(baseline);
    const afterRollback = await start();
    await finish(afterRollback.browserSessionId);
  });

  it("holds capacity through owner loss and stale retirement until recovered closure completes", async () => {
    const old = await execution.claimOwner(session, "capacity-old", 60000);
    await db.query(
      "UPDATE browser_owner_generations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND generation=$2",
      [session, old.generation],
    );
    await expect(start()).rejects.toThrow("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    const current = await execution.claimOwner(session, "capacity-recovery", 60000);
    await execution.retireOwner({
      owner: { sessionId: session, generation: old.generation, leaseToken: old.leaseToken },
      browserStopped: true,
      recordingDrained: true,
    });
    await expect(start()).rejects.toThrow("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    await publishFixtureEvidence(db, execution, session, current.generation, false, {
      recordingComplete: false,
    });
    await execution.retireOwner({
      owner: { sessionId: session, generation: current.generation, leaseToken: current.leaseToken },
      browserStopped: true,
      recordingDrained: true,
    });
    await expect(start()).rejects.toThrow("SCRY_BROWSER_SESSION_CAPACITY_EXHAUSTED");
    await execution.finalizeFailedSession(session, current.generation);
    const next = await start();
    await finish(next.browserSessionId);
    expect(await count()).toBe(baseline);
  });
});
