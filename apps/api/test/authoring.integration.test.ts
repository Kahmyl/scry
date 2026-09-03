import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { currentPlanSchema, type InteractionTargetIntent } from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuthenticationAttemptRepository,
  AuthenticationAuthoringService,
} from "../src/authentication-authoring/index.js";
import { AuthoringService } from "../src/authoring/index.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/database.js";
import { RunAttemptRepository } from "../src/runtime/repositories/run-attempt.repository.js";

const enabled = Boolean(process.env.SCRY_AUTHORING_TEST_DATABASE_URL);

describe.skipIf(!enabled)("authoring, compilation, and publication boundary", () => {
  let database: Database;
  let service: AuthoringService;
  const suiteCertificationWaitTimeout = process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS;

  const project = randomUUID();
  const mission = randomUUID();
  const objective = randomUUID();
  const session = randomUUID();
  const environment = randomUUID();

  const principal = {
    kind: "service" as const,
    subject: "scry-service" as const,
  };

  const context = {
    missionId: mission,
    objectiveId: objective,
    agentSessionId: session,
  };

  it("publishes a mechanically valid representation without compilation", async () => {
    const name = `Direct representation ${randomUUID()}`;
    const plan = currentPlanSchema.parse({
      name,
      objective: "Open preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const draft = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name,
      description: "",
      content: {
        objective: "Open preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `direct-draft-${randomUUID()}`,
    });
    const idempotencyKey = `direct-publish-${randomUUID()}`;
    const publication = await service.publish(principal, draft.id!, {
      ...context,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "acceptance",
      reason: "Publish representation without qualification admission",
      idempotencyKey,
    });
    const replay = await service.publish(principal, draft.id!, {
      ...context,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "acceptance",
      reason: "Publish representation without qualification admission",
      idempotencyKey,
    });
    expect(publication).toMatchObject({ revision: 1, replayed: false });
    expect(replay).toMatchObject({ revisionId: publication.revisionId, replayed: true });
    await expect(
      database.query(`SELECT count(*)::integer count FROM flow_compilations WHERE draft_id=$1`, [
        draft.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("publishes same-named mission-local Flows under distinct Mission owners", async () => {
    const priorMission = randomUUID();
    const priorObjective = randomUUID();
    const priorSession = randomUUID();
    const name = `Mission-local label ${randomUUID()}`;
    const plan = currentPlanSchema.parse({
      name,
      objective: "Open preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
       VALUES($1,$2,'Prior Mission','Preserve an independently owned Flow')`,
      [priorMission, project],
    );
    await database.query(
      `INSERT INTO mission_objectives(
         id,mission_id,title,dependencies,completion_criteria,objective_order)
       VALUES($1,$2,'Open application','[]','[{"description":"Page opens","required":true}]',0)`,
      [priorObjective, priorMission],
    );
    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,provider,instruction_snapshot,idempotency_key)
       VALUES($1,$2,'scry_agent','Prior Mission authoring',$3)`,
      [priorSession, priorMission, `session-${priorSession}`],
    );

    const content = {
      objective: "Open preview",
      preconditions: [],
      expectedOutcomes: ["Preview opens"],
      prohibitedSideEffects: [],
    };
    const priorContext = {
      missionId: priorMission,
      objectiveId: priorObjective,
      agentSessionId: priorSession,
    };
    const priorDraft = await service.createDraft(principal, {
      ...priorContext,
      projectId: project,
      environmentId: environment,
      name,
      description: "Prior Mission representation",
      content,
      plan,
      idempotencyKey: `prior-draft-${randomUUID()}`,
    });
    const priorPublication = await service.publish(principal, priorDraft.id!, {
      ...priorContext,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Publish prior Mission representation",
      idempotencyKey: `prior-publish-${randomUUID()}`,
    });

    const currentDraft = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name,
      description: "Current Mission representation",
      content,
      plan,
      idempotencyKey: `current-draft-${randomUUID()}`,
    });
    const currentPublication = await service.publish(principal, currentDraft.id!, {
      ...context,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Publish independently owned current Mission representation",
      idempotencyKey: `current-publish-${randomUUID()}`,
    });

    expect(currentPublication.flowId).not.toBe(priorPublication.flowId);
    await expect(
      database.query(
        `SELECT id,owner_mission_id AS "ownerMissionId"
         FROM flows WHERE project_id=$1 AND name=$2 ORDER BY owner_mission_id`,
        [project, name],
      ),
    ).resolves.toMatchObject({
      rowCount: 2,
      rows: expect.arrayContaining([
        { id: priorPublication.flowId, ownerMissionId: priorMission },
        { id: currentPublication.flowId, ownerMissionId: mission },
      ]),
    });
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.SCRY_AUTHORING_TEST_DATABASE_URL;
    process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS = "0";

    database = new Database();
    service = new AuthoringService(database, {
      assertAcceptingWork: async () => ({ ready: true }),
    } as never);

    await database.query(
      `INSERT INTO projects(id,workspace_id,name)
         VALUES($1,'00000000-0000-4000-8000-000000000001',$2)`,
      [project, `authoring-${project}`],
    );

    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
         VALUES($1,$2,'Preview','https://example.test',$3::jsonb)`,
      [
        environment,
        project,
        JSON.stringify({
          allowedOrigins: ["https://example.test"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 10,
          maxDurationMs: 120_000,
          maxNavigations: 3,
        }),
      ],
    );

    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction)
         VALUES($1,$2,'Authoring cutover','Verify authoring lifecycle')`,
      [mission, project],
    );

    await database.query(
      `INSERT INTO mission_objectives(
          id,
          mission_id,
          title,
          dependencies,
          completion_criteria,
          objective_order
        )
        VALUES(
          $1,
          $2,
          'Open application',
          '[]',
          '[{"description":"Page opens","required":true}]',
          0
        )`,
      [objective, mission],
    );

    await database.query(
      `INSERT INTO agent_sessions(
          id,
          mission_id,
          provider,
          instruction_snapshot,
          idempotency_key
        )
        VALUES($1,$2,'scry_agent','Authoring lifecycle',$3)`,
      [session, mission, `session-${session}`],
    );
  });

  afterAll(async () => {
    if (suiteCertificationWaitTimeout === undefined) {
      delete process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS;
    } else {
      process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS = suiteCertificationWaitTimeout;
    }
    await database.onModuleDestroy();
  });

  it("edits without revisions, compiles once, and publishes one immutable revision", async () => {
    const plan = currentPlanSchema.parse({
      name: "Open preview",
      objective: "Open preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 1,
        maxDurationMs: 10_000,
        maxNavigations: 1,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: "Open preview",
      description: "",
      content: {
        objective: "Open preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-success-${randomUUID()}`,
    });

    const draftId = created.id!;

    const updated = await service.updateDraft(principal, draftId, {
      ...context,
      expectedVersion: 1,
      description: "Compiled after one consolidated probe",
      reason: "Apply complete correction set",
    });

    expect(updated.version).toBe(2);

    expect(
      Number(
        (
          await database.query(
            `SELECT count(*)
               FROM flow_revisions fr
               JOIN flows f ON f.id=fr.flow_id
               WHERE f.project_id=$1 AND f.name='Open preview'`,
            [project],
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);

    const probe = randomUUID();

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId,
      mission,
      objective,
      environment,
      session,
      draftVersion: 2,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [],
        readiness: [],
        diagnostics: [],
        pageFingerprint: "a".repeat(64),
        learnedContracts: [successfulLearnedRecord("publish")],
      },
    });

    const certified = await service.compileAndCertify(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 2,
      probeSessionId: probe,
      idempotencyKey: `compile-success-${randomUUID()}`,
      viewport: { width: 1280, height: 720 },
      seed: 1,
    });
    const compilation = certified.compilation;
    if (!("certificationRunId" in certified.certification)) {
      throw new Error("expected a certification Run");
    }
    await completeCertification(database, certified.certification);

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [],
    });

    const publication = await service.publish(principal, draftId, {
      ...context,
      expectedVersion: 2,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Probe and compilation passed",
      idempotencyKey: `publish-${randomUUID()}`,
    });

    // The optional historical compilation retains candidate revision 1 as evidence;
    // representation-only publication appends the authored draft as revision 2.
    expect(publication.revision).toBe(2);
    expect(publication.replayed).toBe(false);

    // Regression characterization: before M1, publication inserted a Flow with
    // owner_mission_id=NULL and violated the mandatory aggregate-root contract.
    await expect(
      database.query(
        `SELECT owner_mission_id AS "ownerMissionId",
                owner_objective_id AS "ownerObjectiveId"
         FROM flows WHERE id=$1`,
        [publication.flowId],
      ),
    ).resolves.toMatchObject({
      rows: [{ ownerMissionId: mission, ownerObjectiveId: objective }],
    });

    expect(
      Number(
        (
          await database.query(`SELECT count(*) FROM flow_revisions WHERE id=$1`, [
            publication.revisionId,
          ])
        ).rows[0]!.count,
      ),
    ).toBe(1);

    await expect(
      service.updateDraft(principal, draftId, {
        ...context,
        expectedVersion: 2,
        description: "late edit",
        reason: "should fail",
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "FLOW_DRAFT_IMMUTABLE",
      }),
    });
  });

  it("certifies a v1 compatibility compilation and exposes its run contract ID", async () => {
    const plan = currentPlanSchema.parse({
      name: "Inspect preview",
      objective: "Inspect preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: "Inspect preview compatibility flow",
      description: "",
      content: {
        objective: "Inspect preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-v1-certification-${randomUUID()}`,
    });
    const probe = randomUUID();
    await insertCompletedProbe(database, {
      probeId: probe,
      draftId: created.id!,
      mission,
      objective,
      environment,
      session,
      draftVersion: 1,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [],
        readiness: [],
        diagnostics: [],
        pageFingerprint: "a".repeat(64),
        learnedContracts: [successfulLearnedRecord("certify")],
      },
    });

    const previousWaitTimeout = process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS;
    process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS = "0";
    try {
      const compileInput = {
        ...context,
        environmentId: environment,
        draftVersion: 1,
        probeSessionId: probe,
        idempotencyKey: `compile-v1-certification-${randomUUID()}`,
        viewport: { width: 1280, height: 720 },
        seed: 1,
      } as const;
      const result = await service.compileAndCertify(principal, created.id!, compileInput);

      expect(result.compilation.contractVersion).toBe("v2-learned-interactions");
      expect(result.compiledContractId).toBe(result.compilation.id);
      expect(result.certification).toMatchObject({ status: "certification_pending" });
      expect(result.certification).toMatchObject({
        decisionBoundary: {
          type: "certification_wait_timeout",
          terminal: false,
          resumeWithSameIdempotencyKey: true,
        },
        safeActions: ["compile_and_certify_flow"],
      });
      if (!("certificationRunId" in result.certification)) {
        throw new Error("Certification Run was not queued");
      }
      const attempts = new RunAttemptRepository(database);
      process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS = "3000";
      const pendingReplayPromise = service.compileAndCertify(principal, created.id!, compileInput);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const claimToken = randomUUID();
      const attempt = await attempts.claimAttempt(
        result.certification.certificationRunId,
        "v1-certification-worker",
        claimToken,
      );
      await attempts.markRunning(result.certification.certificationRunId, attempt!.id, claimToken);
      await stageCertificationEvidence(
        database,
        result.certification.certificationRunId,
        attempt!.id,
      );
      await attempts.markFinalizing(
        result.certification.certificationRunId,
        attempt!.id,
        claimToken,
      );
      await attempts.completeAttempt(
        result.certification.certificationRunId,
        attempt!.id,
        claimToken,
        "passed",
        "passed",
        { kind: "required" },
      );
      const pendingReplay = await pendingReplayPromise;
      expect(pendingReplay).toMatchObject({
        compiledContractId: result.compiledContractId,
        compilation: { id: result.compilation.id, replayed: true },
        certification: {
          status: "certified",
          certificationRunId: result.certification.certificationRunId,
          replayed: true,
          decisionBoundary: { type: "certification_succeeded", terminal: true },
          safeActions: ["publish_flow_draft"],
        },
        publishableMetadata: {
          compiledContractId: result.compiledContractId,
          compilationId: result.compiledContractId,
        },
      });

      const completedReplay = await service.compileAndCertify(principal, created.id!, compileInput);
      expect(completedReplay).toMatchObject({
        compiledContractId: result.compiledContractId,
        compilation: { id: result.compilation.id, replayed: true },
        certification: {
          status: "certified",
          certificationRunId: result.certification.certificationRunId,
          replayed: true,
        },
        publishableMetadata: {
          compiledContractId: result.compiledContractId,
          compilationId: result.compiledContractId,
          certificationRunId: result.certification.certificationRunId,
        },
      });

      const persisted = await database.query<{
        compilationCount: number;
        certificationRunCount: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM flow_compilations
            WHERE draft_id=$1 AND idempotency_key=$2) AS "compilationCount",
           (SELECT count(*)::integer FROM runs
            WHERE compiled_contract_id=$3) AS "certificationRunCount"`,
        [created.id!, compileInput.idempotencyKey, result.compiledContractId],
      );
      expect(persisted.rows[0]).toEqual({ compilationCount: 1, certificationRunCount: 1 });

      const publication = await service.publish(principal, created.id!, {
        ...context,
        expectedVersion: 1,
        visibility: "mission_local",
        purpose: "primary",
        reason: "Certified v1 compatibility contract",
        idempotencyKey: `publish-v1-certification-${randomUUID()}`,
      });
      expect(publication.replayed).toBe(false);
    } finally {
      if (previousWaitTimeout === undefined) delete process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS;
      else process.env.SCRY_CERTIFICATION_WAIT_TIMEOUT_MS = previousWaitTimeout;
    }
  });

  it("certifies one adaptive authoring source and rejects its UUID as a legacy Probe reference", async () => {
    const plan = currentPlanSchema.parse({
      name: "Adaptive qualification",
      objective: "Open the qualified application",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: { maxActions: 1, maxDurationMs: 10_000, maxNavigations: 1 },
      checkpoints: [],
      steps: [
        {
          id: "open-adaptive",
          title: "Open qualified application",
          action: { type: "navigate", url: "https://example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: `Adaptive qualification ${randomUUID()}`,
      description: "",
      content: {
        objective: "Open the qualified application",
        preconditions: [],
        expectedOutcomes: ["Application opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `adaptive-draft-${randomUUID()}`,
    });
    const authoringSessionId = randomUUID();
    await database.query(
      `INSERT INTO adaptive_sessions(
         id,project_id,environment_id,correlation_id,state,objective,allowed_origins,
         decision_boundary,mission_id,objective_id,flow_draft_id,idempotency_key,
         completed_at,active_objective_id,active_flow_draft_id,authoring_turn_budgets,
         protected_reference_allowlist,agent_session_id,qualified_flow_draft_version
       ) VALUES(
         $1,$2,$3,$4,'completed','Open the qualified application',$5::jsonb,
         $6::jsonb,$7,$8,$9,$10,now(),$8,$9,$11::jsonb,'[]'::jsonb,$12,1
       )`,
      [
        authoringSessionId,
        project,
        environment,
        randomUUID(),
        JSON.stringify(["https://example.test"]),
        JSON.stringify({
          type: "objective_completed",
          reasonCode: "MISSION_AUTHORING_TURN_COMPLETED",
          safeActions: [],
        }),
        mission,
        objective,
        created.id,
        `adaptive-certification-${randomUUID()}`,
        JSON.stringify({ maxIntents: 5, maxDurationMs: 60_000 }),
        session,
      ],
    );
    await database.query(
      `INSERT INTO adaptive_operations(
         session_id,operation_id,sequence,mode,state,semantic_intent,expected_effect,
         policy_digest,dispatch_boundary,mutation_outcome,functional_result,privacy_result,
         evidence_result,quality_findings,safe_outcome,decision_boundary,idempotency_key,
         completed_at,mission_id,objective_id,flow_draft_id,authoring_intent,derived_action
       ) VALUES(
         $1,'open-adaptive',1,'rehearse','completed',$2::jsonb,$3::jsonb,$4,
         'acknowledged','applied','succeeded','verified','[]'::jsonb,'[]'::jsonb,
         $5::jsonb,$6::jsonb,$7,now(),$8,$9,$10,$2::jsonb,$11::jsonb
       )`,
      [
        authoringSessionId,
        JSON.stringify({
          intentId: "open-adaptive",
          action: { kind: "navigate", url: "https://example.test" },
          expectedEffect: { kind: "navigation", match: "path" },
        }),
        JSON.stringify({ type: "navigation", match: "path" }),
        "b".repeat(64),
        JSON.stringify({
          resolvedTarget: {
            digest: "c".repeat(64),
            capabilityDigest: "d".repeat(64),
          },
        }),
        JSON.stringify({ type: "objective_completed", safeActions: [] }),
        `adaptive-operation-${randomUUID()}`,
        mission,
        objective,
        created.id,
        JSON.stringify({
          mode: "rehearse",
          action: { type: "navigate", url: "https://example.test" },
          expectedEffect: { type: "navigation", match: "path" },
        }),
      ],
    );

    await expect(
      service.compileAndCertify(principal, created.id!, {
        ...context,
        environmentId: environment,
        draftVersion: 1,
        probeSessionId: authoringSessionId,
        idempotencyKey: `invalid-probe-${randomUUID()}`,
        viewport: { width: 1280, height: 720 },
        seed: 1,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "PROBE_SESSION_INVALID",
        mutationOutcome: "not_applied",
        safeActions: ["get_flow_draft"],
      },
    });
    expect(
      Number(
        (
          await database.query(`SELECT count(*) FROM flow_compilations WHERE draft_id=$1`, [
            created.id,
          ])
        ).rows[0]!.count,
      ),
    ).toBe(0);

    const request = (key: string) =>
      service.compileAndCertify(principal, created.id!, {
        ...context,
        environmentId: environment,
        draftVersion: 1,
        authoringSessionId,
        idempotencyKey: key,
        viewport: { width: 1280, height: 720 },
        seed: 1,
      });
    const [first, concurrent] = await Promise.all([
      request(`adaptive-compile-a-${randomUUID()}`),
      request(`adaptive-compile-b-${randomUUID()}`),
    ]);
    expect(first.compiledContractId).toBe(concurrent.compiledContractId);
    expect(first.certification).toMatchObject({ status: "certification_pending" });
    expect(concurrent.certification).toMatchObject({ status: "certification_pending" });

    const persisted = await database.query<{
      compilationCount: number;
      runCount: number;
      authoringSessionId: string;
      certificationCandidate: boolean;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM flow_compilations WHERE draft_id=$1) AS "compilationCount",
         (SELECT count(*)::integer FROM runs WHERE compiled_contract_id=$2) AS "runCount",
         compilation.adaptive_session_id AS "authoringSessionId",
         (run.execution_snapshot->>'certificationCandidate')::boolean AS "certificationCandidate"
       FROM flow_compilations compilation
       JOIN runs run ON run.id=compilation.certification_run_id
       WHERE compilation.id=$2`,
      [created.id, first.compiledContractId],
    );
    expect(persisted.rows[0]).toEqual({
      compilationCount: 1,
      runCount: 1,
      authoringSessionId,
      certificationCandidate: true,
    });

    const certificationRunId =
      "certificationRunId" in first.certification
        ? first.certification.certificationRunId
        : undefined;
    if (!certificationRunId) throw new Error("Certification Run was not queued");
    await completeCertification(database, { certificationRunId });
    const restoreOwnerId = randomUUID();
    await database.query(
      `INSERT INTO adaptive_session_runtime_leases(
         session_id,owner_id,fencing_token,lease_expires_at
       ) VALUES($1,$2,1,now()+interval '1 minute')
       ON CONFLICT(session_id) DO UPDATE SET owner_id=excluded.owner_id,
         fencing_token=excluded.fencing_token,lease_expires_at=excluded.lease_expires_at`,
      [authoringSessionId, restoreOwnerId],
    );
    const checkpoint = await database.query<{ id: string }>(
      `UPDATE run_successor_checkpoints SET state='restoring',
         claimed_by_authoring_session_id=$2,restore_owner_id=$3,restore_fencing_token=1
       WHERE run_id=$1 RETURNING id`,
      [certificationRunId, authoringSessionId, restoreOwnerId],
    );
    await new AdaptiveSessionRepository(database).completeSuccessorCheckpoint(
      authoringSessionId,
      checkpoint.rows[0]!.id,
      restoreOwnerId,
      1,
      "verified",
    );
    expect(
      (
        await database.query(
          `SELECT state,ciphertext,initialization_vector,authentication_tag
           FROM run_successor_checkpoints WHERE id=$1`,
          [checkpoint.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({
      state: "verified",
      ciphertext: null,
      initialization_vector: null,
      authentication_tag: null,
    });

    const edited = await service.updateDraft(principal, created.id!, {
      ...context,
      expectedVersion: 1,
      description: "Changed after the qualification session closed",
      reason: "Exercise stale adaptive qualification fencing",
    });
    await expect(
      service.compileAndCertify(principal, created.id!, {
        ...context,
        environmentId: environment,
        draftVersion: edited.version!,
        authoringSessionId,
        idempotencyKey: `stale-adaptive-${randomUUID()}`,
        viewport: { width: 1280, height: 720 },
        seed: 1,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "AUTHORING_QUALIFICATION_SESSION_NOT_COMPLETED",
        mutationOutcome: "not_applied",
      },
    });
  });

  it("keeps quality findings visible without blocking compilation", async () => {
    const plan = currentPlanSchema.parse({
      name: "Open preview",
      objective: "Open preview",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 1,
        maxDurationMs: 10_000,
        maxNavigations: 1,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: "Open preview with diagnostic",
      description: "",
      content: {
        objective: "Open preview",
        preconditions: [],
        expectedOutcomes: ["Preview opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-diagnostic-${randomUUID()}`,
    });

    const draftId = created.id!;

    const updated = await service.updateDraft(principal, draftId, {
      ...context,
      expectedVersion: 1,
      description: "Compiled after one consolidated probe",
      reason: "Apply complete correction set",
    });

    expect(updated.version).toBe(2);

    const probe = randomUUID();

    const diagnostic = {
      code: "FIELD_HAS_NO_ASSOCIATED_LABEL",
      message: "Field has no associated label.",
    };

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId,
      mission,
      objective,
      environment,
      session,
      draftVersion: 2,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [],
        readiness: [],
        diagnostics: [diagnostic],
        pageFingerprint: "a".repeat(64),
        learnedContracts: [successfulLearnedRecord("quality")],
      },
    });

    const compilation = await service.compile(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 2,
      probeSessionId: probe,
      idempotencyKey: `compile-diagnostic-${randomUUID()}`,
    });

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [],
      blockers: [],
      warnings: [],
      qualityFindings: [diagnostic],
    });

    const draftState = await database.query(`SELECT state FROM flow_drafts WHERE id=$1`, [draftId]);

    expect(draftState.rows[0]!.state).toBe("publishable");
  });

  it("starts one interactive authoring session with budgets and a browser lease", async () => {
    const plan = currentPlanSchema.parse({
      name: "Explore preview",
      objective: "Explore the preview application",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 7,
        maxDurationMs: 45_000,
        maxNavigations: 3,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: "Explore preview",
      description: "",
      content: {
        objective: "Explore the preview application",
        preconditions: [],
        expectedOutcomes: ["Authoring session starts"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-interactive-${randomUUID()}`,
    });

    await expect(
      service.startProbe(principal, created.id!, {
        ...context,
        objectiveId: randomUUID(),
        environmentId: environment,
        draftVersion: 1,
        mode: "queued",
        level: "inspection",
        disposableDataConfirmed: false,
        idempotencyKey: `probe-wrong-objective-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "AUTHORING_DRAFT_CONTEXT_MISMATCH",
      }),
      status: 409,
    });

    const probe = await service.startProbe(principal, created.id!, {
      ...context,
      environmentId: environment,
      draftVersion: 1,
      mode: "interactive",
      level: "inspection",
      disposableDataConfirmed: false,
      idempotencyKey: `probe-interactive-${randomUUID()}`,
    });

    expect(probe).toMatchObject({
      state: "queued",
      mode: "interactive",
      replayed: false,
      authoring: {
        status: "starting",
        documentEpoch: 0,
        actionsUsed: 0,
        actionBudget: 7,
        durationBudgetMs: "45000",
      },
      browserLease: {
        state: "provisioning",
      },
    });

    const persisted = await database.query<{
      mode: string;
      status: string;
      actionBudget: number;
      durationBudgetMs: string;
      leaseState: string;
      outboxCount: string;
      eventTypes: string[];
    }>(
      `SELECT
         p.mode,
         a.status,
         a.action_budget AS "actionBudget",
         a.duration_budget_ms::text AS "durationBudgetMs",
         l.state AS "leaseState",
         (
           SELECT count(*)::text
           FROM probe_outbox o
           WHERE o.probe_session_id=p.id
         ) AS "outboxCount",
         (
           SELECT array_agg(e.type ORDER BY e.sequence)
           FROM probe_events e
           WHERE e.probe_session_id=p.id
         ) AS "eventTypes"
       FROM probe_sessions p
       JOIN probe_authoring_sessions a
         ON a.probe_session_id=p.id
       JOIN authoring_browser_leases l
         ON l.id=a.browser_lease_id
       WHERE p.id=$1`,
      [probe.id],
    );

    expect(persisted.rows[0]).toMatchObject({
      mode: "interactive",
      status: "starting",
      actionBudget: 7,
      durationBudgetMs: "45000",
      leaseState: "provisioning",
      outboxCount: "0",
      eventTypes: ["authoring_session_started", "browser_lease_attached"],
    });

    await expect(
      service.startProbe(principal, created.id!, {
        ...context,
        environmentId: environment,
        draftVersion: 1,
        mode: "interactive",
        level: "inspection",
        disposableDataConfirmed: false,
        idempotencyKey: `probe-interactive-conflict-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "INTERACTIVE_PROBE_ALREADY_ACTIVE",
      }),
    });
  });

  it("publishes a compiled plan without probe-confirmed redundant steps", async () => {
    const ordersTarget = target("orders", "link", "Orders");

    const plan = currentPlanSchema.parse({
      name: "Open partner orders",
      objective: "Open the partner orders page",
      preconditions: [],
      allowedOrigins: ["https://example.test"],
      budgets: {
        maxActions: 3,
        maxDurationMs: 30_000,
        maxNavigations: 2,
      },
      checkpoints: [],
      steps: [
        {
          id: "open",
          title: "Open preview",
          action: {
            type: "navigate",
            url: "https://example.test",
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-menu",
          title: "Open partner navigation",
          action: {
            type: "click",
            target: target("open_menu", "button", "Open menu"),
            expectedEffect: {
              type: "visibility_change",
              target: ordersTarget,
              visible: true,
            },
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-orders",
          title: "Open orders",
          action: {
            type: "click",
            target: ordersTarget,
            expectedEffect: {
              type: "navigation",
              url: "/orders",
              match: "path",
            },
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: environment,
      name: "Open partner orders",
      description: "",
      content: {
        objective: "Open the partner orders page",
        preconditions: [],
        expectedOutcomes: ["Orders page opens"],
        prohibitedSideEffects: [],
      },
      plan,
      idempotencyKey: `draft-redundant-${randomUUID()}`,
    });

    const draftId = created.id!;
    const probe = randomUUID();

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId,
      mission,
      objective,
      environment,
      session,
      draftVersion: 1,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [
          {
            stepId: "open-menu",
            channel: "action",
            status: "redundant",
            reason: "expected_effect_already_satisfied",
            expectedEffectTarget: {
              role: "link",
              accessibleName: "Orders",
            },
          },
          {
            stepId: "open-orders",
            channel: "action",
            status: "resolved",
            confidence: 1,
            confidenceMargin: 1,
            fingerprint: {
              role: "link",
              accessibleName: "Orders",
            },
            strategy: "dom",
          },
        ],
        readiness: [],
        diagnostics: [],
        pageFingerprint: "b".repeat(64),
        learnedContracts: [successfulLearnedRecord("redundant")],
      },
    });

    const certified = await service.compileAndCertify(principal, draftId, {
      ...context,
      environmentId: environment,
      draftVersion: 1,
      probeSessionId: probe,
      idempotencyKey: `compile-redundant-${randomUUID()}`,
      viewport: { width: 1280, height: 720 },
      seed: 1,
    });
    const compilation = certified.compilation;
    if (!("certificationRunId" in certified.certification)) {
      throw new Error("expected a certification Run");
    }
    await completeCertification(database, certified.certification);

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [],
    });

    const publication = await service.publish(principal, draftId, {
      ...context,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Remove probe-confirmed redundant navigation preparation",
      idempotencyKey: `publish-redundant-${randomUUID()}`,
    });

    const revision = await database.query<{ plan: typeof plan }>(
      `SELECT plan
         FROM flow_revisions
         WHERE id=$1`,
      [publication.revisionId],
    );

    expect(revision.rows[0]!.plan.steps.map((step) => step.id)).toEqual([
      "open",
      "open-menu",
      "open-orders",
    ]);
  });

  it("authors the Vitract login vertical through authentication, adaptive compilation, certification, and replay", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../scripts/fixtures/vitract-login-baseline.json", import.meta.url),
        "utf8",
      ),
    );
    const vitractEnvironment = randomUUID();
    const probe = randomUUID();
    const lease = randomUUID();
    const ordersTarget = target("orders", "link", "Orders");

    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Vitract Preview','https://preview.vitract.com',$3::jsonb)`,
      [
        vitractEnvironment,
        project,
        JSON.stringify({
          allowedOrigins: ["https://preview.vitract.com"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 10,
          maxDurationMs: 120_000,
          maxNavigations: 3,
        }),
      ],
    );

    const plan = currentPlanSchema.parse({
      name: "Vitract partner orders",
      objective: "Authenticate to Vitract and open partner orders",
      preconditions: [],
      allowedOrigins: ["https://preview.vitract.com"],
      budgets: {
        maxActions: 4,
        maxDurationMs: 45_000,
        maxNavigations: 3,
      },
      checkpoints: [],
      steps: [
        {
          id: "open-login",
          title: "Open Vitract login",
          action: {
            type: "navigate",
            url: fixture.target.url,
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-menu",
          title: fixture.observedOutcome.failedStepTitle,
          action: {
            type: "click",
            target: target("open_menu", "button", "Open menu"),
            expectedEffect: {
              type: "visibility_change",
              target: ordersTarget,
              visible: true,
            },
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-orders",
          title: "Open orders",
          action: {
            type: "click",
            target: ordersTarget,
            expectedEffect: {
              type: "navigation",
              url: "/orders",
              match: "path",
            },
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    const created = await service.createDraft(principal, {
      ...context,
      projectId: project,
      environmentId: vitractEnvironment,
      name: "Vitract partner orders",
      description: "",
      content: {
        objective: "Authenticate to Vitract and open partner orders",
        preconditions: [],
        expectedOutcomes: ["Orders navigation succeeds"],
        prohibitedSideEffects: ["Do not retry credential submission"],
      },
      plan,
      idempotencyKey: `draft-vitract-${randomUUID()}`,
    });

    await insertCompletedProbe(database, {
      probeId: probe,
      draftId: created.id!,
      mission,
      objective,
      environment: vitractEnvironment,
      session,
      draftVersion: 1,
      result: {
        allResolved: true,
        runtimeHealthy: true,
        targets: [
          {
            stepId: "open-menu",
            channel: "action",
            status: "redundant",
            reason: "expected_effect_already_satisfied",
            expectedEffectTarget: {
              role: "link",
              accessibleName: "Orders",
            },
          },
          {
            stepId: "open-orders",
            channel: "action",
            status: "resolved",
            confidence: 0.96,
            confidenceMargin: 0.4,
            fingerprint: {
              role: "link",
              accessibleName: "Orders",
            },
            strategy: "dom",
          },
        ],
        readiness: [],
        diagnostics: [
          {
            code: "REDUNDANT_INTERACTION",
            severity: "info",
            message:
              "Open menu was unnecessary because desktop partner navigation was already visible.",
            source: fixture.characterization.actualLayout,
          },
        ],
        qualityFindings: [
          {
            code: "REDUNDANT_INTERACTION",
            stepId: "open-menu",
            reason: "expected_effect_already_satisfied",
            visibleNavigation: fixture.characterization.actualVisibleNavigation,
          },
        ],
        learnedContracts: [
          {
            schemaVersion: 1,
            interactionId: "vitract-open-orders",
            stepId: "open-orders",
            intent: { role: "link", accessibleName: "Orders" },
            operation: { type: "activate" },
            functionalResult: "passed",
            mutationOutcome: "applied",
            successfulEvidenceFamilies: ["accessibility", "structural", "effect"],
            scope: { origin: "https://preview.vitract.com" },
            relationships: [{ kind: "navigation", name: "Partner" }],
            capabilityProfile: { activate: true },
            expectedEffect: { type: "navigation", path: "/orders" },
            sanitizedFingerprint: { role: "link", accessibleName: "Orders" },
            qualityFindings: [],
            usedSelectorHint: false,
            unresolvedMutation: false,
            veilPolicyViolated: false,
            veilEvidenceClosed: true,
            expectedEffectVerified: true,
            deterministic: true,
          },
        ],
        protectedAcquisitionEvidence: [
          {
            reference: "clientSecret",
            adapter: "copy_control",
            objective: "verify_user_copy_experience",
            outcome: "copy_experience_verified",
            capsule: "destroyed",
            evidenceClosure: "resumed",
            plaintext: "must-not-persist",
          },
        ],
        pageFingerprint: "c".repeat(64),
        authenticationFingerprint: "d".repeat(64),
      },
    });

    await database.query(
      `INSERT INTO authoring_browser_leases(
         id,
         probe_session_id,
         state,
         runtime_owner_id,
         heartbeat_at,
         expires_at
       )
       VALUES($1,$2,'active','vitract-authoring-runtime',now(),now()+interval '5 minutes')`,
      [lease, probe],
    );

    const authentication = new AuthenticationAuthoringService(
      new AuthenticationAttemptRepository(database),
    );
    const authContext = {
      probeSessionId: probe,
      applicationOrigin: "https://preview.vitract.com",
      entryUrl: fixture.target.url,
      usernameInspection: {
        candidates: [
          {
            target: authTarget("Vitract username field", "1"),
            confidence: 0.94,
            runnerUpMargin: 0.5,
            evidenceKinds: ["autocomplete_username", "type_email", "praxis_verified"],
          },
        ],
      },
      passwordInspection: {
        candidates: [
          {
            target: authTarget("Vitract password field", "2"),
            confidence: 0.95,
            runnerUpMargin: 0.5,
            evidenceKinds: ["type_password", "autocomplete_current_password", "praxis_verified"],
          },
        ],
      },
      submissionInspection: {
        candidates: [
          {
            kind: "native_submit" as const,
            target: authTarget("Vitract sign in", "3"),
            confidence: 0.92,
            evidenceKinds: ["form_relationship", "praxis_verified"],
          },
        ],
      },
      stateInspection: {
        signals: [
          "login_response_success" as const,
          "url_not_login" as const,
          "login_form_absent" as const,
          "authenticated_navigation_present" as const,
          "portal_shell_present" as const,
        ],
      },
    };

    const username = await authentication.discoverUsernameField(authContext);
    const password = await authentication.discoverPasswordField(authContext);
    const submission = await authentication.discoverSubmissionPath(authContext);
    const submissionResult = await authentication.submitCredentialsOnce(authContext);
    const authenticatedState = await authentication.detectAuthenticatedState(authContext);
    const candidate = await authentication.createAuthenticationContractCandidate({
      probeSessionId: probe,
      applicationOrigin: authContext.applicationOrigin,
      entryUrl: authContext.entryUrl,
      username,
      password,
      submission,
      submissionResult,
      authenticatedState,
      safeMetadata: {},
    });

    expect(submissionResult.status).toBe("submitted");
    expect(authenticatedState.status).toBe("authenticated");
    expect(authenticatedState.signals.length).toBeGreaterThanOrEqual(3);

    const authContract = await service.createAuthenticationContract(principal, {
      ...context,
      projectId: project,
      environmentId: vitractEnvironment,
      name: "Vitract partner login",
      applicationOrigin: candidate.applicationOrigin,
      entryUrl: candidate.entryUrl,
      usernameTarget: candidate.usernameTarget,
      passwordTarget: candidate.passwordTarget,
      submissionMethods: candidate.submissionMethods,
      selectedMethodIndex: candidate.selectedMethodIndex,
      success: candidate.success,
      failureSignals: candidate.failureSignals,
      sessionReuse: candidate.sessionReuse,
      idempotencyKey: `auth-contract-vitract-${randomUUID()}`,
    });

    const certifiedCompilation = await service.compileAndCertify(principal, created.id!, {
      ...context,
      environmentId: vitractEnvironment,
      draftVersion: 1,
      probeSessionId: probe,
      authenticationContractRevisionId: authContract.revisionId,
      idempotencyKey: `compile-vitract-${randomUUID()}`,
      viewport: { width: 1280, height: 720 },
      seed: 1,
    });
    const compilation = certifiedCompilation.compilation;

    expect(certifiedCompilation.compiledContractId).toBe(compilation.id);

    expect(compilation).toMatchObject({
      status: "execution_ready",
      diagnostics: [
        {
          code: "REDUNDANT_INTERACTION",
          severity: "info",
          source: fixture.characterization.actualLayout,
        },
      ],
    });
    expect(certifiedCompilation.certification).toMatchObject({
      status: "certification_pending",
    });

    if (!("certificationRunId" in certifiedCompilation.certification)) {
      throw new Error("Certification Run was not queued");
    }
    const certificationRun = certifiedCompilation.certification.certificationRunId;
    const attempts = new RunAttemptRepository(database);
    const claimToken = randomUUID();
    const attempt = await attempts.claimAttempt(
      certificationRun,
      "integration-certification-worker",
      claimToken,
    );
    await attempts.markRunning(certificationRun, attempt!.id, claimToken);
    await stageCertificationEvidence(database, certificationRun, attempt!.id);
    await attempts.markFinalizing(certificationRun, attempt!.id, claimToken);
    await attempts.completeAttempt(certificationRun, attempt!.id, claimToken, "passed", "passed", {
      kind: "required",
    });

    await database.query(
      `INSERT INTO artifact_timeline_entries(
         id,attempt_id,sequence,entry_type,started_at,ended_at,reason_code,metadata
       ) VALUES($1,$2,0,'unavailable_interval',now(),now(),'SCREENCAST_STOP_FAILED',$3::jsonb)`,
      [
        randomUUID(),
        attempt!.id,
        JSON.stringify({
          type: "unavailable_interval",
          failureCode: "SCREENCAST_STOP_FAILED",
        }),
      ],
    );

    await database.query(
      `DELETE FROM artifact_timeline_entries
       WHERE attempt_id=$1 AND entry_type='unavailable_interval'`,
      [attempt!.id],
    );

    const publication = await service.publish(principal, created.id!, {
      ...context,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Vitract authoring transcript certified",
      idempotencyKey: `publish-vitract-${randomUUID()}`,
    });

    expect(publication.replayed).toBe(false);

    const revision = await database.query<{ plan: typeof plan }>(
      `SELECT plan
       FROM flow_revisions
       WHERE id=$1`,
      [publication.revisionId],
    );
    expect(revision.rows[0]!.plan.steps.map((step) => step.id)).toEqual([
      "open-login",
      "open-menu",
      "open-orders",
    ]);

    const compiled = await database.query<{
      compiledContractDigest: string;
      authenticationContractRevisionId: string;
      protectedAcquisitionEvidence: Array<Record<string, unknown>>;
    }>(
      `SELECT
         compiled_contract_digest AS "compiledContractDigest",
         authentication_contract_revision_id AS "authenticationContractRevisionId",
         protected_acquisition_evidence AS "protectedAcquisitionEvidence"
       FROM flow_compilations
       WHERE id=$1`,
      [compilation.id],
    );
    expect(compiled.rows[0]!.protectedAcquisitionEvidence).toEqual([
      {
        reference: "clientSecret",
        adapter: "copy_control",
        objective: "verify_user_copy_experience",
        outcome: "copy_experience_verified",
        capsule: "destroyed",
        evidenceClosure: "resumed",
      },
    ]);
    expect(JSON.stringify(compiled.rows[0]!.protectedAcquisitionEvidence)).not.toContain(
      "must-not-persist",
    );

    const replayRun = await insertPassedRun(database, {
      project,
      mission,
      objective,
      session,
      environment: vitractEnvironment,
      flowRevisionId: publication.revisionId,
      compiledContractId: compilation.id!,
      compiledContractDigest: compiled.rows[0]!.compiledContractDigest,
      plan: revision.rows[0]!.plan,
      idempotencyKey: `fresh-replay-${randomUUID()}`,
      role: "diagnostic",
      rerunOfRunId: certificationRun,
    });

    const counts = await database.query<{
      browserLeases: string;
      authenticationAttempts: string;
      submittedAttempts: string;
      contracts: string;
      passedRuns: string;
      secretArtifacts: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM authoring_browser_leases WHERE probe_session_id=$1)
           AS "browserLeases",
         (SELECT count(*)::text FROM authentication_attempts WHERE probe_session_id=$1)
           AS "authenticationAttempts",
         (SELECT count(*)::text FROM authentication_attempts
          WHERE probe_session_id=$1
            AND dispatch_state='dispatched'
            AND result_classification='submitted')
           AS "submittedAttempts",
         (SELECT count(*)::text FROM authentication_contract_revisions WHERE id=$2)
           AS "contracts",
         (SELECT count(*)::text FROM runs
          WHERE id=ANY($3::uuid[])
            AND state='passed'
            AND result_classification='application_pass'
            AND compiled_contract_id=$4)
           AS "passedRuns",
         (SELECT count(*)::text FROM authentication_attempts
          WHERE probe_session_id=$1
            AND safe_metadata::text ~* '(password|token|clipboard|secret|authorization)')
           AS "secretArtifacts"`,
      [probe, authContract.revisionId, [certificationRun, replayRun], compilation.id],
    );

    expect(counts.rows[0]).toEqual({
      browserLeases: "1",
      authenticationAttempts: "1",
      submittedAttempts: "1",
      contracts: "1",
      passedRuns: "2",
      secretArtifacts: "0",
    });
    expect(compiled.rows[0]!.authenticationContractRevisionId).toBe(authContract.revisionId);
    expect(JSON.stringify(candidate)).not.toMatch(/password=|token=|clipboard|selector|<html/i);
    expect(fixture.characterization.rootCause).toContain("sidebar was already visible");
    expect(fixture.observedOutcome.failureCode).toBe("TARGET_NOT_FOUND");
    expect(replayRun).not.toBe(certificationRun);
  });

  it("opens fresh authoring authority after a policy-failed Run without claiming checkpoint continuity", async () => {
    const recoveryEnvironment = randomUUID();
    const sourceRunId = randomUUID();
    const source = await database.query<{ revisionId: string; plan: unknown }>(
      `SELECT revision.id AS "revisionId",revision.plan
       FROM flow_revisions revision
       JOIN flows flow ON flow.id=revision.flow_id
       WHERE flow.owner_mission_id=$1
       ORDER BY revision.created_at DESC,revision.id DESC
       LIMIT 1`,
      [mission],
    );
    if (!source.rowCount) throw new Error("expected a published source Flow revision");

    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy)
       VALUES($1,$2,'Fresh authority recovery','https://preview.vitract.com',$3::jsonb)`,
      [
        recoveryEnvironment,
        project,
        JSON.stringify({
          allowedOrigins: ["https://preview.vitract.com"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 10,
          maxDurationMs: 120_000,
          maxNavigations: 3,
        }),
      ],
    );
    await database.query(
      `INSERT INTO runs(
         id,project_id,mission_id,objective_id,agent_session_id,environment_id,
         flow_revision_id,state,phase,outcome_classification,result_classification,
         plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,
         execution_snapshot,idempotency_key
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,'failed','completed','policy_failure','application_failure',
         $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13
       )`,
      [
        sourceRunId,
        project,
        mission,
        objective,
        session,
        environment,
        source.rows[0]!.revisionId,
        JSON.stringify(source.rows[0]!.plan),
        JSON.stringify({ id: environment, baseOrigin: "https://preview.vitract.com" }),
        JSON.stringify({
          allowedOrigins: ["https://preview.vitract.com"],
          allowPrivateNetwork: false,
          allowDownloads: false,
          allowPopups: false,
          maxActions: 10,
          maxDurationMs: 120_000,
          maxNavigations: 3,
        }),
        JSON.stringify({ artifactRetention: "sanitized" }),
        JSON.stringify({ executionModel: "agent_directed_v1" }),
        `policy-failed-source-${randomUUID()}`,
      ],
    );

    const plan = currentPlanSchema.parse({
      name: "Consult Developer documentation",
      objective: "Consult Developer documentation with fresh browser authority",
      preconditions: [],
      allowedOrigins: ["https://preview.vitract.com"],
      budgets: { maxActions: 3, maxDurationMs: 30_000, maxNavigations: 2 },
      checkpoints: [],
      steps: [
        {
          id: "open-preview",
          title: "Open Vitract preview",
          action: { type: "navigate", url: "https://preview.vitract.com" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });
    const draftInput = {
      ...context,
      projectId: project,
      environmentId: recoveryEnvironment,
      name: `Policy recovery ${randomUUID()}`,
      description: "Fresh browser authority after a policy refusal",
      content: {
        objective: "Consult Developer documentation",
        preconditions: [],
        expectedOutcomes: ["Developer documentation is observed"],
        prohibitedSideEffects: ["Do not create an order"],
      },
      plan,
    };

    await expect(
      service.createDraft(principal, {
        ...draftInput,
        predecessorRunId: sourceRunId,
        idempotencyKey: `invalid-policy-predecessor-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      response: {
        code: "SUCCESSOR_CHECKPOINT_UNAVAILABLE",
      },
    });

    const draft = await service.createDraft(principal, {
      ...draftInput,
      idempotencyKey: `fresh-policy-authority-${randomUUID()}`,
    });
    const repository = new AdaptiveSessionRepository(database);
    const praxis = await repository.create(null, {
      ...context,
      projectId: project,
      environmentId: recoveryEnvironment,
      flowDraftId: draft.id!,
      objective: "Consult Developer documentation",
      allowedOrigins: ["https://preview.vitract.com"],
      idempotencyKey: `fresh-policy-praxis-${randomUUID()}`,
    });
    await repository.activateProvisionedSession(praxis.id);
    await expect(repository.get(null, praxis.id)).resolves.toMatchObject({ state: "active" });

    const publication = await service.publish(principal, draft.id!, {
      ...context,
      expectedVersion: 1,
      visibility: "mission_local",
      purpose: "primary",
      reason: "Publish the explicit fresh-authority recovery representation",
      idempotencyKey: `publish-policy-recovery-${randomUUID()}`,
    });
    expect(publication).toMatchObject({ replayed: false });
    await expect(
      database.query(
        `SELECT predecessor_run_id AS "predecessorRunId"
         FROM flow_drafts WHERE id=$1`,
        [draft.id],
      ),
    ).resolves.toMatchObject({ rows: [{ predecessorRunId: null }] });
  });
});

async function insertCompletedProbe(
  database: Database,
  input: {
    probeId: string;
    draftId: string;
    mission: string;
    objective: string;
    environment: string;
    session: string;
    draftVersion: number;
    result: Record<string, unknown>;
  },
) {
  await database.query(
    `INSERT INTO probe_sessions(
      id,
      draft_id,
      mission_id,
      objective_id,
      environment_id,
      draft_version,
      level,
      state,
      created_by_agent_session_id,
      idempotency_key,
      result,
      completed_at
    )
    VALUES(
      $1,$2,$3,$4,$5,$6,'inspection','completed',$7,$8,$9::jsonb,now()
    )`,
    [
      input.probeId,
      input.draftId,
      input.mission,
      input.objective,
      input.environment,
      input.draftVersion,
      input.session,
      `probe-${input.probeId}`,
      JSON.stringify(input.result),
    ],
  );
}

function successfulLearnedRecord(suffix: string) {
  return {
    interactionId: `learned-${suffix}`,
    stepId: `step-${suffix}`,
    intent: { concept: suffix },
    operation: { type: "activate" },
    functionalResult: "passed",
    mutationOutcome: "applied",
    successfulEvidenceFamilies: ["accessibility", "effect"],
    scope: { kind: "page" },
    relationships: [],
    capabilityProfile: { canActivate: true },
    expectedEffect: { type: "navigation" },
    sanitizedFingerprint: { digest: "a".repeat(64) },
    qualityFindings: [],
    veilEvidenceClosed: true,
  };
}

type InteractionRole = InteractionTargetIntent["preferredEvidence"]["roles"][number];

function target(concept: string, role: InteractionRole, name: string): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: ["pointer_activatable"],
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: {
      kind: "page",
    },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "read_only",
    confidence: {
      requiredFamilies: [],
      minimum: 0.35,
      minimumMargin: 0,
      minimumFamilyCount: 1,
    },
  };
}

function authTarget(concept: string, suffix: string) {
  return {
    authority: "praxis" as const,
    fingerprint: `${suffix}`.repeat(64).slice(0, 64),
    concept,
    scopeKind: "document",
    capabilityDigest: `${Number(suffix) + 4}`.repeat(64).slice(0, 64),
  };
}

async function completeCertification(
  database: Database,
  certification: { certificationRunId?: string },
) {
  if (!certification.certificationRunId) {
    throw new Error("Certification Run was not queued");
  }
  const attempts = new RunAttemptRepository(database);
  const claimToken = randomUUID();
  const attempt = await attempts.claimAttempt(
    certification.certificationRunId,
    "m1-authoring-certification-worker",
    claimToken,
  );
  if (!attempt) throw new Error("Certification attempt was not claimable");
  await attempts.markRunning(certification.certificationRunId, attempt.id, claimToken);
  await stageCertificationEvidence(database, certification.certificationRunId, attempt.id);
  await attempts.markFinalizing(certification.certificationRunId, attempt.id, claimToken);
  await attempts.completeAttempt(
    certification.certificationRunId,
    attempt.id,
    claimToken,
    "passed",
    "passed",
    { kind: "required" },
  );
}

async function stageCertificationEvidence(database: Database, runId: string, attemptId: string) {
  await database.query(
    `INSERT INTO run_events(attempt_id,sequence,type,payload,occurred_at)
     VALUES($1,1,'action_completed',$2::jsonb,now())`,
    [attemptId, JSON.stringify({ evidence: "certification application outcome observed" })],
  );
  await database.query(
    `INSERT INTO step_results(
       attempt_id,step_id,ordinal,action_status,assertions_summary,evidence,
       started_at,completed_at,duration_ms
     ) VALUES($1,'certification-step',0,'passed',$2::jsonb,$3::jsonb,now(),now(),1)`,
    [
      attemptId,
      JSON.stringify({ passed: 0, failed: 0, unevaluated: 0 }),
      JSON.stringify([{ kind: "application_outcome", status: "observed" }]),
    ],
  );
  await database.query(
    `INSERT INTO run_successor_checkpoints(
       run_id,mission_id,objective_id,flow_revision_id,environment_id,state,
       ciphertext,initialization_vector,authentication_tag,binding_fingerprint,
       restoration_commitment,semantic_commitment,expires_at
     )
     SELECT id,mission_id,objective_id,flow_revision_id,environment_id,'establishing',
            $2,$3,$4,$5,$5,$5,now()+interval '1 hour'
     FROM runs WHERE id=$1`,
    [
      runId,
      Buffer.from("encrypted-checkpoint"),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      "a".repeat(64),
    ],
  );
}

async function insertPassedRun(
  database: Database,
  input: {
    project: string;
    mission: string;
    objective: string;
    session: string;
    environment: string;
    flowRevisionId: string;
    compiledContractId: string;
    compiledContractDigest: string;
    plan: unknown;
    idempotencyKey: string;
    role: "candidate" | "diagnostic";
    rerunOfRunId?: string;
  },
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO runs(
       project_id,
       mission_id,
       objective_id,
       agent_session_id,
       environment_id,
       flow_revision_id,
       compiled_contract_id,
       compiled_contract_digest,
       state,
       phase,
       outcome_classification,
       result_classification,
       plan_snapshot,
       environment_snapshot,
       policy_snapshot,
       veil_policy_snapshot,
       execution_snapshot,
       rerun_of_run_id,
       idempotency_key
     )
     VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,
       'passed',
       'completed',
       'application_pass',
       'application_pass',
       $9::jsonb,
       $10::jsonb,
       $11::jsonb,
       $12::jsonb,
       $13::jsonb,
       $14,
       $15
     )
     RETURNING id`,
    [
      input.project,
      input.mission,
      input.objective,
      input.session,
      input.environment,
      input.flowRevisionId,
      input.compiledContractId,
      input.compiledContractDigest,
      JSON.stringify(input.plan),
      JSON.stringify({
        id: input.environment,
        baseOrigin: "https://preview.vitract.com",
      }),
      JSON.stringify({
        allowedOrigins: ["https://preview.vitract.com"],
        allowPrivateNetwork: false,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 10,
        maxDurationMs: 120_000,
        maxNavigations: 3,
      }),
      JSON.stringify({ artifactRetention: "sanitized" }),
      JSON.stringify({
        browser: "chrome",
        viewport: { width: 1280, height: 720 },
        seed: 8,
      }),
      input.rerunOfRunId ?? null,
      input.idempotencyKey,
    ],
  );

  await database.query(
    `INSERT INTO mission_run_links(
       run_id,
       mission_id,
       objective_id,
       role,
       reason,
       classified_by_agent_session_id
     )
     VALUES($1,$2,$3,$4,'PR8 deterministic validation',$5)`,
    [result.rows[0]!.id, input.mission, input.objective, input.role, input.session],
  );

  return result.rows[0]!.id;
}
