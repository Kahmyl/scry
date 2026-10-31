import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserLifecycleRepository } from "../src/browser-execution/repositories/browser-lifecycle.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { BrowserRuntimeVeilReportProtection } from "../src/browser-execution/browser-boundary-composition.js";
import { Database } from "../src/infrastructure/database.js";
import { publishFixtureEvidence } from "./fixtures/evidence-recording.js";
import { ChronicleRepository } from "@scry/chronicle";
import { seedSession } from "./fixtures/browser-session.js";

const databaseUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("browser baseline Mission/Flow/Run lifecycle", () => {
  let database: Database;
  let lifecycle: BrowserLifecycleRepository;
  let execution: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    lifecycle = new BrowserLifecycleRepository(database, new BrowserRuntimeVeilReportProtection());
    execution = new BrowserExecutionRepository(database, new BrowserProtectedValueCipher());
    commands = new BrowserCommandRepository(database, new BrowserProtectedValueCipher());
  });

  afterAll(async () => {
    if (database) await database.onModuleDestroy();
  });

  it("publishes an honest failure-only report from sealed admitted partial evidence", async () => {
    const sessionId = await seedSession(database, execution, "https://fixture.example");
    const scope = (
      await database.query<any>(
        `SELECT s.run_id AS "runId",s.mission_id AS "missionId",s.agent_session_id AS "agentSessionId",p.workspace_id AS "workspaceId"
       FROM browser_execution_sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
        [sessionId],
      )
    ).rows[0]!;
    const owner = await execution.claimOwner(sessionId, "partial-report-fixture", 60000);
    const completion = await publishFixtureEvidence(
      database,
      execution,
      sessionId,
      owner.generation,
      false,
      { recordingComplete: false },
    );
    expect(completion.state).toBe("incomplete");
    await expect(execution.finalizeSession(sessionId, owner.generation)).rejects.toThrow(
      "SCRY_BROWSER_EVIDENCE_INCOMPLETE",
    );
    await execution.finalizeFailedSession(sessionId, owner.generation);
    await lifecycle.markRunTerminal(
      scope.workspaceId,
      scope.runId,
      "environment_failure",
      "Recording unavailable; no business outcome inferred.",
    );
    const report = await lifecycle.publishReport(scope.workspaceId, scope.missionId, {
      agentSessionId: scope.agentSessionId,
      summary: "The attempt failed with incomplete recording coverage.",
      safeReport: {
        presentation: { limitations: ["Recording unavailable; testing was not completed."] },
        evidenceCoverage: { complete: 999 },
      },
    });
    const stored = (
      await database.query<any>(
        "SELECT state,evidence_coverage,safe_report FROM mission_reports WHERE id=$1",
        [report.reportId],
      )
    ).rows[0]!;
    expect(stored.state).toBe("final");
    expect(stored.evidence_coverage).toMatchObject({
      runs: 1,
      complete: 0,
      incomplete: 1,
      open: 0,
    });
    expect(stored.safe_report.evidenceCoverage).toEqual(stored.evidence_coverage);
    expect(
      (
        await database.query<any>(
          "SELECT state FROM browser_evidence_streams WHERE session_id=$1",
          [sessionId],
        )
      ).rows[0]?.state,
    ).toBe("incomplete");
  });

  it("keeps a retried Objective running until all active attempts finish while retaining individual conclusions", async () => {
    const session = await seedSession(database, execution, "https://fixture.example");
    const scope = (
      await database.query<any>(
        `SELECT s.project_id AS "projectId",s.mission_id AS "missionId",s.objective_id AS "objectiveId",s.environment_id AS "environmentId",s.agent_session_id AS "agentSessionId",s.run_id AS "runId",r.flow_id AS "flowId",r.flow_revision_id AS "flowRevisionId",p.workspace_id AS "workspaceId" FROM browser_execution_sessions s JOIN runs r ON r.id=s.run_id JOIN projects p ON p.id=s.project_id WHERE s.id=$1`,
        [session],
      )
    ).rows[0]!;
    const objective = async () =>
      (
        await database.query<{ state: string; conclusion: string | null }>(
          "SELECT state,conclusion FROM mission_objectives WHERE id=$1",
          [scope.objectiveId],
        )
      ).rows[0]!;
    await lifecycle.markRunTerminal(
      scope.workspaceId,
      scope.runId,
      "blocked",
      "First trial was refused.",
    );
    const start = () =>
      lifecycle.startRun(scope.workspaceId, {
        projectId: scope.projectId,
        missionId: scope.missionId,
        objectiveId: scope.objectiveId,
        agentSessionId: scope.agentSessionId,
        flowId: scope.flowId,
        flowRevisionId: scope.flowRevisionId,
        environmentId: scope.environmentId,
        idempotencyKey: randomUUID(),
        authenticationCommitLimit: 1,
        businessCommitLimit: 1,
        protectedInputIds: [],
      });
    const a = await start(),
      b = await start();
    expect(await objective()).toEqual({ state: "running", conclusion: null });
    await lifecycle.markRunTerminal(
      scope.workspaceId,
      a.runId,
      "passed",
      "First follow-up inspected.",
    );
    expect(await objective()).toEqual({ state: "running", conclusion: null });
    const c = await start();
    await Promise.all([
      lifecycle.markRunTerminal(
        scope.workspaceId,
        b.runId,
        "passed",
        "Second follow-up inspected.",
      ),
      lifecycle.markRunTerminal(scope.workspaceId, c.runId, "passed", "Third follow-up inspected."),
    ]);
    expect((await objective()).state).toBe("passed");
    const history = await database.query<{ conclusion: string }>(
      "SELECT conclusion FROM runs WHERE objective_id=$1 ORDER BY created_at,id",
      [scope.objectiveId],
    );
    expect(history.rows.map((row) => row.conclusion)).toEqual(
      expect.arrayContaining([
        "First trial was refused.",
        "First follow-up inspected.",
        "Second follow-up inspected.",
        "Third follow-up inspected.",
      ]),
    );
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
    const credential = await commands.createProtectedInput(workspaceId, {
      projectId,
      displayName: "late_discovered_login",
      value: "late-bound-protected-canary",
      expiresInSeconds: null,
      idempotencyKey: `late-credential-${projectId}`,
    });
    await expect(
      commands.bindProtectedInputs(workspaceId, started.runId, [credential.protectedValueId]),
    ).resolves.toMatchObject({
      browserSessionId: started.browserSessionId,
      protectedInputIds: [credential.protectedValueId],
      added: 1,
      replay: false,
    });
    await expect(
      commands.bindProtectedInputs(workspaceId, started.runId, [credential.protectedValueId]),
    ).resolves.toMatchObject({ added: 0, replay: true });
    const owner = await execution.claimOwner(started.browserSessionId, "lifecycle-worker", 60_000);
    await publishFixtureEvidence(database, execution, started.browserSessionId, owner.generation);
    await execution.finalizeSession(started.browserSessionId, owner.generation);
    await lifecycle.markRunTerminal(
      workspaceId,
      started.runId,
      "passed",
      "Exact resource completed and verified",
    );
    await lifecycle.markRunTerminal(
      workspaceId,
      started.runId,
      "failed",
      "A replay must not rewrite the original conclusion",
    );
    expect(
      (
        await database.query<{ conclusion: string }>("SELECT conclusion FROM runs WHERE id=$1", [
          started.runId,
        ])
      ).rows[0]?.conclusion,
    ).toBe("Exact resource completed and verified");
    const report = await lifecycle.publishReport(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      summary: "Mission completed",
      safeReport: {
        result: "passed",
        flowsUsed: 1,
        evidenceCoverage: { complete: 999, runs: 999 },
      },
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
      expect.objectContaining({
        flowId: resumed.flowId,
        state: "passed",
        conclusion: "Exact resource completed and verified",
      }),
    ]);
    const storedReport = await database.query<{
      evidence_digest: string;
      evidence_coverage: unknown;
      safe_report: { evidenceCoverage: unknown };
    }>("SELECT evidence_digest,evidence_coverage,safe_report FROM mission_reports WHERE id=$1", [
      report.reportId,
    ]);
    expect(storedReport.rows[0]?.evidence_digest).toBe(
      await new ChronicleRepository(database).missionEvidenceDigest(mission.missionId),
    );
    const authoritative = {
      runs: 1,
      complete: 1,
      incomplete: 0,
      open: 0,
      missing: 0,
      unavailable: 0,
    };
    expect(storedReport.rows[0]?.evidence_coverage).toEqual(authoritative);
    expect(storedReport.rows[0]?.safe_report.evidenceCoverage).toEqual(authoritative);
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
    await publishFixtureEvidence(database, execution, started.browserSessionId, owner.generation);
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
