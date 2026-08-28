import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresQ1Adapter } from "../../../packages/assurance/src/architecture/q1/adapters.js";
import { evaluateInvariants } from "../../../packages/assurance/src/architecture/q1/invariants.js";
import { Database } from "../src/infrastructure/index.js";

const databaseUrl = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Q1 real repository adapter", () => {
  let database: Database;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const praxisSessionId = randomUUID();
  const authorizationId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const runId = randomUUID();
  const firstAttemptId = randomUUID();
  const secondAttemptId = randomUUID();
  const firstClaimToken = randomUUID();
  const secondClaimToken = randomUUID();
  const browserContextId = randomUUID();
  const artifactId = randomUUID();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'Q1 adapter',$2)`, [
      workspaceId,
      `q1-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Q1 adapter')`, [
      projectId,
      workspaceId,
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Q1 adapter','https://q1.invalid','{}'::jsonb)`,
      [environmentId, projectId],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status)
       VALUES($1,$2,'Q1 repository adapter','Observe durable truth','running')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
       VALUES($1,$2,'Observe','{}'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','Q1 fixture',$3)`,
      [agentSessionId, missionId, `q1-agent-${agentSessionId}`],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'Q1 fixture','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
    await database.query(
      `INSERT INTO adaptive_sessions(
         id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
         mission_id,objective_id,flow_draft_id,idempotency_key,agent_session_id,
         active_objective_id,active_flow_draft_id,authoring_turn_budgets,protected_reference_allowlist
       ) VALUES($1,$2,$3,$4,'active','Q1 fixture','[]'::jsonb,$5,$6,$7,$8,$9,$6,$7,
         '{"maxOperations":20,"maxDurationMs":60000}'::jsonb,'[]'::jsonb)`,
      [
        praxisSessionId,
        projectId,
        environmentId,
        randomUUID(),
        missionId,
        objectiveId,
        flowDraftId,
        `q1-praxis-${praxisSessionId}`,
        agentSessionId,
      ],
    );
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,granted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'protected_mutation','Q1 fixture',$5)`,
      [authorizationId, missionId, objectiveId, environmentId, agentSessionId],
    );
    await database.transaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO flows(
           id,project_id,name,latest_revision_id,visibility,purpose,owner_mission_id,
           owner_objective_id,created_by_agent_session_id
         ) VALUES($1,$2,'Q1 fixture',$3,'mission_local','primary',$4,$5,$6)`,
        [flowId, projectId, flowRevisionId, missionId, objectiveId, agentSessionId],
      );
      await client.query(
        `INSERT INTO flow_revisions(
           id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason
         ) VALUES($1,$2,1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$3,'Q1 fixture')`,
        [flowRevisionId, flowId, agentSessionId],
      );
    });
    await database.query(
      `INSERT INTO runs(
         id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,
         state,phase,outcome_classification,result_classification,plan_snapshot,
         environment_snapshot,policy_snapshot,execution_snapshot,veil_policy_snapshot,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'passed','completed','passed','application_pass',
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$8)`,
      [
        runId,
        projectId,
        missionId,
        objectiveId,
        agentSessionId,
        environmentId,
        flowRevisionId,
        `q1-run-${runId}`,
      ],
    );
    await database.query(
      `INSERT INTO attempts(id,run_id,attempt_number,state,worker_id,claim_token,completed_at)
       VALUES($1,$2,1,'failed','worker-old',$3,now()),($4,$2,2,'completed','worker-current',$5,now())`,
      [firstAttemptId, runId, firstClaimToken, secondAttemptId, secondClaimToken],
    );
    await database.query(
      `INSERT INTO browser_contexts(id,run_id,provenance,capture_epoch)
       VALUES($1,$2,'safe',1)`,
      [browserContextId, runId],
    );
    await database.query(
      `INSERT INTO capture_epochs(
         run_id,context_id,epoch,producing_provenance,status,started_at,ended_at
       ) VALUES($1,$2,1,'safe','sealed',now(),now())`,
      [runId, browserContextId],
    );
    await database.query(
      `INSERT INTO artifacts(
         id,attempt_id,kind,availability,privacy_classification,content_type,storage_key,
         size_bytes,checksum_sha256,context_id,capture_epoch
       ) VALUES($1,$2,'screenshot','available','safe','image/png',$3,8,$4,$5,1)`,
      [artifactId, secondAttemptId, `q1/${artifactId}.png`, "a".repeat(64), browserContextId],
    );

    await insertAdaptiveOperation({
      operationId: "ordinary-operation",
      sequence: 1,
      semanticType: "ordinaryTransaction",
      state: "completed",
      mutationOutcome: "applied",
      functionalResult: "succeeded",
      dispatchBoundary: "acknowledged",
    });
    await insertAdaptiveOperation({
      operationId: "protected-operation",
      sequence: 2,
      semanticType: "protectedTransaction",
      state: "completed",
      mutationOutcome: "unknown",
      functionalResult: "inconclusive",
      dispatchBoundary: "acknowledged",
    });
    await insertProtectedOperation({
      operationId: "protected-operation",
      state: "completed",
      mutationOutcome: "applied",
      dispatchState: "acknowledged",
    });
    await insertAdaptiveOperation({
      operationId: "unresolved-operation",
      sequence: 3,
      semanticType: "protectedTransaction",
      state: "failed",
      mutationOutcome: "unknown",
      functionalResult: "inconclusive",
      dispatchBoundary: "dispatching",
    });
    await insertProtectedOperation({
      operationId: "unresolved-operation",
      state: "recovery_required",
      mutationOutcome: "unknown",
      dispatchState: "started",
    });
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it("reads ordinary adaptive mutation truth and exact repository scope", async () => {
    const snapshot = await acquireOperation("ordinary-operation");
    expect(snapshot.scope).toMatchObject({
      projectId,
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      praxisSessionId,
    });
    expect(snapshot.operation).toMatchObject({
      kind: "ordinary_mutation",
      operationId: "ordinary-operation",
      mutationIdentity: `adaptive-ordinary-operation`,
      mutationTruth: "applied",
      adaptiveProjectionTruth: "applied",
      protectedTruth: null,
      functionalTruth: "succeeded",
      terminal: true,
    });
    expect(evaluateInvariants(snapshot)).toHaveLength(52);
  });

  it("keeps protected truth canonical when the adaptive row is only a projection", async () => {
    const snapshot = await acquireOperation("protected-operation");
    expect(snapshot.operation).toMatchObject({
      kind: "protected_mutation",
      mutationIdentity: "mutation-protected-operation",
      providerIdempotencyIdentity: "b".repeat(64),
      protectedTruth: "applied",
      adaptiveProjectionTruth: "unknown",
      mutationTruth: "applied",
      terminal: true,
    });
    expect(snapshot.scope).toMatchObject({ projectId, environmentId, agentSessionId });
    expect(evaluateInvariants(snapshot)).toHaveLength(52);
  });

  it("translates a terminal Run and preserves fenced Attempt history", async () => {
    const snapshot = await new PostgresQ1Adapter(database).acquire({
      missionId,
      objectiveId,
      runId,
    });
    expect(snapshot.scope).toMatchObject({
      projectId,
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      runId,
    });
    expect(snapshot.run).toMatchObject({
      state: "passed",
      resultClassification: "application_pass",
      attemptStates: ["failed", "completed"],
      attemptHistoryPreserved: true,
      identityStable: true,
      operationMutable: false,
    });
    expect(snapshot.run.attemptHistory).toEqual([
      { attemptId: firstAttemptId, attemptNumber: 1, state: "failed", claimToken: firstClaimToken },
      {
        attemptId: secondAttemptId,
        attemptNumber: 2,
        state: "completed",
        claimToken: secondClaimToken,
      },
    ]);
    expect(evaluateInvariants(snapshot)).toHaveLength(52);
  });

  it("does not infer Objective pass from a passed Run or available artifact", async () => {
    const adapter = new PostgresQ1Adapter(database);
    const beforeAcceptance = await adapter.acquire({ missionId, objectiveId, runId });
    expect(beforeAcceptance.objective).toMatchObject({ state: "pending", acceptedEvidence: false });

    await database.query(
      `INSERT INTO accepted_evidence(
         mission_id,objective_id,run_id,artifact_id,conclusion,accepted_by_agent_session_id
       ) VALUES($1,$2,$3,$4,'Q1 accepted fixture',$5)`,
      [missionId, objectiveId, runId, artifactId, agentSessionId],
    );
    await database.query(
      `UPDATE mission_objectives SET status='passed',conclusion='Accepted Q1 fixture' WHERE id=$1`,
      [objectiveId],
    );
    const afterAcceptance = await adapter.acquire({ missionId, objectiveId, runId });
    expect(afterAcceptance.objective).toMatchObject({
      state: "passed",
      conclusion: "Accepted Q1 fixture",
      acceptedEvidence: true,
    });
    expect(evaluateInvariants(afterAcceptance)).toHaveLength(52);
  });

  it("preserves unresolved protected recovery state without normalizing UNKNOWN", async () => {
    const snapshot = await acquireOperation("unresolved-operation");
    expect(snapshot.operation).toMatchObject({
      protectedTruth: "unknown",
      adaptiveProjectionTruth: "unknown",
      mutationTruth: "unknown",
      terminal: false,
    });
    expect(evaluateInvariants(snapshot)).toHaveLength(52);
  });

  function acquireOperation(operationId: string) {
    return new PostgresQ1Adapter(database).acquire({
      missionId,
      objectiveId,
      praxisSessionId,
      operationId,
    });
  }

  async function insertAdaptiveOperation(input: {
    operationId: string;
    sequence: number;
    semanticType: string;
    state: "completed" | "failed";
    mutationOutcome: "applied" | "unknown";
    functionalResult: "succeeded" | "inconclusive";
    dispatchBoundary: "acknowledged" | "dispatching";
  }) {
    const intent = {
      type: input.semanticType,
      authorization: { authorizationId },
    };
    await database.query(
      `INSERT INTO adaptive_operations(
         session_id,operation_id,sequence,mode,state,semantic_intent,expected_effect,policy_digest,
         dispatch_boundary,mutation_outcome,functional_result,privacy_result,evidence_result,
         quality_findings,safe_outcome,decision_boundary,idempotency_key,completed_at,mission_id,
         objective_id,flow_draft_id,authoring_intent,derived_action
       ) VALUES($1,$2,$3,'transact',$4,$5::jsonb,'{"type":"mutation"}'::jsonb,$6,$7,$8,$9,
         'sealed','[]'::jsonb,'[]'::jsonb,$10::jsonb,$11::jsonb,$12,now(),$13,$14,$15,$5::jsonb,
         '{"kind":"fixture"}'::jsonb)`,
      [
        praxisSessionId,
        input.operationId,
        input.sequence,
        input.state,
        JSON.stringify(intent),
        "a".repeat(64),
        input.dispatchBoundary,
        input.mutationOutcome,
        input.functionalResult,
        JSON.stringify({
          operationId: input.operationId,
          functionalResult: input.functionalResult,
          mutationOutcome: input.mutationOutcome,
          privacyResult: "sealed",
          evidenceResult: [],
          qualityFindings: [],
          durationMs: 1,
        }),
        JSON.stringify({
          type:
            input.mutationOutcome === "unknown"
              ? "mutation_reconciliation_required"
              : "objective_completed",
          safeActions: [],
        }),
        `adaptive-${input.operationId}`,
        missionId,
        objectiveId,
        flowDraftId,
      ],
    );
  }

  async function insertProtectedOperation(input: {
    operationId: string;
    state: "completed" | "recovery_required";
    mutationOutcome: "applied" | "unknown";
    dispatchState: "acknowledged" | "started";
  }) {
    await database.query(
      `INSERT INTO protected_operations(
         operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,environment_id,
         mission_id,objective_id,agent_session_id,flow_draft_id,authorization_id,program_digest,
         state,phase,dispatch_state,mutation_outcome,persistence_state,recovery_class,
         provider_idempotency_commitment,completed_at
       ) VALUES($1,$2,'authoring_session',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'fixture',$13,$14,
         $15,$16,$17,CASE WHEN $12='completed' THEN now() ELSE NULL END)`,
      [
        input.operationId,
        `mutation-${input.operationId}`,
        praxisSessionId,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        flowDraftId,
        authorizationId,
        "c".repeat(64),
        input.state,
        input.dispatchState,
        input.mutationOutcome,
        input.state === "completed" ? "committed" : "uncertain",
        input.state === "recovery_required" ? "reconciliation_required" : null,
        "b".repeat(64),
      ],
    );
  }
});
