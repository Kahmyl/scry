import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Database } from "../src/infrastructure/index.js";

const databaseUrl = process.env.SCRY_BINDING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("external resource binding PostgreSQL invariants", () => {
  let database: Database;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const environmentId = randomUUID();
  const otherEnvironmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Binding qualification',$2)`, [workspaceId,`binding-${workspaceId}`]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$3,'Binding'),($2,$3,'Other binding')`, [projectId,otherProjectId,workspaceId]);
    await database.query(`INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES
      ($1,$3,'Binding','https://example.test',$5::jsonb),($2,$4,'Other','https://other.test',$5::jsonb)`,
    [environmentId,otherEnvironmentId,projectId,otherProjectId,JSON.stringify({ allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 1000, maxNavigations: 1 })]);
    await database.query(`INSERT INTO missions(id,project_id,title,original_instruction) VALUES($1,$2,'Binding','Qualification')`, [missionId,projectId]);
    await database.query(`INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'Bind','{}',0)`, [objectiveId,missionId]);
    await database.query(`INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,'scry_agent','Binding',$3)`, [agentSessionId,missionId,`binding-${agentSessionId}`]);
  });
  afterAll(async () => database?.onModuleDestroy());

  async function operation(environment = environmentId) {
    const id = randomUUID();
    const flowId = randomUUID(); const revisionId = randomUUID(); const runId = randomUUID();
    await database.transaction(async (client) => {
      await client.query(`INSERT INTO flows(id,project_id,name,latest_revision_id,visibility,purpose,owner_mission_id,owner_objective_id)
        VALUES($1,$2,$3,$4,'internal','setup',$5,$6)`, [flowId,projectId,`flow-${id}`,revisionId,missionId,objectiveId]);
      await client.query(`INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,reason)
        VALUES($1,$2,1,'{}','{}','{}','binding')`, [revisionId,flowId]);
      await client.query(`INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,environment_id,
        flow_revision_id,state,phase,plan_snapshot,environment_snapshot,policy_snapshot,execution_snapshot,
        veil_policy_snapshot,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,'running','executing_action','{}','{}','{}','{}','{}',$8)`,
      [runId,projectId,missionId,objectiveId,agentSessionId,environment,revisionId,`run-${id}`]);
      await client.query(`INSERT INTO protected_operations(
        id,operation_id,mutation_identity,owner_kind,run_id,project_id,environment_id,
        mission_id,objective_id,agent_session_id,flow_revision_id,program_digest,state,phase
      ) VALUES($1,$2,$2,'run',$3,$4,$5,$6,$7,$8,$9,$10,'persisting','persistence_running')`,
      [id,`operation-${id}`,runId,projectId,environment,missionId,objectiveId,agentSessionId,revisionId,"a".repeat(64)]);
    });
    return id;
  }

  async function publicValue(operationId: string, value: string, reference = "recordIdentity") {
    const id = randomUUID();
    await database.query(`INSERT INTO generated_public_values(
      id,project_id,source_protected_operation_id,operation_id,name,reference,scope,
      mission_id,objective_id,value
    ) VALUES($1,$2,$3,$4,'Record identity',$7,'project',$5,$6,$8)`,
    [id,projectId,operationId,`operation-${operationId}`,missionId,objectiveId,reference,value]);
    return id;
  }

  async function bind(operationId: string, valueId: string | null, identity: string | null, overrides: Record<string, unknown> = {}) {
    const values = {
      projectId, environmentId, provider: "provider", resourceKind: "credential_record",
      resourceScope: "application-a", state: valueId ? "active" : "unavailable",
      source: valueId ? "response" : null, ...overrides,
    };
    return database.query(`INSERT INTO external_resource_bindings(
      source_protected_operation_id,generated_public_value_id,project_id,environment_id,
      provider,resource_kind,resource_scope,canonical_external_identity,
      identity_contract_version,identity_source,lifecycle_state
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10) RETURNING id`,
    [operationId,valueId,values.projectId,values.environmentId,values.provider,values.resourceKind,
      values.resourceScope,identity,values.source,values.state]);
  }

  it("rejects cross-project, cross-environment, and unrelated-operation public values", async () => {
    const first = await operation();
    const second = await operation();
    const value = await publicValue(first, "record-owner");
    await expect(bind(first,value,"record-owner",{ projectId: otherProjectId })).rejects.toMatchObject({ code: "23503" });
    await expect(bind(first,value,"record-owner",{ environmentId: otherEnvironmentId })).rejects.toMatchObject({ code: "23503" });
    await expect(bind(second,value,"record-owner")).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces scoped one-resource and one-issuance identity while allowing independent scopes", async () => {
    const first = await operation(); const second = await operation();
    const firstValue = await publicValue(first, "record-shared"); const secondValue = await publicValue(second, "record-shared");
    await bind(first,firstValue,"record-shared");
    await expect(bind(second,secondValue,"record-shared")).rejects.toMatchObject({ code: "23505" });
    await bind(second,secondValue,"record-shared",{ resourceScope: "application-b" });
    const alternate = await publicValue(first,"record-other","alternateIdentity");
    await expect(bind(first,alternate,"record-other")).rejects.toMatchObject({ code: "23505" });
  });

  it("supports unavailable, immutable identity, invalidation, and desynchronization", async () => {
    const unavailableOperation = await operation();
    await bind(unavailableOperation,null,null);
    const activeOperation = await operation(); const value = await publicValue(activeOperation,"record-lifecycle");
    const binding = await bind(activeOperation,value,"record-lifecycle");
    await expect(database.query(`UPDATE external_resource_bindings SET canonical_external_identity='drift' WHERE id=$1`, [binding.rows[0]!.id])).rejects.toThrow();
    const credential = randomUUID();
    await database.query(`INSERT INTO project_credentials(id,project_id,name,ciphertext,initialization_vector,authentication_tag,origin_protected_operation_id)
      VALUES($1,$2,'Synthetic binding credential',$3,$4,$5,$6)`, [credential,projectId,Buffer.from("x"),Buffer.alloc(12),Buffer.alloc(16),activeOperation]);
    await database.query(`UPDATE project_credentials SET security_status='compromised' WHERE id=$1`, [credential]);
    const state = await database.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM external_resource_bindings WHERE id=$1`, [binding.rows[0]!.id]);
    expect(state.rows[0]!.lifecycle_state).toBe("desynchronized");
    const revokeOperation = await operation(); const revokeValue = await publicValue(revokeOperation,"record-revoke");
    const revoked = await bind(revokeOperation,revokeValue,"record-revoke");
    const revokedCredential = randomUUID();
    await database.query(`INSERT INTO project_credentials(id,project_id,name,ciphertext,initialization_vector,authentication_tag,origin_protected_operation_id)
      VALUES($1,$2,'Synthetic revoked credential',$3,$4,$5,$6)`, [revokedCredential,projectId,Buffer.from("x"),Buffer.alloc(12),Buffer.alloc(16),revokeOperation]);
    await database.query(`UPDATE project_credentials SET security_status='revoked' WHERE id=$1`, [revokedCredential]);
    const revokedState = await database.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM external_resource_bindings WHERE id=$1`, [revoked.rows[0]!.id]);
    expect(revokedState.rows[0]!.lifecycle_state).toBe("invalidated");
  });

  it("rolls back credential and public identity when required binding insertion fails", async () => {
    const first = await operation(); const existingValue = await publicValue(first,"record-rollback"); await bind(first,existingValue,"record-rollback");
    const second = await operation();
    await expect(database.transaction(async (client) => {
      const credential = randomUUID(); const value = randomUUID();
      await client.query(`INSERT INTO project_credentials(id,project_id,name,ciphertext,initialization_vector,authentication_tag,origin_protected_operation_id)
        VALUES($1,$2,'Rollback credential',$3,$4,$5,$6)`, [credential,projectId,Buffer.from("x"),Buffer.alloc(12),Buffer.alloc(16),second]);
      await client.query(`INSERT INTO generated_public_values(id,project_id,source_protected_operation_id,operation_id,name,reference,scope,mission_id,objective_id,value)
        VALUES($1,$2,$3,$4,'Record','recordIdentity','project',$5,$6,'record-rollback')`, [value,projectId,second,`operation-${second}`,missionId,objectiveId]);
      await client.query(`INSERT INTO external_resource_bindings(source_protected_operation_id,generated_public_value_id,project_id,environment_id,provider,resource_kind,resource_scope,canonical_external_identity,identity_contract_version,identity_source,lifecycle_state)
        VALUES($1,$2,$3,$4,'provider','credential_record','application-a','record-rollback',1,'response','active')`, [second,value,projectId,environmentId]);
    })).rejects.toMatchObject({ code: "23505" });
    const proof = await database.query<{ credentials: number; values: number }>(`SELECT
      (SELECT count(*)::int FROM project_credentials WHERE origin_protected_operation_id=$1) credentials,
      (SELECT count(*)::int FROM generated_public_values WHERE source_protected_operation_id=$1) values`, [second]);
    expect(proof.rows[0]).toEqual({ credentials: 0, values: 0 });
  });
});
