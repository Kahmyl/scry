import { randomUUID } from "node:crypto";
import type { Database } from "../../src/infrastructure/database.js";
import type { BrowserExecutionRepository } from "../../src/browser-execution/repositories/browser-execution.repository.js";

export async function seedSession(
  database: Database,
  effects: BrowserExecutionRepository,
  origin: string,
): Promise<string> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const environmentId = randomUUID();
  const agentSessionId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const runId = randomUUID();
  const sessionId = randomUUID();
  await database.transaction(async (client) => {
    await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
      userId,
      randomUUID(),
      `${userId}@example.test`,
    ]);
    await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'recovery',$2)", [
      workspaceId,
      `recovery-${workspaceId}`,
    ]);
    await client.query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, userId],
    );
    await client.query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'recovery')", [
      projectId,
      workspaceId,
    ]);
    await client.query(
      "INSERT INTO missions(id,project_id,title,original_instruction,idempotency_key) VALUES($1,$2,'recover browser','recover after process loss',$3)",
      [missionId, projectId, `mission-${missionId}`],
    );
    await client.query(
      "INSERT INTO agent_sessions(id,mission_id,project_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,'codex','recover',$4)",
      [agentSessionId, missionId, projectId, `agent-${agentSessionId}`],
    );
    await client.query(
      "INSERT INTO mission_objectives(id,mission_id,project_id,title,completion_criteria,objective_order,idempotency_key) VALUES($1,$2,$3,'recover','{}',0,$4)",
      [objectiveId, missionId, projectId, `objective-${objectiveId}`],
    );
    await client.query(
      "INSERT INTO environments(id,project_id,name,base_origin) VALUES($1,$2,'fixture',$3)",
      [environmentId, projectId, origin],
    );
    await client.query(
      "INSERT INTO flows(id,project_id,mission_id,created_by_agent_session_id,name,idempotency_key) VALUES($1,$2,$3,$4,'recovery',$5)",
      [flowId, projectId, missionId, agentSessionId, `flow-${flowId}`],
    );
    await client.query(
      "INSERT INTO flow_revisions(id,flow_id,mission_id,project_id,revision,state,created_by_agent_session_id,activated_at) VALUES($1,$2,$3,$4,1,'active',$5,now())",
      [flowRevisionId, flowId, missionId, projectId, agentSessionId],
    );
    await client.query(
      "INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        runId,
        projectId,
        missionId,
        objectiveId,
        agentSessionId,
        flowId,
        flowRevisionId,
        environmentId,
        `run-${runId}`,
      ],
    );
  });
  await effects.createSession({
    id: sessionId,
    runId,
    projectId,
    missionId,
    objectiveId,
    environmentId,
    agentSessionId,
    authenticationCommitLimit: 1,
    businessCommitLimit: 0,
    allowedFirstPartyOrigins: [origin],
    idempotencyKey: `session-${sessionId}`,
  });
  return sessionId;
}
