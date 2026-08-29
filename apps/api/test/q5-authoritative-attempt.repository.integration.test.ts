import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";
import { Q5AuthoritativeAttemptRepository } from "../src/runtime/repositories/q5-authoritative-attempt.repository.js";

const databaseUrl = process.env.SCRY_M6_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("M6 Q5 canonical application and authoritative attempt fuse", () => {
  const id = Object.fromEntries(
    [
      "workspace",
      "user",
      "project",
      "environment",
      "mission",
      "objective",
      "agent",
      "flow",
      "revision",
      "draft",
      "credential",
    ].map((name) => [name, randomUUID()]),
  ) as Record<string, string>;
  const origin = "http://127.0.0.1:45691";
  const source = {
    commit: "a".repeat(40),
    manifest: "b".repeat(64),
    schema: "c".repeat(64),
    migration: "d".repeat(64),
  };
  const principal = {
    kind: "user" as const,
    subject: id.user!,
    userId: id.user!,
    email: "q5-owner@example.test",
    workspaceId: id.workspace!,
    role: "owner" as const,
  };
  let database: Database;
  let campaigns: QualificationCampaignRepository;
  let attempts: Q5AuthoritativeAttemptRepository;
  let applicationId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    campaigns = new QualificationCampaignRepository(database);
    attempts = new Q5AuthoritativeAttemptRepository(database);
    await seed();
    applicationId = await attempts.createCanonicalApplication({
      identity: "vitract-preview-test",
      projectId: id.project!,
      environmentId: id.environment!,
      baseOrigin: origin,
      allowedOrigins: [origin],
      credentialReferenceIds: [id.credential!],
    });
  });

  afterAll(async () => database?.onModuleDestroy());

  it("binds campaign authority to the canonical application and refuses caller-label inversion", async () => {
    await expect(
      attempts.createCanonicalApplication({
        identity: "caller-invented-label",
        projectId: id.project!,
        environmentId: id.environment!,
        baseOrigin: origin,
        allowedOrigins: [origin],
        credentialReferenceIds: [id.credential!],
      }),
    ).rejects.toMatchObject({
      response: { code: "Q5_CANONICAL_APPLICATION_ENVIRONMENT_MISMATCH" },
    });
    await expect(createCampaign("caller-invented-label", applicationId)).rejects.toBeDefined();
    await expect(
      database.query(`UPDATE qualification_applications SET base_origin=$2 WHERE id=$1`, [
        applicationId,
        "https://alternate.invalid",
      ]),
    ).rejects.toThrow("QUALIFICATION_APPLICATION_IDENTITY_IMMUTABLE");
    await expect(
      database.query(`DELETE FROM qualification_applications WHERE id=$1`, [applicationId]),
    ).rejects.toThrow("QUALIFICATION_APPLICATION_DELETE_FORBIDDEN");
  });

  it("admits exactly one concurrent paid-attempt consumption and never restores it", async () => {
    const campaign = await createCampaign("vitract-preview-test", applicationId);
    const credential = "q5-scoped-credential";
    const digest = createHash("sha256").update(credential).digest("hex");
    const externalRunId = randomUUID();
    const prepared = await attempts.prepare(input(campaign.id, externalRunId, digest));
    expect(prepared.replayed).toBe(false);
    await expect(attempts.scopeForCredential(digest, externalRunId)).rejects.toMatchObject({
      response: { code: "Q5_AUTHORITATIVE_ATTEMPT_TERMINAL" },
    });
    const race = await Promise.allSettled([
      attempts.consume(prepared.attempt.attemptId, digest),
      attempts.consume(prepared.attempt.attemptId, digest),
    ]);
    expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(race.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await attempts.scopeForCredential(digest, externalRunId)).toMatchObject({
      campaignId: campaign.id,
      canonicalApplicationId: applicationId,
      credentialReferenceIds: [id.credential],
    });
    await attempts.settle(prepared.attempt.attemptId, "failed");
    await expect(
      database.query(`UPDATE q5_authoritative_attempts SET state='prepared' WHERE id=$1`, [
        prepared.attempt.attemptId,
      ]),
    ).rejects.toThrow("Q5_AUTHORITATIVE_ATTEMPT_IMMUTABLE");
    await expect(
      database.query(`DELETE FROM q5_authoritative_attempts WHERE id=$1`, [
        prepared.attempt.attemptId,
      ]),
    ).rejects.toThrow("Q5_AUTHORITATIVE_ATTEMPT_DELETE_FORBIDDEN");
    await expect(attempts.consume(prepared.attempt.attemptId, digest)).rejects.toMatchObject({
      response: { code: "Q5_AUTHORITATIVE_ATTEMPT_CONSUMED" },
    });
    await expect(
      attempts.prepare(
        input(randomUUID(), randomUUID(), createHash("sha256").update("other").digest("hex")),
      ),
    ).rejects.toMatchObject({ response: { code: "Q5_AUTHORITATIVE_ATTEMPT_ALREADY_EXISTS" } });
  });

  function input(campaignId: string, externalRunId: string, credentialDigest: string) {
    return {
      campaignId,
      canonicalApplicationId: applicationId,
      applicationIdentity: "vitract-preview-test",
      projectId: id.project!,
      environmentId: id.environment!,
      missionId: id.mission!,
      objectiveId: id.objective!,
      agentSessionId: id.agent!,
      externalRunId,
      flowDraftId: id.draft!,
      flowRevisionId: id.revision!,
      targetOrigin: origin,
      sourceCommit: source.commit,
      sourceManifest: source.manifest,
      schemaFingerprint: source.schema,
      migrationDigest: source.migration,
      provider: "deepseek" as const,
      model: "deepseek-chat",
      credentialDigest,
    };
  }

  function createCampaign(applicationIdentity: string, canonicalApplicationId: string) {
    return campaigns.create(principal, id.project!, {
      environmentId: id.environment!,
      missionId: id.mission!,
      objectiveId: id.objective!,
      agentSessionId: id.agent!,
      purpose: "system_correctness",
      targetOrigin: origin,
      applicationIdentity,
      canonicalApplicationId,
      qualificationMode: "local_test",
      releaseIdentity: source.manifest,
      schemaIdentity: source.schema,
      maxRuns: 1,
      maxBusinessMutationDispatches: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  async function seed() {
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Q5 fuse',$2)`, [
      id.workspace,
      `q5-${id.workspace}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Q5 fuse')`, [
      id.project,
      id.workspace,
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy,secret_refs)
       VALUES($1,$2,'Q5 Vitract',$3,$4::jsonb,'{}')`,
      [
        id.environment,
        id.project,
        origin,
        JSON.stringify({
          allowedOrigins: [origin],
          allowPrivateNetwork: true,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 80,
          maxDurationMs: 3600000,
          maxNavigations: 20,
        }),
      ],
    );
    await database.query(
      `INSERT INTO project_credentials(id,project_id,name,ciphertext,initialization_vector,authentication_tag)
       VALUES($1,$2,'Q5 protected ref','cipher','iv','tag')`,
      [id.credential, id.project],
    );
    await database.query(
      `UPDATE environments SET secret_refs=jsonb_build_object($2::text,'credential') WHERE id=$1`,
      [id.environment, id.credential],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status) VALUES($1,$2,'Q5 exact','one Vitract order','running')`,
      [id.mission, id.project],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order,status) VALUES($1,$2,'Q5 objective',$3,0,'pending')`,
      [
        id.objective,
        id.mission,
        JSON.stringify([{ description: "exact retrieval", required: true }]),
      ],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,project_id,workspace_id,provider,model,external_run_id,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,$4,'deepseek','deepseek-chat',$5,'Q5 exact',$6)`,
      [id.agent, id.mission, id.project, id.workspace, randomUUID(), `q5-${id.agent}`],
    );
    await database.transaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO flows(id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id) VALUES($1,$2,'Q5 flow',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
        [id.flow, id.project, id.revision, id.mission, id.objective, id.agent],
      );
      await client.query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,1,'{}','{}','{}',$3,'Q5')`,
        [id.revision, id.flow, id.agent],
      );
    });
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,flow_id,name,content,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,'Q5 draft','{}','{}',$7)`,
      [id.draft, id.project, id.mission, id.objective, id.environment, id.flow, id.agent],
    );
  }
});
