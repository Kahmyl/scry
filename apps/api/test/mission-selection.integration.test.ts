import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectConfigurationRepository } from "../src/access/repositories/project-configuration.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { OperationalEventStore } from "../src/infrastructure/operational-event-store.js";
import { OperationalEventsController } from "../src/infrastructure/operational-events.controller.js";
import { OperationalEvents } from "../src/infrastructure/operational-events.js";
import { MissionService } from "../src/missions/mission.service.js";
import { ExternalAgentLifecycleService } from "../src/runs/services/external-agent-lifecycle.service.js";

const configuredDatabaseUrl = process.env.SCRY_MISSION_SELECTION_TEST_DATABASE_URL;
const integration = configuredDatabaseUrl ? describe : describe.skip;

integration("fresh primary Mission selection over settled history", () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const historicalMissionId = randomUUID();
  const historicalAgentSessionId = randomUUID();
  const historicalExternalRunId = randomUUID();
  const historicalObjectiveId = randomUUID();
  const historicalEnvironmentId = randomUUID();
  const historicalFlowId = randomUUID();
  const historicalFlowRevisionId = randomUUID();
  const historicalFlowDraftId = randomUUID();
  const historicalRunId = randomUUID();
  const historicalPraxisSessionId = randomUUID();
  const unknownPraxisSessionId = randomUUID();
  const freshExternalRunId = randomUUID();
  const unsafeExternalRunId = randomUUID();
  let database: Database;
  let transactionClient: PoolClient;
  let configuration: ProjectConfigurationRepository;
  let missions: MissionService;
  let lifecycle: ExternalAgentLifecycleService;
  let operations: OperationalEventsController;

  const principal = {
    kind: "user",
    subject: `user-${workspaceId}`,
    userId: workspaceId,
    email: "mission-selection@example.test",
    workspaceId,
    role: "owner",
  } as const;

  beforeAll(async () => {
    process.env.DATABASE_URL = configuredDatabaseUrl;
    database = new Database();
    transactionClient = await database.pool.connect();
    await transactionClient.query("BEGIN");
    let transactionQueue: Promise<unknown> = Promise.resolve();
    const transactionQuery = <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => {
      const pending = transactionQueue.then(() => transactionClient.query<T>(text, values));
      transactionQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };
    database.query = transactionQuery;
    const nestedTransactionClient = new Proxy(transactionClient, {
      get(target, property) {
        if (property === "query")
          return (text: string, values?: unknown[]) =>
            text.startsWith("SET TRANSACTION ISOLATION LEVEL")
              ? Promise.resolve({ command: "SET", rowCount: null, oid: 0, rows: [], fields: [] })
              : transactionQuery(text, values);
        return Reflect.get(target, property, target);
      },
    });
    database.transaction = async (work) => work(nestedTransactionClient);
    configuration = new ProjectConfigurationRepository(database);
    missions = new MissionService(database);
    const eventStore = new OperationalEventStore(database);
    const events = new OperationalEvents(eventStore);
    lifecycle = new ExternalAgentLifecycleService(database, {} as never, events);
    operations = new OperationalEventsController(events, eventStore);
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)`, [
      workspaceId,
      `Mission selection ${workspaceId}`,
      `mission-selection-${workspaceId}`,
    ]);
    await database.query(
      `INSERT INTO projects(id,workspace_id,name,description) VALUES($1,$2,$3,'')`,
      [projectId, workspaceId, `Project ${projectId}`],
    );
    await database.query(
      `INSERT INTO missions(
         id,project_id,title,original_instruction,purpose,status,revision
       ) VALUES($1,$2,'Evaluate application','Evaluate application','primary','blocked',3)`,
      [historicalMissionId, projectId],
    );
    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,project_id,workspace_id,provider,model,external_run_id,experiment_id,
         instruction_snapshot,status,idempotency_key,ended_at,termination_reason,terminal_outcome
       ) VALUES($1,$2,$3,$4,'deepseek','deepseek-v4-flash',$5::uuid,$5::text,
         'Historical immutable instruction','interrupted','historical-session',now(),
         'MAX_TOOL_CALLS_EXCEEDED','limit_exceeded')`,
      [
        historicalAgentSessionId,
        historicalMissionId,
        projectId,
        workspaceId,
        historicalExternalRunId,
      ],
    );
    await database.query(
      `INSERT INTO mission_objectives(
         id,mission_id,title,description,status,dependencies,completion_criteria,objective_order
       ) VALUES($1,$2,'Historical objective','','blocked','[]'::jsonb,'[]'::jsonb,0)`,
      [historicalObjectiveId, historicalMissionId],
    );
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Historical fixture','http://127.0.0.1:1','{}'::jsonb)`,
      [historicalEnvironmentId, projectId],
    );
    await database.query(
      `INSERT INTO flows(
         id,project_id,name,description,latest_revision_id,visibility,purpose,
         origin_mission_id,origin_objective_id,created_by_agent_session_id,
         owner_mission_id,owner_objective_id
       ) VALUES($1,$2,'Historical flow','',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
      [
        historicalFlowId,
        projectId,
        historicalFlowRevisionId,
        historicalMissionId,
        historicalObjectiveId,
        historicalAgentSessionId,
      ],
    );
    await database.query(
      `INSERT INTO flow_revisions(
         id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason
       ) VALUES($1,$2,1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$3,'historical fixture')`,
      [historicalFlowRevisionId, historicalFlowId, historicalAgentSessionId],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,flow_id,name,content,state,
         plan,created_by_agent_session_id,purpose
       ) VALUES($1,$2,$3,$4,$5,$6,'Historical draft','{}'::jsonb,'abandoned',
         '{}'::jsonb,$7,'primary')`,
      [
        historicalFlowDraftId,
        projectId,
        historicalMissionId,
        historicalObjectiveId,
        historicalEnvironmentId,
        historicalFlowId,
        historicalAgentSessionId,
      ],
    );
    await database.query(
      `INSERT INTO runs(
         id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,
         state,phase,outcome_classification,result_classification,plan_snapshot,
         environment_snapshot,policy_snapshot,execution_snapshot,veil_policy_snapshot,
         idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'infrastructure_error','completed',
         'infrastructure_failure','infrastructure_failure','{}'::jsonb,'{}'::jsonb,
         '{}'::jsonb,'{}'::jsonb,$8::jsonb,'historical-terminal-run')`,
      [
        historicalRunId,
        projectId,
        historicalMissionId,
        historicalObjectiveId,
        historicalAgentSessionId,
        historicalEnvironmentId,
        historicalFlowRevisionId,
        JSON.stringify({ schemaVersion: 1, digest: "0".repeat(64) }),
      ],
    );
    await database.query(
      `INSERT INTO adaptive_sessions(
         id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
         mission_id,objective_id,flow_draft_id,idempotency_key,completed_at,
         authoring_turn_budgets,protected_reference_allowlist,agent_session_id
       ) VALUES($1,$2,$3,$4,'cancelled','Historical settled Praxis','[]'::jsonb,
         $5,$6,$7,'historical-settled-praxis',now(),
         '{"maxOperations":1,"maxDurationMs":1000}'::jsonb,'[]'::jsonb,$8)`,
      [
        historicalPraxisSessionId,
        projectId,
        historicalEnvironmentId,
        historicalExternalRunId,
        historicalMissionId,
        historicalObjectiveId,
        historicalFlowDraftId,
        historicalAgentSessionId,
      ],
    );
  });

  afterAll(async () => {
    if (!database) return;
    await transactionClient.query("ROLLBACK");
    transactionClient.release();
    await database.onModuleDestroy();
  });

  it("exposes safe fresh-work authority and attaches the pre-Mission external session", async () => {
    const started = await lifecycle.start(principal, freshExternalRunId, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      experimentId: freshExternalRunId,
      correlationId: freshExternalRunId,
    });
    expect(started).toMatchObject({ missionId: null, projectId: null, status: "active" });

    const context = await configuration.operatingContext(
      principal,
      {
        projectId,
        intendedPurpose: "primary",
        requiredCredentialReferences: [],
        authorizeDistinctMissionForReadOnlyUnknown: false,
      },
      { externalRunId: freshExternalRunId },
    );
    expect(context).toMatchObject({
      missions: {
        policy: {
          decision: "fresh_primary_permitted",
          freshPrimaryMissionPermitted: true,
          continuationAvailable: false,
          historicalMissionCount: 1,
        },
        candidates: {
          items: [
            {
              id: historicalMissionId,
              status: "blocked",
              classification: "settled_history",
              activeExecutionOwnership: false,
              unresolvedMutationRisk: false,
              outstandingReconciliation: false,
            },
          ],
        },
      },
      continuation: {
        userAuthorityRequired: false,
        safeActions: ["start_mission"],
      },
    });

    const created = await missions.create(principal, projectId, {
      title: "Evaluate application",
      originalInstruction: "Evaluate application",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      externalRunId: freshExternalRunId,
      experimentId: freshExternalRunId,
      instructionSnapshot: "Evaluate application",
      idempotencyKey: `fresh-${freshExternalRunId}`,
    });
    expect(created).toMatchObject({
      status: "planning",
      purpose: "primary",
      agentSessionId: started.agentSessionId,
      replayed: false,
    });
    if (!("missionId" in created)) throw new Error("fresh Mission creation was replay-only");
    expect(created.missionId).not.toBe(historicalMissionId);

    const durable = await database.query(
      `SELECT mission_id AS "missionId",project_id AS "projectId",status
         FROM agent_sessions WHERE external_run_id=$1`,
      [freshExternalRunId],
    );
    expect(durable.rows).toEqual([{ missionId: created.missionId, projectId, status: "active" }]);
    expect(
      await database.query(`SELECT id,status,revision FROM missions WHERE id=$1`, [
        historicalMissionId,
      ]),
    ).toMatchObject({
      rows: [{ id: historicalMissionId, status: "blocked", revision: 3 }],
    });
    expect(
      await database.query(
        `SELECT
           (SELECT state FROM runs WHERE id=$1) AS "runState",
           (SELECT state FROM adaptive_sessions WHERE id=$2) AS "praxisState",
           (SELECT count(*)::int FROM adaptive_operations WHERE session_id=$2) AS "operationCount"`,
        [historicalRunId, historicalPraxisSessionId],
      ),
    ).toMatchObject({
      rows: [{ runState: "infrastructure_error", praxisState: "cancelled", operationCount: 0 }],
    });
  });

  it("blocks fresh duplicate progression on unresolved UNKNOWN and exposes the pre-Mission event", async () => {
    await database.query(
      `INSERT INTO adaptive_sessions(
         id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
         mission_id,objective_id,flow_draft_id,idempotency_key,active_objective_id,
         active_flow_draft_id,authoring_turn_budgets,protected_reference_allowlist,agent_session_id
       ) VALUES($1,$2,$3,$4,'recovery_required','Unresolved mutation fixture','[]'::jsonb,
         $5,$6,$7,'historical-unknown-praxis',$6,$7,
         '{"maxOperations":1,"maxDurationMs":1000}'::jsonb,'[]'::jsonb,$8)`,
      [
        unknownPraxisSessionId,
        projectId,
        historicalEnvironmentId,
        historicalExternalRunId,
        historicalMissionId,
        historicalObjectiveId,
        historicalFlowDraftId,
        historicalAgentSessionId,
      ],
    );
    await database.query(
      `INSERT INTO adaptive_operations(
         session_id,operation_id,sequence,mode,state,semantic_intent,expected_effect,
         policy_digest,dispatch_boundary,mutation_outcome,functional_result,privacy_result,
         safe_outcome,idempotency_key,completed_at,mission_id,objective_id,flow_draft_id,
         authoring_intent,derived_action
       ) VALUES($1,'unknown-mutation',1,'transact','completed','{}'::jsonb,'{}'::jsonb,
         $2,'acknowledged','unknown','inconclusive','verified','{}'::jsonb,
         'historical-unknown-operation',now(),$3,$4,$5,
         '{"action":{"kind":"activate"}}'::jsonb,
         '{"kind":"activate"}'::jsonb)`,
      [
        unknownPraxisSessionId,
        "0".repeat(64),
        historicalMissionId,
        historicalObjectiveId,
        historicalFlowDraftId,
      ],
    );
    const started = await lifecycle.start(principal, unsafeExternalRunId, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      experimentId: unsafeExternalRunId,
      correlationId: unsafeExternalRunId,
    });
    const context = await configuration.operatingContext(
      principal,
      {
        projectId,
        intendedPurpose: "primary",
        requiredCredentialReferences: [],
        authorizeDistinctMissionForReadOnlyUnknown: false,
      },
      { externalRunId: unsafeExternalRunId },
    );
    expect(context).toMatchObject({
      missions: {
        policy: {
          decision: "selection_required",
          freshPrimaryMissionPermitted: false,
        },
        candidates: {
          items: expect.arrayContaining([
            expect.objectContaining({
              id: historicalMissionId,
              classification: "mutation_reconciliation_required",
              unresolvedMutationRisk: true,
            }),
          ]),
        },
      },
      continuation: {
        blockerCode: "MISSION_MUTATION_RECONCILIATION_REQUIRED",
        userAuthorityRequired: true,
      },
    });

    await lifecycle.observeOperatingContext(principal, unsafeExternalRunId, projectId, context);
    await lifecycle.terminate(principal, unsafeExternalRunId, {
      reasonCode: "EXTERNAL_AGENT_BLOCKED_USER_AUTHORITY",
      terminalOutcome: "blocked_user_authority",
      blockerCode: "MISSION_MUTATION_RECONCILIATION_REQUIRED",
    });

    const page = await operations.query(principal, {
      limit: 50,
      projectId,
      correlationId: unsafeExternalRunId,
    });
    expect(page.items.map(({ name }) => name).sort()).toEqual([
      "external_agent.blocked",
      "external_agent.lifecycle_settled",
    ]);
    for (const event of page.items) {
      expect(event.causality).toMatchObject({
        projectId,
        agentSessionId: started.agentSessionId,
        correlationId: unsafeExternalRunId,
      });
      expect(event.causality).not.toHaveProperty("missionId");
      expect(event.causality).not.toHaveProperty("runId");
    }
    expect(
      await database.query(
        `SELECT status,blocker_code AS "blockerCode",terminal_outcome AS "terminalOutcome"
           FROM agent_sessions WHERE external_run_id=$1`,
        [unsafeExternalRunId],
      ),
    ).toMatchObject({
      rows: [
        {
          status: "blocked",
          blockerCode: "MISSION_MUTATION_RECONCILIATION_REQUIRED",
          terminalOutcome: "blocked_user_authority",
        },
      ],
    });
  });
});
