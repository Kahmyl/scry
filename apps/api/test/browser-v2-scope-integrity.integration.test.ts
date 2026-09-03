import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserLifecycleRepository } from "../src/browser-execution/browser-lifecycle.repository.js";
import { Database } from "../src/infrastructure/database.js";

const databaseUrl = process.env.BROWSER_V2_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("browser v2 database scope integrity", () => {
  let database: Database;
  let lifecycle: BrowserLifecycleRepository;
  let workspaceId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BROWSER_V2_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    lifecycle = new BrowserLifecycleRepository(database);
    workspaceId = randomUUID();
    const userId = randomUUID();
    await database.transaction(async (client) => {
      await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
        userId,
        randomUUID(),
        `${userId}@scope.test`,
      ]);
      await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'scope integrity',$2)", [
        workspaceId,
        `scope-${workspaceId}`,
      ]);
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
    });
  });

  afterAll(async () => {
    if (database) await database.onModuleDestroy();
  });

  it("rejects cross-run commands/evidence, cross-project protected inputs, and cross-mission final reports", async () => {
    const left = await createScope("left");
    const right = await createScope("right");

    await expectForeignKeyViolation(
      database.query(
        `INSERT INTO browser_commands(id,session_id,run_id,command_ordinal,idempotency_key,kind,safe_input)
         VALUES($1,$2,$3,1,$4,'observe','{}'::jsonb)`,
        [randomUUID(), left.sessionId, right.runId, `cross-command-${randomUUID()}`],
      ),
    );
    await expectForeignKeyViolation(
      database.query(
        `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,retention_expires_at)
         VALUES($1,$2,$3,'open',now()+interval '1 hour')`,
        [randomUUID(), left.sessionId, right.runId],
      ),
    );

    const protectedValueId = randomUUID();
    await database.query(
      `INSERT INTO protected_values(
         id,project_id,source_kind,display_name,external_reference,ciphertext,nonce,
         authentication_tag,value_digest,key_version)
       VALUES($1,$2,'user_input','CrossScope','scope-test',$3,$4,$5,$6,'scope-key')`,
      [
        protectedValueId,
        right.projectId,
        Buffer.from("ciphertext"),
        Buffer.alloc(12, 1),
        Buffer.alloc(16, 2),
        "a".repeat(64),
      ],
    );
    await expectForeignKeyViolation(
      database.query(
        `INSERT INTO browser_session_protected_inputs(session_id,protected_value_id,project_id)
         VALUES($1,$2,$3)`,
        [left.sessionId, protectedValueId, left.projectId],
      ),
    );

    const leftReportId = await createReport(left.missionId, "b");
    const rightReportId = await createReport(right.missionId, "c");
    expect(leftReportId).not.toBe(rightReportId);
    await expectForeignKeyViolation(
      database.transaction(async (client) => {
        await client.query("UPDATE missions SET final_report_id=$2 WHERE id=$1", [
          left.missionId,
          rightReportId,
        ]);
      }),
    );
  });

  async function createScope(label: string) {
    const projectId = randomUUID();
    const environmentId = randomUUID();
    await database.query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)", [
      projectId,
      workspaceId,
      `scope ${label}`,
    ]);
    await database.query(
      "INSERT INTO environments(id,project_id,name,base_origin) VALUES($1,$2,$3,$4)",
      [environmentId, projectId, label, `https://${label}.scope.test`],
    );
    const mission = await lifecycle.startMission(workspaceId, {
      projectId,
      title: `${label} mission`,
      instruction: `${label} instruction`,
      idempotencyKey: `${label}-mission-${randomUUID()}`,
      provider: "codex",
      settings: {},
    });
    const objective = await lifecycle.createObjective(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      title: `${label} objective`,
      description: "",
      completionCriteria: {},
      objectiveOrder: 0,
      idempotencyKey: `${label}-objective-${randomUUID()}`,
    });
    const flow = await lifecycle.createFlow(workspaceId, mission.missionId, {
      agentSessionId: mission.agentSessionId,
      name: `${label} flow`,
      purpose: "scope isolation",
      definition: {},
      idempotencyKey: `${label}-flow-${randomUUID()}`,
    });
    const started = await lifecycle.startRun(workspaceId, {
      projectId,
      missionId: mission.missionId,
      objectiveId: objective.objectiveId,
      agentSessionId: mission.agentSessionId,
      flowId: flow.flowId,
      flowRevisionId: flow.flowRevisionId,
      environmentId,
      idempotencyKey: `${label}-run-${randomUUID()}`,
      authenticationCommitLimit: 1,
      businessCommitLimit: 1,
      protectedInputIds: [],
    });
    return {
      projectId,
      missionId: mission.missionId,
      runId: started.runId,
      sessionId: started.browserSessionId,
    };
  }

  async function createReport(missionId: string, digest: string) {
    const reportId = randomUUID();
    await database.query(
      `INSERT INTO mission_reports(id,mission_id,state,summary,safe_report,evidence_digest,finalized_at)
       VALUES($1,$2,'final','scope report','{}'::jsonb,$3,now())`,
      [reportId, missionId, digest.repeat(64)],
    );
    return reportId;
  }
});

async function expectForeignKeyViolation(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error("EXPECTED_FOREIGN_KEY_VIOLATION");
  } catch (error) {
    expect(error).toMatchObject({ code: "23503" });
  }
}
