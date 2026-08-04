import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/infrastructure/database.js";
import { OrchestrationService } from "../src/orchestration/index.js";

const enabled = Boolean(process.env.SCRY_ORCHESTRATION_TEST_DATABASE_URL);
describe.skipIf(!enabled)("orchestration transactional guarantees", () => {
  let database: Database, service: OrchestrationService, pool: pg.Pool;
  const project = randomUUID(),
    mission = randomUUID(),
    session = randomUUID();
  const objectives = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const revisions = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const drafts = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const compilations = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const environments = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.SCRY_ORCHESTRATION_TEST_DATABASE_URL;
    database = new Database();
    service = new OrchestrationService(database);
    pool = database.pool;
    await pool.query(
      `INSERT INTO projects(id,workspace_id,name) VALUES($1,'00000000-0000-4000-8000-000000000001',$2)`,
      [project, `orchestration-${project}`],
    );
    await pool.query(
      `INSERT INTO missions(id,project_id,title,original_instruction) VALUES($1,$2,'Parallel verification','Verify project concurrency')`,
      [mission, project],
    );
    await pool.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','integration verification',$3)`,
      [session, mission, `session-${session}`],
    );
    for (let i = 0; i < objectives.length; i++) {
      await pool.query(
        `INSERT INTO mission_objectives(id,mission_id,title,dependencies,completion_criteria,objective_order) VALUES($1,$2,$3,'[]','[{"description":"pass","required":true}]',$4)`,
        [objectives[i], mission, `branch-${i}`, i],
      );
      await pool.query(
        `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,$3,'https://example.test',$4)`,
        [
          environments[i],
          project,
          `env-${i}`,
          JSON.stringify({
            allowedOrigins: ["https://example.test"],
            allowPrivateNetwork: false,
            allowDownloads: false,
            allowPopups: false,
            maxActions: 100,
            maxDurationMs: 120_000,
            maxNavigations: 10,
          }),
        ],
      );
      const flow = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO flows(id,project_id,name,latest_revision_id,visibility,purpose) VALUES($1,$2,$3,$4,'mission_local','primary')`,
          [flow, project, `flow-${i}`, revisions[i]],
        );
        await client.query(
          `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,reason) VALUES($1,$2,1,'{}',$3,$4,'integration')`,
          [
            revisions[i],
            flow,
            JSON.stringify({
              version: 1,
              name: `flow-${i}`,
              objective: "pass",
              allowedOrigins: ["https://example.test"],
              steps: [],
            }),
            JSON.stringify({ valid: true, errors: [], warnings: [] }),
          ],
        );
        const plan = JSON.stringify({
          version: 1,
          name: `flow-${i}`,
          objective: "pass",
          allowedOrigins: ["https://example.test"],
          steps: [],
        });
        await client.query(
          `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,flow_id,name,content,state,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,'{}','published',$8::jsonb,$9)`,
          [
            drafts[i],
            project,
            mission,
            objectives[i],
            environments[i],
            flow,
            `draft-${i}`,
            plan,
            session,
          ],
        );
        await client.query(
          `INSERT INTO flow_compilations(id,draft_id,draft_version,project_id,mission_id,objective_id,environment_id,flow_revision_id,status,plan_digest,compiled_contract_digest,capability_manifest_hash,runtime_hash,authorization_digest,calibration_digest,created_by_agent_session_id,idempotency_key,completed_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,'execution_ready',$8,$8,$8,$8,$8,$8,$9,$10,now())`,
          [
            compilations[i],
            drafts[i],
            project,
            mission,
            objectives[i],
            environments[i],
            revisions[i],
            "a".repeat(64),
            session,
            `compilation-${i}`,
          ],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }
  });
  afterAll(async () => {
    await database.onModuleDestroy();
  });
  it("claims at most three branches and never duplicates Runs", async () => {
    const context = { missionId: mission, agentSessionId: session };
    const bindings = objectives.map((objectiveId, i) => ({
      objectiveId,
      mode: "automatic" as const,
      flowRevisionId: revisions[i],
      compiledContractId: compilations[i],
      environmentId: environments[i],
      authorizationIds: [],
      browser: "chromium",
      viewport: { width: 1280, height: 720 },
    }));
    const plan = await service.createPlan({ kind: "service", subject: "scry-service" }, mission, {
      ...context,
      bindings,
      idempotencyKey: `plan-${mission}`,
    });
    await service.activate({ kind: "service", subject: "scry-service" }, mission, {
      ...context,
      planRevision: plan.revision,
    });
    await service.startReady({ kind: "service", subject: "scry-service" }, mission, context);
    await service.startReady({ kind: "service", subject: "scry-service" }, mission, context);
    const states = await pool.query(
      `SELECT state,count(*)::int count FROM mission_objective_orchestration WHERE mission_id=$1 GROUP BY state`,
      [mission],
    );
    expect(Object.fromEntries(states.rows.map((x) => [x.state, x.count]))).toEqual({
      queued: 3,
      ready: 1,
    });
    expect(
      Number(
        (await pool.query(`SELECT count(*) FROM runs WHERE mission_id=$1`, [mission])).rows[0]
          .count,
      ),
    ).toBe(3);
  });
});
