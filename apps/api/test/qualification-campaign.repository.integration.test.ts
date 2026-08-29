import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";

const databaseUrl = process.env.SCRY_M6_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("M6 qualification campaign durable authority", () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const wrongEnvironmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const adaptiveSessionId = randomUUID();
  const origin = "http://127.0.0.1:45678";
  const schemaIdentity = "15b258b1b7c1f6d446d2addaab7e25f5c0e111dba3a87210679d9aea50e03237";
  const releaseIdentity = "a".repeat(64);
  const principal = {
    kind: "user" as const,
    subject: userId,
    userId,
    email: "m6@example.test",
    workspaceId,
    role: "owner" as const,
  };
  let database: Database;
  let campaigns: QualificationCampaignRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    campaigns = new QualificationCampaignRepository(database);
    await seedScope();
  });

  afterAll(async () => database?.onModuleDestroy());

  it("atomically admits one Run and refuses the concurrent sibling", async () => {
    for (let repetition = 0; repetition < 5; repetition += 1) {
      const campaign = await createCampaign();
      const attempts = await Promise.allSettled([
        admitRun(campaign.id, `concurrent-run-${repetition}-a`),
        admitRun(campaign.id, `concurrent-run-${repetition}-b`),
      ]);
      expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(
        await count(
          `SELECT count(*)::int count FROM runs WHERE qualification_campaign_authorization_id=$1`,
          [campaign.id],
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT runs_consumed::int count FROM qualification_campaign_authorizations WHERE id=$1`,
          [campaign.id],
        ),
      ).toBe(1);
    }
  });

  it("atomically consumes one business mutation and retains it through UNKNOWN", async () => {
    const campaign = await createCampaign();
    const runId = await admitRun(campaign.id, "mutation-race-run");
    const attempts = await Promise.allSettled([
      campaigns.consumeBusinessMutation({
        runId,
        operationId: "operation-a",
        mutationIdentity: "mutation-a",
      }),
      campaigns.consumeBusinessMutation({
        runId,
        operationId: "operation-b",
        mutationIdentity: "mutation-b",
      }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*)::int count FROM qualification_campaign_mutation_consumptions WHERE campaign_authorization_id=$1`,
        [campaign.id],
      ),
    ).toBe(1);
    const winner = attempts[0]!.status === "fulfilled" ? "operation-a" : "operation-b";
    await campaigns.settleMutation(runId, winner, "unknown");
    await expect(
      campaigns.consumeBusinessMutation({
        runId,
        operationId: "operation-c",
        mutationIdentity: "mutation-c",
      }),
    ).rejects.toMatchObject({ response: { code: "QUALIFICATION_MUTATION_CAPABILITY_CONSUMED" } });
    const state = await campaigns.get(principal, campaign.id);
    expect(state).toMatchObject({
      disposition: "inconclusive",
      runsConsumed: 1,
      businessMutationDispatchesConsumed: 1,
    });
  });

  it("serializes Run admission against campaign expiration without granting a stale capability", async () => {
    for (let repetition = 0; repetition < 5; repetition += 1) {
      const campaign = await createCampaign();
      const outcomes = await Promise.allSettled([
        admitRun(campaign.id, `expiration-race-${repetition}`),
        database.query(
          `UPDATE qualification_campaign_authorizations
              SET expires_at=now(),disposition='expired',terminal_at=now(),updated_at=now()
            WHERE id=$1 AND disposition='authorized'`,
          [campaign.id],
        ),
      ]);
      expect(outcomes[1]!.status).toBe("fulfilled");
      const runs = await count(
        `SELECT count(*)::int count FROM runs WHERE qualification_campaign_authorization_id=$1`,
        [campaign.id],
      );
      const consumed = await count(
        `SELECT runs_consumed::int count FROM qualification_campaign_authorizations WHERE id=$1`,
        [campaign.id],
      );
      expect(runs).toBe(consumed);
      expect(runs).toBeLessThanOrEqual(1);
      await expect(
        admitRun(campaign.id, `expiration-race-${repetition}-late`),
      ).rejects.toMatchObject({
        response: {
          code: expect.stringMatching(/^QUALIFICATION_(CAMPAIGN_EXPIRED|RUN_CAPABILITY_CONSUMED)$/),
        },
      });
    }
  });

  it.each(["failed", "inconclusive"] as const)(
    "serializes mutation admission against %s settlement and never restores allowance",
    async (disposition) => {
      for (let repetition = 0; repetition < 5; repetition += 1) {
        const campaign = await createCampaign();
        const runId = await admitRun(campaign.id, `${disposition}-race-run-${repetition}`);
        await Promise.allSettled([
          campaigns.consumeBusinessMutation({
            runId,
            operationId: `${disposition}-race-operation-${repetition}`,
            mutationIdentity: `${disposition}-race-mutation-${repetition}`,
          }),
          campaigns.settleRun(runId, disposition),
        ]);
        const consumed = await count(
          `SELECT business_mutation_dispatches_consumed::int count
             FROM qualification_campaign_authorizations WHERE id=$1`,
          [campaign.id],
        );
        expect(consumed).toBeLessThanOrEqual(1);
        await expect(
          campaigns.consumeBusinessMutation({
            runId,
            operationId: `${disposition}-race-late-${repetition}`,
            mutationIdentity: `${disposition}-race-late-mutation-${repetition}`,
          }),
        ).rejects.toMatchObject({
          response: { code: "QUALIFICATION_MUTATION_CAPABILITY_CONSUMED" },
        });
      }
    },
  );

  it.each(["succeeded", "failed", "inconclusive"] as const)(
    "refuses a second Run after %s disposition",
    async (disposition) => {
      const campaign = await createCampaign();
      const runId = await admitRun(campaign.id, `terminal-${disposition}`);
      await campaigns.settleRun(runId, disposition);
      await expect(admitRun(campaign.id, `second-${disposition}`)).rejects.toMatchObject({
        response: { code: "QUALIFICATION_RUN_CAPABILITY_CONSUMED" },
      });
      expect(
        await count(
          `SELECT count(*)::int count FROM runs WHERE qualification_campaign_authorization_id=$1`,
          [campaign.id],
        ),
      ).toBe(1);
    },
  );

  it("refuses expiry and every wrong scope before durable Run creation", async () => {
    const campaign = await createCampaign();
    await expect(
      database.transaction((client) =>
        campaigns.consumeRun(client, {
          campaignId: campaign.id,
          projectId: randomUUID(),
          environmentId,
          missionId,
          objectiveId,
          agentSessionId,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "QUALIFICATION_CAMPAIGN_SCOPE_MISMATCH" } });
    await expect(
      database.transaction((client) =>
        campaigns.consumeRun(client, {
          campaignId: campaign.id,
          projectId,
          environmentId: wrongEnvironmentId,
          missionId,
          objectiveId,
          agentSessionId,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "QUALIFICATION_CAMPAIGN_SCOPE_MISMATCH" } });
    await database.query(
      `UPDATE qualification_campaign_authorizations SET expires_at=now()-interval '1 second' WHERE id=$1`,
      [campaign.id],
    );
    await expect(admitRun(campaign.id, "expired-run")).rejects.toMatchObject({
      response: { code: "QUALIFICATION_CAMPAIGN_EXPIRED" },
    });
    expect(
      await count(
        `SELECT count(*)::int count FROM runs WHERE qualification_campaign_authorization_id=$1`,
        [campaign.id],
      ),
    ).toBe(0);
  });

  it("refuses a target origin that disagrees with the exact environment", async () => {
    await expect(
      campaigns.create(principal, projectId, {
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        purpose: "system_correctness",
        targetOrigin: "http://127.0.0.1:45679",
        applicationIdentity: "q3-local-resource-fixture",
        qualificationMode: "local_test",
        releaseIdentity,
        schemaIdentity,
        maxRuns: 1,
        maxBusinessMutationDispatches: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      response: { code: "QUALIFICATION_TARGET_ORIGIN_MISMATCH" },
    });
  });

  it("prevents the adaptive sibling path from bypassing a campaign-bound Run", async () => {
    await createCampaign();
    await expect(
      campaigns.refuseCampaignBoundMutationOutsideRun(adaptiveSessionId),
    ).rejects.toMatchObject({
      response: { code: "QUALIFICATION_MUTATION_REQUIRES_BOUND_RUN" },
    });
  });

  it.each(["expired", "revoked"] as const)(
    "keeps the qualification scope fenced after %s authorization",
    async (disposition) => {
      const campaign = await createCampaign();
      await database.query(
        `UPDATE qualification_campaign_authorizations
            SET disposition=$2,terminal_at=now(),updated_at=now()
          WHERE id=$1`,
        [campaign.id, disposition],
      );
      await expect(
        campaigns.refuseCampaignBoundMutationOutsideRun(adaptiveSessionId),
      ).rejects.toMatchObject({
        response: { code: "QUALIFICATION_MUTATION_REQUIRES_BOUND_RUN" },
      });
    },
  );

  it("prevents every sibling Run writer from bypassing or forging campaign consumption", async () => {
    const campaign = await createCampaign();
    const insert = (campaignId: string | null) =>
      database.query(
        `INSERT INTO runs(
           id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,
           state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,
           execution_snapshot,idempotency_key,qualification_campaign_authorization_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'running','executing_action','{}','{}','{}',$8::jsonb,'{}',$9,$10)`,
        [
          randomUUID(),
          projectId,
          missionId,
          objectiveId,
          agentSessionId,
          environmentId,
          flowRevisionId,
          JSON.stringify({ schemaVersion: 1, digest: "b".repeat(64) }),
          `m6-bypass-${randomUUID()}`,
          campaignId,
        ],
      );

    await expect(insert(null)).rejects.toMatchObject({
      message: "QUALIFICATION_CAMPAIGN_AUTHORIZATION_REQUIRED",
    });
    await expect(insert(campaign.id)).rejects.toMatchObject({
      message: "QUALIFICATION_RUN_CAPABILITY_NOT_CONSUMED",
    });
    expect(
      await count(
        `SELECT count(*)::int count FROM runs
          WHERE project_id=$1 AND idempotency_key LIKE 'm6-bypass-%'`,
        [projectId],
      ),
    ).toBe(0);
  });

  async function createCampaign() {
    return campaigns.create(principal, projectId, {
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      purpose: "system_correctness",
      targetOrigin: origin,
      applicationIdentity: "q3-local-resource-fixture",
      qualificationMode: "local_test",
      releaseIdentity,
      schemaIdentity,
      maxRuns: 1,
      maxBusinessMutationDispatches: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  async function admitRun(campaignId: string, idempotencyKey: string) {
    return database.transaction(async (client) => {
      const bound = await campaigns.consumeRun(client, {
        campaignId,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
      });
      const runId = randomUUID();
      await client.query(
        `INSERT INTO runs(
           id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,
           state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,
           execution_snapshot,idempotency_key,qualification_campaign_authorization_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'running','executing_action','{}','{}','{}',$8::jsonb,'{}',$9,$10)`,
        [
          runId,
          projectId,
          missionId,
          objectiveId,
          agentSessionId,
          environmentId,
          flowRevisionId,
          JSON.stringify({ schemaVersion: 1, digest: "b".repeat(64) }),
          idempotencyKey,
          bound,
        ],
      );
      return runId;
    });
  }

  async function count(sql: string, values: unknown[]) {
    const result = await database.query<{ count: number }>(sql, values);
    return Number(result.rows[0]!.count);
  }

  async function seedScope() {
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'M6 qualification',$2)`, [
      workspaceId,
      `m6-${workspaceId}`,
    ]);
    await database.query(
      `INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'M6 qualification')`,
      [projectId, workspaceId],
    );
    for (const [id, name, baseOrigin] of [
      [environmentId, "M6 local", origin],
      [wrongEnvironmentId, "M6 wrong", "http://127.0.0.1:45679"],
    ] as const)
      await database.query(
        `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [
          id,
          projectId,
          name,
          baseOrigin,
          JSON.stringify({
            allowedOrigins: [baseOrigin],
            allowPrivateNetwork: true,
            allowDownloads: false,
            allowPopups: false,
            maxActions: 20,
            maxDurationMs: 60_000,
            maxNavigations: 10,
          }),
        ],
      );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status) VALUES($1,$2,'M6 qualification','Qualify one local mutation','running')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'Create one resource','[]'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key,project_id,workspace_id) VALUES($1,$2,'ollama','Repository-blind local agent',$3,$4,$5)`,
      [agentSessionId, missionId, `m6-agent-${agentSessionId}`, projectId, workspaceId],
    );
    await database.transaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO flows(id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id) VALUES($1,$2,'M6 Flow',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
        [flowId, projectId, flowRevisionId, missionId, objectiveId, agentSessionId],
      );
      await client.query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,1,'{}','{}','{}',$3,'M6 qualification')`,
        [flowRevisionId, flowId, agentSessionId],
      );
    });
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,content,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,'M6 draft','{}','{}',$6)`,
      [randomUUID(), projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
    const draft = await database.query<{ id: string }>(
      `SELECT id FROM flow_drafts WHERE mission_id=$1 LIMIT 1`,
      [missionId],
    );
    await database.query(
      `INSERT INTO adaptive_sessions(id,project_id,environment_id,correlation_id,state,objective,allowed_origins,mission_id,objective_id,flow_draft_id,active_objective_id,active_flow_draft_id,idempotency_key,authoring_turn_budgets,protected_reference_allowlist,agent_session_id) VALUES($1,$2,$3,$4,'active','M6 bypass control',$5::jsonb,$6,$7,$8,$7,$8,$9,'{}','[]',$10)`,
      [
        adaptiveSessionId,
        projectId,
        environmentId,
        randomUUID(),
        JSON.stringify([origin]),
        missionId,
        objectiveId,
        draft.rows[0]!.id,
        `m6-session-${adaptiveSessionId}`,
        agentSessionId,
      ],
    );
  }
});
