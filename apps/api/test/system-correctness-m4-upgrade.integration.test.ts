import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { classifyHistoricalReconciliationAuthority } from "../src/adaptive-sessions/historical-operation-authority.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { loadConflictScope } from "../src/recovery/conflict-scope.repository.js";

const databaseUrl = process.env.SCRY_M4_UPGRADE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const preM4Fingerprint = "132f5164c9cb422405d2e4f7f151c6b0edc5e7fb6130f2eb6c4b069ffd838776";
const m4Fingerprint = "e8231b47b9a826867621a68305fe6329a49028f13d072492fa469ed6a0468fbb";

integration("Milestone 4 pre-schema durable-state upgrade", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const authorizationId = randomUUID();
  const fixtures = Object.fromEntries(
    "ABCDEFGHIJ"
      .split("")
      .map((key) => [key, { sessionId: randomUUID(), operationId: `m4-upgrade-${key}` }]),
  ) as Record<string, { sessionId: string; operationId: string }>;
  let database: Database;
  let repository: AdaptiveSessionRepository;

  afterAll(async () => database?.onModuleDestroy());

  it("preserves A-J truth and safely fences a legacy observing owner", async () => {
    process.env.DATABASE_URL = databaseUrl;
    database = new Database();
    repository = new AdaptiveSessionRepository(database);
    expect(await installedFingerprint()).toBe(preM4Fingerprint);
    expect(await hasLeaseColumn()).toBe(false);
    await seedControlPlane();
    await seedFixtures();

    const before = await truthSnapshot();
    expect(before).toMatchObject({
      A: { mutationOutcome: "not_applied", reconciliationState: null },
      B: { mutationOutcome: "unknown", reconciliationState: null },
      C: { mutationOutcome: "unknown", reconciliationState: "completed", result: "still_unknown" },
      D: { mutationOutcome: "unknown", reconciliationState: "completed", result: "proven_applied" },
      E: {
        mutationOutcome: "unknown",
        reconciliationState: "completed",
        result: "proven_not_applied",
      },
      F: { mutationOutcome: "unknown", reconciliationState: "observing", fencingToken: 1 },
      G: { mutationOutcome: "unknown" },
      H: { mutationOutcome: "unknown" },
      I: { mutationOutcome: "unknown", protectedMutationOutcome: "unknown" },
      J: { sessionState: "active", runtimeLeaseLive: false },
    });

    await proveTransactionalFailureRollback();
    expect(await installedFingerprint()).toBe(preM4Fingerprint);
    expect(await hasLeaseColumn()).toBe(false);

    execFileSync("pnpm", ["--filter", "@scry/api", "db:migrate"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl! },
      stdio: "pipe",
    });
    expect(await installedFingerprint()).toBe(m4Fingerprint);
    expect(await hasLeaseColumn()).toBe(true);

    const after = await truthSnapshot();
    expect(after).toEqual(before);
    const legacy = await database.query<{
      id: string;
      fencingToken: number;
      expired: boolean;
    }>(
      `SELECT id::text,fencing_token AS "fencingToken",lease_expires_at<=now() AS expired
       FROM adaptive_operation_reconciliations
       WHERE session_id=$1 AND operation_id=$2 AND state='observing'`,
      [fixtures.F!.sessionId, fixtures.F!.operationId],
    );
    expect(legacy.rows[0]).toMatchObject({ fencingToken: 1, expired: true });
    await expect(
      repository.completeUnknownReconciliation({
        sessionId: fixtures.F!.sessionId,
        missionId,
        operationId: fixtures.F!.operationId,
        idempotencyKey: "legacy-observer",
        reconciliationId: legacy.rows[0]!.id,
        fencingToken: 1,
        result: "proven_applied",
        reasonCode: "LEGACY_OWNER_MUST_NOT_SETTLE",
        evidence: { fixture: true },
        runtimeOwned: false,
      }),
    ).rejects.toMatchObject({ response: { code: "UNKNOWN_RECONCILIATION_FENCE_LOST" } });

    const fresh = await repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: fixtures.F!.sessionId,
      missionId,
      operationId: fixtures.F!.operationId,
      idempotencyKey: "fresh-observer-after-upgrade",
    });
    if (!fresh.id || fresh.fencingToken === undefined)
      throw new Error("CURRENT_RECONCILIATION_CLAIM_MISSING");
    expect(fresh).toMatchObject({ state: "observing", attempt: 2, fencingToken: 1 });
    await repository.completeUnknownReconciliation({
      sessionId: fixtures.F!.sessionId,
      missionId,
      operationId: fixtures.F!.operationId,
      idempotencyKey: "fresh-observer-after-upgrade",
      reconciliationId: fresh.id,
      fencingToken: fresh.fencingToken,
      result: "still_unknown",
      reasonCode: "UPGRADE_FIXTURE_REMAINS_UNKNOWN",
      evidence: { fixture: true },
      runtimeOwned: false,
    });
    const fTruth = await operationTruth("F");
    expect(fTruth).toMatchObject({ mutationOutcome: "unknown" });
    expect(
      await database.query(
        `SELECT 1 FROM adaptive_operation_reconciliations
         WHERE session_id=$1 AND operation_id=$2 AND state='observing'`,
        [fixtures.F!.sessionId, fixtures.F!.operationId],
      ),
    ).toMatchObject({ rowCount: 0 });

    await expect(begin("G", "malformed-after-upgrade")).rejects.toMatchObject({
      response: { code: "RECONCILIATION_ACTION_MISSING", mutationOutcome: "unknown" },
    });
    await expect(begin("H", "missing-baseline-after-upgrade")).rejects.toMatchObject({
      response: { code: "RECONCILIATION_BASELINE_MISSING", mutationOutcome: "unknown" },
    });
    await expect(begin("I", "missing-binding-after-upgrade")).rejects.toMatchObject({
      response: { code: "RECONCILIATION_PROVIDER_BINDING_MISSING", mutationOutcome: "unknown" },
    });

    const blockers = await loadConflictScope((text, values) => database.query(text, values), {
      projectId,
    });
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "adaptive_unknown", missionId, blocking: true }),
        expect.objectContaining({ kind: "protected_mutation", missionId, blocking: true }),
        expect.objectContaining({ kind: "praxis_recovery", lifecycle: "recovery_required" }),
      ]),
    );
    const protectedTruth = await operationTruth("I");
    expect(protectedTruth).toMatchObject({
      mutationOutcome: "unknown",
      protectedMutationOutcome: "unknown",
    });
    expect(
      classifyHistoricalReconciliationAuthority({
        action: null,
        expectedEffect: { type: "none" },
        baseline: null,
        localEvidence: null,
      }),
    ).toMatchObject({ kind: "malformed_authority" });
  });

  async function seedControlPlane() {
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)`, [
      workspaceId,
      `M4 upgrade ${workspaceId}`,
      `m4-upgrade-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)`, [
      projectId,
      workspaceId,
      "M4 upgrade",
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'M4 upgrade','https://example.test',$3::jsonb)`,
      [
        environmentId,
        projectId,
        JSON.stringify({
          allowedOrigins: ["https://example.test"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 20,
          maxDurationMs: 30_000,
          maxNavigations: 10,
        }),
      ],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
       VALUES($1,$2,'M4 upgrade','Qualify pre-M4 migration')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
       VALUES($1,$2,'M4 upgrade objective','{}'::jsonb,0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','M4 upgrade fixture','m4-upgrade-agent')`,
      [agentSessionId, missionId],
    );
    await database.query(
      `INSERT INTO flow_drafts(
         id,project_id,mission_id,objective_id,environment_id,name,content,plan,
         created_by_agent_session_id)
       VALUES($1,$2,$3,$4,$5,'M4 upgrade','{}'::jsonb,'{}'::jsonb,$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
  }

  async function seedFixtures() {
    for (const key of Object.keys(fixtures)) {
      const state = key === "A" ? "completed" : key === "J" ? "active" : "recovery_required";
      await database.query(
        `INSERT INTO adaptive_sessions(
           id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
           mission_id,objective_id,flow_draft_id,idempotency_key,active_objective_id,
           active_flow_draft_id,authoring_turn_budgets,protected_reference_allowlist,agent_session_id,
           completed_at)
         VALUES($1,$2,$3,$4,$5,'M4 upgrade fixture','["https://example.test"]'::jsonb,
           $6,$7,$8,$9,$7,$8,'{}'::jsonb,'[]'::jsonb,$10,
           CASE WHEN $5='completed' THEN now() ELSE NULL END)`,
        [
          fixtures[key]!.sessionId,
          projectId,
          environmentId,
          randomUUID(),
          state,
          missionId,
          objectiveId,
          flowDraftId,
          `m4-upgrade-session-${key}`,
          agentSessionId,
        ],
      );
      if (key === "J") continue;
      const mutation = key === "A" ? "not_applied" : "unknown";
      const expectedEffect =
        key === "H" ? { type: "navigation", url: "https://example.test/done" } : { type: "none" };
      const action = key === "G" ? null : { type: "navigate", url: "https://example.test" };
      await database.query(
        `INSERT INTO adaptive_operations(
           session_id,operation_id,sequence,mode,state,semantic_intent,expected_effect,policy_digest,
           dispatch_boundary,mutation_outcome,functional_result,privacy_result,evidence_result,
           quality_findings,safe_outcome,decision_boundary,idempotency_key,mission_id,objective_id,
           flow_draft_id,authoring_intent,derived_action,completed_at)
         VALUES($1,$2,1,'transact','failed',$3::jsonb,$4::jsonb,$5,'dispatched',$6,
           'inconclusive','unverified','[]'::jsonb,'[]'::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,
           $3::jsonb,$13::jsonb,now())`,
        [
          fixtures[key]!.sessionId,
          fixtures[key]!.operationId,
          JSON.stringify({
            intentId: fixtures[key]!.operationId,
            action: { kind: "click" },
          }),
          JSON.stringify(expectedEffect),
          "a".repeat(64),
          mutation,
          JSON.stringify({ mutationOutcome: mutation }),
          JSON.stringify({ type: "mutation_reconciliation_required" }),
          `m4-upgrade-operation-${key}`,
          missionId,
          objectiveId,
          flowDraftId,
          JSON.stringify({ action, expectedEffect, mode: "transact" }),
        ],
      );
    }
    await seedCompletedReconciliation("C", "still_unknown");
    await seedCompletedReconciliation("D", "proven_applied");
    await seedCompletedReconciliation("E", "proven_not_applied");
    await database.query(
      `INSERT INTO adaptive_operation_reconciliations(
         session_id,operation_id,mission_id,objective_id,flow_draft_id,idempotency_key,
         request_digest,attempt,state,strategy,expected_effect,original_outcome,started_at)
       VALUES($1,$2,$3,$4,$5,'legacy-observer',$6,1,'observing','unavailable',
         '{"type":"none"}'::jsonb,'{"mutationOutcome":"unknown"}'::jsonb,now()-interval '1 day')`,
      [
        fixtures.F!.sessionId,
        fixtures.F!.operationId,
        missionId,
        objectiveId,
        flowDraftId,
        "f".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,status,
         granted_by_agent_session_id,operation_id,praxis_session_id)
       VALUES($1,$2,$3,$4,'protected_mutation','M4 upgrade','approved',$5,$6,$7)`,
      [
        authorizationId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        fixtures.I!.operationId,
        fixtures.I!.sessionId,
      ],
    );
    await database.query(
      `INSERT INTO protected_operations(
         operation_id,mutation_identity,owner_kind,authoring_session_id,project_id,environment_id,
         mission_id,objective_id,agent_session_id,flow_draft_id,authorization_id,program_digest,
         state,phase,dispatch_state,mutation_outcome,recovery_class)
       VALUES($1,$2,'authoring_session',$3,$4,$5,$6,$7,$8,$9,$10,$11,
         'recovery_required','recovery','started','unknown','reconciliation_required')`,
      [
        fixtures.I!.operationId,
        "m4-upgrade-protected-I",
        fixtures.I!.sessionId,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        flowDraftId,
        authorizationId,
        "b".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO adaptive_session_runtime_leases(session_id,owner_id,lease_expires_at)
       VALUES($1,$2,now()-interval '1 day')`,
      [fixtures.J!.sessionId, randomUUID()],
    );
  }

  async function seedCompletedReconciliation(key: string, result: string) {
    await database.query(
      `INSERT INTO adaptive_operation_reconciliations(
         session_id,operation_id,mission_id,objective_id,flow_draft_id,idempotency_key,
         request_digest,attempt,state,strategy,expected_effect,original_outcome,evidence,result,
         reason_code,fencing_token,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,1,'completed','unavailable','{"type":"none"}'::jsonb,
         '{"mutationOutcome":"unknown"}'::jsonb,'{"fixture":true}'::jsonb,$8,
         'PRE_M4_FIXTURE',2,now()-interval '1 day')`,
      [
        fixtures[key]!.sessionId,
        fixtures[key]!.operationId,
        missionId,
        objectiveId,
        flowDraftId,
        `m4-upgrade-reconciliation-${key}`,
        key.toLowerCase().repeat(64),
        result,
      ],
    );
  }

  async function proveTransactionalFailureRollback() {
    const migration = await readFile(
      new URL("../migrations/system-correctness-m4-reconciliation-lease.sql", import.meta.url),
      "utf8",
    );
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration);
      await expect(client.query("SELECT 1/0")).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }

  async function installedFingerprint() {
    const result = await database.query<{ fingerprint: string }>(
      `SELECT schema_fingerprint AS fingerprint FROM schema_baseline WHERE singleton=true`,
    );
    return result.rows[0]?.fingerprint;
  }

  async function hasLeaseColumn() {
    const result = await database.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='adaptive_operation_reconciliations'
         AND column_name='lease_expires_at'`,
    );
    return Boolean(result.rowCount);
  }

  async function truthSnapshot() {
    return Object.fromEntries(
      await Promise.all(Object.keys(fixtures).map(async (key) => [key, await operationTruth(key)])),
    );
  }

  async function operationTruth(key: string) {
    const result = await database.query<{
      sessionState: string;
      mutationOutcome: string | null;
      protectedMutationOutcome: string | null;
      reconciliationState: string | null;
      result: string | null;
      fencingToken: number | null;
      runtimeLeaseLive: boolean;
    }>(
      `SELECT session.state AS "sessionState",operation.mutation_outcome AS "mutationOutcome",
              protected.mutation_outcome AS "protectedMutationOutcome",
              reconciliation.state AS "reconciliationState",reconciliation.result,
              reconciliation.fencing_token AS "fencingToken",
              COALESCE(runtime.lease_expires_at>now(),false) AS "runtimeLeaseLive"
       FROM adaptive_sessions session
       LEFT JOIN adaptive_operations operation ON operation.session_id=session.id
       LEFT JOIN protected_operations protected ON protected.authoring_session_id=session.id
       LEFT JOIN adaptive_operation_reconciliations reconciliation
         ON reconciliation.session_id=operation.session_id
        AND reconciliation.operation_id=operation.operation_id
       LEFT JOIN adaptive_session_runtime_leases runtime ON runtime.session_id=session.id
       WHERE session.id=$1 ORDER BY reconciliation.attempt DESC NULLS LAST LIMIT 1`,
      [fixtures[key]!.sessionId],
    );
    return result.rows[0];
  }

  function begin(key: string, idempotencyKey: string) {
    return repository.beginUnknownReconciliation({
      workspaceId,
      sessionId: fixtures[key]!.sessionId,
      missionId,
      operationId: fixtures[key]!.operationId,
      idempotencyKey,
    });
  }
});
