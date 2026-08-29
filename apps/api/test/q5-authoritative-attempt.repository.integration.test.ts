import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";
import { Q5AuthoritativeAttemptRepository } from "../src/runtime/repositories/q5-authoritative-attempt.repository.js";
import { Q5ScopeBootstrapRepository } from "../src/runtime/repositories/q5-scope-bootstrap.repository.js";

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
      "credential2",
      "praxisSession",
      "authorization",
      "issuanceOperation",
      "pairReference",
      "preparedScope",
    ].map((name) => [name, randomUUID()]),
  ) as Record<string, string>;
  const origin = "https://preview-api.vitract.com";
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
      credentialReferenceIds: [id.credential!, id.credential2!],
    });
  });

  afterAll(async () => database?.onModuleDestroy());

  it("recognizes only the atomic references emitted by the supported protected issuance", async () => {
    const bootstrap = new Q5ScopeBootstrapRepository(database, id.workspace!);
    const pairs = await bootstrap.exclusively("m6-q5-authoritative", () =>
      bootstrap.findCredentialPairs(id.project!, id.environment!),
    );
    expect(pairs).toEqual([
      expect.objectContaining({
        projectId: id.project,
        environmentId: id.environment,
        issuanceOperationId: id.issuanceOperation,
        clientIdReferenceId: id.credential,
        clientSecretReferenceId: id.credential2,
        provenance: "supported_protected_issuance",
        atomic: true,
      }),
    ]);
  });

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
    await expect(
      database.transaction(async (client) => {
        await client.query(`UPDATE project_credentials SET security_status='revoked' WHERE id=$1`, [
          id.credential,
        ]);
        await attempts.consumeUsing(client, prepared.attempt.attemptId, digest);
      }),
    ).rejects.toMatchObject({ response: { code: "Q5_AUTHORITATIVE_ATTEMPT_CONSUMED" } });
    const race = await Promise.allSettled([
      attempts.consume(prepared.attempt.attemptId, digest),
      attempts.consume(prepared.attempt.attemptId, digest),
    ]);
    expect(race.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(race.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await attempts.scopeForCredential(digest, externalRunId)).toMatchObject({
      campaignId: campaign.id,
      canonicalApplicationId: applicationId,
      credentialReferenceIds: [id.credential, id.credential2],
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
      preparedScopeId: id.preparedScope!,
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
       VALUES($1,$3,'Vitract client id','cipher','123456789012','1234567890123456'),
             ($2,$3,'Vitract client secret','cipher','123456789012','1234567890123456')`,
      [id.credential, id.credential2, id.project],
    );
    await database.query(
      `INSERT INTO q5_canonical_scope_designations(
         qualification_key,project_id,environment_id,application_identity,environment_class,
         target_origin,protected_policy,qualification_policy_version
       ) VALUES('m6-q5-authoritative',$1,$2,'vitract-preview-test','preview_test',$3,
         'atomic_protected_pair_v1','q5-bootstrap-v1')`,
      [id.project, id.environment, origin],
    );
    await database.query(
      `UPDATE environments SET secret_refs=jsonb_build_array($2::text,$3::text) WHERE id=$1`,
      [id.environment, id.credential, id.credential2],
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
    await database.query(
      `INSERT INTO adaptive_sessions(
         id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
         mission_id,objective_id,flow_draft_id,idempotency_key,active_objective_id,
         active_flow_draft_id,authoring_turn_budgets,protected_reference_allowlist,agent_session_id,
         protection
       ) VALUES($1,$2,$3,$4,'active','Q5 issuance',$5::jsonb,$6,$7,$8,$9,$7,$8,'{}',$10::jsonb,$11,'protected')`,
      [
        id.praxisSession,
        id.project,
        id.environment,
        randomUUID(),
        JSON.stringify([origin]),
        id.mission,
        id.objective,
        id.draft,
        `q5-praxis-${id.praxisSession}`,
        JSON.stringify([id.credential, id.credential2]),
        id.agent,
      ],
    );
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,granted_by_agent_session_id,
         operation_id,praxis_session_id
       ) VALUES($1,$2,$3,$4,'protected_mutation','Q5 supported issuance',$5,'q5-issuance',$6)`,
      [id.authorization, id.mission, id.objective, id.environment, id.agent, id.praxisSession],
    );
    await database.query(
      `INSERT INTO protected_operations(
         id,operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,
         environment_id,mission_id,objective_id,agent_session_id,flow_draft_id,authorization_id,
         program_digest,state,phase,dispatch_state,mutation_outcome,acquisition_state,
         persistence_state,safe_output_manifest,persisted_references,completed_at
       ) VALUES($1,'q5-supported-issuance','q5-supported-issuance','authoring_session',$2,$3,
         $4,$5,$6,$7,$8,$9,$10,'completed','completed','acknowledged','applied','complete',
         'committed',$11::jsonb,$12::jsonb,now())`,
      [
        id.issuanceOperation,
        id.praxisSession,
        id.project,
        id.environment,
        id.mission,
        id.objective,
        id.agent,
        id.draft,
        id.authorization,
        "f".repeat(64),
        JSON.stringify([
          { reference: "credentialClientId" },
          { reference: "credentialClientSecret" },
        ]),
        JSON.stringify({
          credentialClientId: { credentialId: id.credential },
          credentialClientSecret: { credentialId: id.credential2 },
        }),
      ],
    );
    await database.query(
      `UPDATE project_credentials SET origin_protected_operation_id=$1 WHERE id=ANY($2::uuid[])`,
      [id.issuanceOperation, [id.credential, id.credential2]],
    );
    await database.query(
      `INSERT INTO q5_prepared_scopes(
         id,qualification_key,project_id,environment_id,application_identity,environment_class,
         target_origin,allowed_origins,credential_pair_reference_id,client_id_reference_id,
         client_secret_reference_id,issuance_operation_id,credential_type,protected_policy,
         credential_provenance,source_commit,source_manifest,schema_fingerprint,migration_identity,
         q5_mcp_profile,q5_mcp_contract_digest,qualification_policy_version,binding_digest
       ) VALUES($1,'m6-q5-authoritative',$2,$3,'vitract-preview-test','preview_test',$4,$5::jsonb,
         $6,$7,$8,$9,'vitract_partner_api_client_pair','atomic_protected_pair_v1',
         'supported_protected_issuance',$10,$11,$12,$13,'q5-authoritative-v1',$14,
         'q5-bootstrap-v1',$15)`,
      [
        id.preparedScope,
        id.project,
        id.environment,
        origin,
        JSON.stringify([origin]),
        id.pairReference,
        id.credential,
        id.credential2,
        id.issuanceOperation,
        source.commit,
        source.manifest,
        source.schema,
        source.migration,
        "e".repeat(64),
        "f".repeat(64),
      ],
    );
  }
});
