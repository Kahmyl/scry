import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserProtectionDecision } from "@scry/contracts";

import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";

const databaseUrl = process.env.SCRY_BROWSER_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function protectionDecisions(
  effectId: string,
  captureId: string,
  publicOutputs: Record<string, string | number | boolean | null>,
  protectedOutputs: Record<string, string>,
): BrowserProtectionDecision[] {
  return [
    ...Object.entries(publicOutputs).map(([key, value]) => ({
      captureId,
      effectId,
      key,
      path: [key],
      label: "public" as const,
      allowedSinks: ["database_safe_field" as const, "mcp_response" as const],
      valueDigest: digest(value === null ? "null" : String(value)),
      decisionRevision: 1,
      decisionDigest: digest(`public:${captureId}:${key}`),
      reason: "environment_policy:trusted_application_output",
      publicAdmissionMode: "trusted_application_output" as const,
      publicSemantic: "fixturePublic",
      publicEvidenceDigest: digest(`evidence:${captureId}:${key}`),
      publicProposalDigest: digest(`proposal:${captureId}:${key}`),
    })),
    ...Object.entries(protectedOutputs).map(([key, value]) => ({
      captureId,
      effectId,
      key,
      path: [key],
      label: "protected" as const,
      allowedSinks: [],
      valueDigest: digest(value),
      decisionRevision: 1,
      decisionDigest: digest(`protected:${captureId}:${key}`),
      reason: "fixture_protected",
    })),
  ];
}

function capturedResponse(
  effectId: string,
  ownerGeneration: number,
  label: string,
  responseStatus = 201,
) {
  const captureId = randomUUID();
  const encryptedPayload = Buffer.from(`encrypted-${label}`);
  return {
    effectId,
    ownerGeneration,
    captureId,
    evidenceFormat: 1,
    objectKey: `captures/${captureId}`,
    ciphertextDigest: digest(encryptedPayload),
    encryptedPayload,
    encryptedPayloadDigest: digest(encryptedPayload),
    authenticatedMetadata: { label },
    contentClass: "http_json" as const,
    byteSize: encryptedPayload.length,
    structuralIndex: [
      { path: ["resourceId"], kind: "string", classification: "uncertain", length: 8 },
      { path: ["completed"], kind: "boolean", classification: "uncertain" },
      { path: ["clientSecret"], kind: "string", classification: "uncertain", length: 8 },
    ],
    capturedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    responseStatus,
  };
}

run("browser execution baseline repository", () => {
  let database: Database;
  let repository: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;
  let projectId: string;
  let missionId: string;
  let runId: string;
  let sessionId: string;
  let ownerGeneration: number;
  let agentSessionId: string;
  let objectiveId: string;
  let environmentId: string;
  let flowId: string;
  let flowRevisionId: string;
  let primaryEffectId: string;
  let primaryCaptureId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.SCRY_BROWSER_PROTECTED_KEY_BASE64 = randomBytes(32).toString("base64");
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    repository = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);

    const userId = randomUUID();
    const workspaceId = randomUUID();
    projectId = randomUUID();
    missionId = randomUUID();
    agentSessionId = randomUUID();
    objectiveId = randomUUID();
    environmentId = randomUUID();
    flowId = randomUUID();
    flowRevisionId = randomUUID();
    runId = randomUUID();
    sessionId = randomUUID();
    await database.transaction(async (client) => {
      await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
        userId,
        randomUUID(),
        `${userId}@example.test`,
      ]);
      await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)", [
        workspaceId,
        "baseline test",
        `baseline-${workspaceId}`,
      ]);
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await client.query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,$3)", [
        projectId,
        workspaceId,
        `project-${projectId}`,
      ]);
      await client.query(
        "INSERT INTO missions(id,project_id,title,original_instruction,idempotency_key) VALUES($1,$2,'test mission','complete the test','test-mission-1')",
        [missionId, projectId],
      );
      await client.query(
        "INSERT INTO agent_sessions(id,mission_id,project_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,'codex','test','agent-1')",
        [agentSessionId, missionId, projectId],
      );
      await client.query(
        "INSERT INTO mission_objectives(id,mission_id,project_id,title,completion_criteria,objective_order,idempotency_key) VALUES($1,$2,$3,'objective',$4::jsonb,0,'test-objective-1')",
        [objectiveId, missionId, projectId, JSON.stringify({ expected: "done" })],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin,disclosure_mode) VALUES($1,$2,'fixture','https://fixture.example','trusted_application_output')",
        [environmentId, projectId],
      );
      await client.query(
        "INSERT INTO flows(id,project_id,mission_id,created_by_agent_session_id,name,idempotency_key) VALUES($1,$2,$3,$4,'primary','flow-1')",
        [flowId, projectId, missionId, agentSessionId],
      );
      await client.query(
        "INSERT INTO flow_revisions(id,flow_id,mission_id,project_id,revision,state,created_by_agent_session_id,activated_at) VALUES($1,$2,$3,$4,1,'active',$5,now())",
        [flowRevisionId, flowId, missionId, projectId, agentSessionId],
      );
      await client.query(
        `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'run-1')`,
        [
          runId,
          projectId,
          missionId,
          objectiveId,
          agentSessionId,
          flowId,
          flowRevisionId,
          environmentId,
        ],
      );
    });
    await repository.createSession({
      id: sessionId,
      runId,
      projectId,
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      authenticationCommitLimit: 1,
      businessCommitLimit: 3,
      allowedFirstPartyOrigins: ["https://fixture.example"],
      idempotencyKey: "browser-session-1",
    });
    ownerGeneration = (await repository.claimOwner(sessionId, "worker-a", 60_000)).generation;
  });

  afterAll(async () => {
    if (database) await database.onModuleDestroy();
  });

  it("reserves budget exactly once, fences owners, and blocks unresolved redispatch", async () => {
    const input = {
      sessionId,
      ownerGeneration,
      documentEpoch: 0,
      idempotencyKey: "business-effect-1",
      effectClass: "business" as const,
      expectedOrigin: "https://fixture.example",
      targetDigest: digest("target-1"),
      actionDigest: digest("action-1"),
      intentSummary: "create fixture item",
    };
    const admitted = await repository.admitEffect(input);
    expect(admitted.replay).toBe(false);
    expect(
      await repository.recoverAdmittedEffect({
        sessionId,
        idempotencyKey: input.idempotencyKey,
        effectClass: input.effectClass,
        expectedOrigin: input.expectedOrigin,
        intentSummary: input.intentSummary,
      }),
    ).toEqual({ effectId: admitted.effect.id });
    await expect(
      repository.recoverAdmittedEffect({
        sessionId,
        idempotencyKey: input.idempotencyKey,
        effectClass: input.effectClass,
        expectedOrigin: input.expectedOrigin,
        intentSummary: "changed intent",
      }),
    ).rejects.toThrow("SCRY_BROWSER_EFFECT_IDEMPOTENCY_CONFLICT");
    expect((await repository.admitEffect(input)).replay).toBe(true);
    await expect(
      repository.admitEffect({ ...input, idempotencyKey: "business-effect-2" }),
    ).rejects.toThrow("SCRY_BROWSER_EFFECT_UNRESOLVED");
    const budget = await database.query<{ business_commits_used: number }>(
      "SELECT business_commits_used FROM browser_execution_sessions WHERE id=$1",
      [sessionId],
    );
    expect(budget.rows[0]?.business_commits_used).toBe(1);

    await repository.markDispatchStarted(admitted.effect.id, ownerGeneration);
    await expect(
      repository.determine(admitted.effect.id, ownerGeneration, "not_applied", "agent_guess"),
    ).rejects.toThrow("SCRY_BROWSER_NOT_APPLIED_UNPROVEN");
    await expect(
      repository.claimOwner(sessionId, "worker-b", 60_000, "premature recovery"),
    ).rejects.toThrow("SCRY_BROWSER_OWNER_ACTIVE");
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    const replacement = await repository.claimOwner(
      sessionId,
      "worker-b",
      60_000,
      "worker recovery",
    );
    const recoveredCapture = capturedResponse(admitted.effect.id, ownerGeneration, "fenced-owner");
    await expect(repository.registerCapture(recoveredCapture)).rejects.toThrow(
      "SCRY_BROWSER_OWNER_FENCED",
    );
    expect(
      (
        await database.query("SELECT id FROM browser_captures WHERE id=$1", [
          recoveredCapture.captureId,
        ])
      ).rows,
    ).toEqual([]);
    ownerGeneration = replacement.generation;
    expect(await repository.observeEffect(admitted.effect.id)).toMatchObject({
      mutation_outcome: "unknown",
      determination_source: "owner_replaced_after_dispatch",
    });
    expect(
      (await repository.admitEffect({ ...input, ownerGeneration, documentEpoch: 9 })).replay,
    ).toBe(true);
    await repository.registerCapture({ ...recoveredCapture, ownerGeneration });
    const eventsBeforeRepeat = await database.query(
      "SELECT sequence,type,safe_details FROM browser_effect_events WHERE effect_id=$1 ORDER BY sequence",
      [admitted.effect.id],
    );
    await repository.registerCapture({ ...recoveredCapture, ownerGeneration });
    expect(
      (
        await database.query(
          "SELECT sequence,type,safe_details FROM browser_effect_events WHERE effect_id=$1 ORDER BY sequence",
          [admitted.effect.id],
        )
      ).rows,
    ).toEqual(eventsBeforeRepeat.rows);
    await expect(
      repository.registerCapture({
        ...recoveredCapture,
        ownerGeneration,
        ciphertextDigest: digest("conflicting-capture"),
      }),
    ).rejects.toThrow("SCRY_BROWSER_CAPTURE_CONFLICT");
    primaryEffectId = admitted.effect.id;
    primaryCaptureId = recoveredCapture.captureId;
    await expect(repository.assertNoPendingEffectOutcomes(sessionId)).rejects.toThrow(
      `SCRY_BROWSER_EFFECT_OUTCOME_PENDING:${admitted.effect.id}`,
    );
  });

  it("publishes the complete output set atomically without storing plaintext", async () => {
    const effectId = primaryEffectId;
    const captureId = primaryCaptureId;
    await repository.determine(effectId, ownerGeneration, "applied", "validated_response_identity");
    await expect(repository.assertNoPendingEffectOutcomes(sessionId)).resolves.toBeUndefined();
    const publicationPublic = { resourceId: "item-123", completed: true };
    const publicationProtected = { clientSecret: "canary-super-secret-value" };
    const publicationDecisions = protectionDecisions(
      effectId,
      captureId,
      publicationPublic,
      publicationProtected,
    );
    const published = await repository.publishOutputs({
      effectId,
      ownerGeneration,
      captureId,
      selectionDigest: digest("selection-1"),
      publicOutputs: publicationPublic,
      protectedOutputs: publicationProtected,
      decisions: publicationDecisions,
    });
    expect(published.protectedReferences.clientSecret).toMatch(/^[0-9a-f-]{36}$/u);
    const stored = await database.query<{ ciphertext: Buffer; value_digest: string }>(
      "SELECT ciphertext,value_digest FROM protected_values WHERE source_effect_id=$1",
      [effectId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.ciphertext.toString("utf8")).not.toContain("canary-super-secret-value");
    expect(stored.rows[0]!.value_digest).toBe(digest("canary-super-secret-value"));
    const replay = await repository.publishOutputs({
      effectId,
      ownerGeneration,
      captureId,
      selectionDigest: digest("selection-1"),
      publicOutputs: publicationPublic,
      protectedOutputs: publicationProtected,
      decisions: publicationDecisions,
    });
    expect(replay).toEqual(published);
    const recovered = await repository.recoverEffect(effectId);
    expect(recovered).toMatchObject({
      truth: { mutation_outcome: "applied", dispatch_state: "acknowledged" },
      capture: { captureId, phase: "published" },
      publicOutputs: { resourceId: "item-123", completed: true },
      protectedReferences: { clientSecret: published.protectedReferences.clientSecret },
    });

    const disposableCaptureId = randomUUID();
    const encryptedDisposableCapture = Buffer.from("encrypted-disposable-capture");
    await repository.registerCapture({
      effectId,
      ownerGeneration,
      captureId: disposableCaptureId,
      evidenceFormat: 1,
      objectKey: `captures/${disposableCaptureId}`,
      ciphertextDigest: digest(encryptedDisposableCapture),
      encryptedPayload: encryptedDisposableCapture,
      encryptedPayloadDigest: digest(encryptedDisposableCapture),
      authenticatedMetadata: { version: 1 },
      contentClass: "http_json",
      byteSize: 64,
      structuralIndex: [
        { path: ["state"], kind: "string", classification: "uncertain", length: 14 },
      ],
      capturedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await expect(repository.assertCaptureSlotAvailable(effectId, sessionId)).rejects.toThrow(
      `SCRY_BROWSER_CAPTURE_UNSETTLED:${disposableCaptureId}`,
    );
    expect(await repository.unsettledCaptureIds(sessionId)).toContain(disposableCaptureId);
    await expect(repository.finalizeSession(sessionId, ownerGeneration)).rejects.toThrow(
      `SCRY_BROWSER_SESSION_INCOMPLETE:${effectId}`,
    );
    const discardInput = {
      effectId,
      ownerGeneration,
      captureId: disposableCaptureId,
    };
    await repository.discardCapture(discardInput);
    await repository.discardCapture(discardInput);
    expect(Object.values(await commands.protectedValuesForSession(sessionId))).not.toContain(
      "discarded-safe",
    );
    await expect(
      repository.assertCaptureSlotAvailable(effectId, sessionId),
    ).resolves.toBeUndefined();
    const disposed = await database.query<{ state: string; deleted_at: Date | null }>(
      "SELECT state,deleted_at FROM browser_captures WHERE id=$1",
      [disposableCaptureId],
    );
    expect(disposed.rows[0]).toMatchObject({ state: "deleted" });
    expect(disposed.rows[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it("releases a reserved budget slot when a commit is proven not dispatched", async () => {
    const before = await database.query<{ business_commits_used: number }>(
      "SELECT business_commits_used FROM browser_execution_sessions WHERE id=$1",
      [sessionId],
    );
    const input = {
      sessionId,
      ownerGeneration,
      documentEpoch: 1,
      idempotencyKey: "business-effect-pre-dispatch",
      effectClass: "business" as const,
      expectedOrigin: "https://fixture.example",
      targetDigest: digest("target-pre-dispatch"),
      actionDigest: digest("action-pre-dispatch"),
      intentSummary: "attempt a locally rejected fixture action",
    };
    const admitted = await repository.admitEffect(input);
    await repository.determine(
      admitted.effect.id,
      ownerGeneration,
      "not_applied",
      "pre_dispatch_failure",
    );
    const after = await database.query<{ business_commits_used: number }>(
      "SELECT business_commits_used FROM browser_execution_sessions WHERE id=$1",
      [sessionId],
    );
    expect(after.rows[0]?.business_commits_used).toBe(before.rows[0]?.business_commits_used);

    const replacement = await repository.admitEffect({
      ...input,
      idempotencyKey: "business-effect-after-pre-dispatch",
      targetDigest: digest("target-after-pre-dispatch"),
      actionDigest: digest("action-after-pre-dispatch"),
    });
    await repository.markDispatchStarted(replacement.effect.id, ownerGeneration);
    await repository.registerCapture(
      capturedResponse(replacement.effect.id, ownerGeneration, "validated-rejection", 422),
    );
    await repository.determine(
      replacement.effect.id,
      ownerGeneration,
      "not_applied",
      "validated_rejection_body",
    );
    const rejectedCapture = await database.query<{ id: string }>(
      "SELECT id FROM browser_captures WHERE effect_id=$1 AND state='durable'",
      [replacement.effect.id],
    );
    const rejectedCaptureId = rejectedCapture.rows[0]!.id;
    await repository.discardCapture({
      effectId: replacement.effect.id,
      ownerGeneration,
      captureId: rejectedCaptureId,
    });
    const dispatched = await database.query<{ business_commits_used: number }>(
      "SELECT business_commits_used FROM browser_execution_sessions WHERE id=$1",
      [sessionId],
    );
    expect(dispatched.rows[0]?.business_commits_used).toBe(
      (before.rows[0]?.business_commits_used ?? 0) + 1,
    );
  });

  it("turns an interrupted pre-dispatch admission into not-applied and releases its budget", async () => {
    const interruptedRunId = randomUUID();
    const interruptedSessionId = randomUUID();
    await database.query(
      `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        interruptedRunId,
        projectId,
        missionId,
        objectiveId,
        agentSessionId,
        flowId,
        flowRevisionId,
        environmentId,
        `pre-dispatch-crash-${interruptedRunId}`,
      ],
    );
    await repository.createSession({
      id: interruptedSessionId,
      runId: interruptedRunId,
      projectId,
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      authenticationCommitLimit: 0,
      businessCommitLimit: 1,
      allowedFirstPartyOrigins: ["https://fixture.example"],
      idempotencyKey: `pre-dispatch-crash-${interruptedSessionId}`,
    });
    const originalOwner = await repository.claimOwner(
      interruptedSessionId,
      "worker-before-crash",
      60_000,
    );
    const admitted = await repository.admitEffect({
      sessionId: interruptedSessionId,
      ownerGeneration: originalOwner.generation,
      documentEpoch: 0,
      idempotencyKey: "admitted-before-process-loss",
      effectClass: "business",
      expectedOrigin: "https://fixture.example",
      targetDigest: digest("pre-dispatch-target"),
      actionDigest: digest("pre-dispatch-action"),
      intentSummary: "admitted but never dispatched",
    });
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [interruptedSessionId],
    );
    await repository.claimOwner(
      interruptedSessionId,
      "worker-after-crash",
      60_000,
      "process terminated before dispatch",
    );
    expect(await repository.observeEffect(admitted.effect.id)).toMatchObject({
      dispatch_state: "not_started",
      mutation_outcome: "not_applied",
      determination_source: "owner_replaced_before_dispatch",
    });
    const budget = await database.query<{ business_commits_used: number }>(
      "SELECT business_commits_used FROM browser_execution_sessions WHERE id=$1",
      [interruptedSessionId],
    );
    expect(budget.rows[0]?.business_commits_used).toBe(0);
  });

  it("preserves UNKNOWN and refuses finalization without complete evidence", async () => {
    const admitted = await repository.admitEffect({
      sessionId,
      ownerGeneration,
      documentEpoch: 1,
      idempotencyKey: "business-effect-unknown",
      effectClass: "business",
      expectedOrigin: "https://fixture.example",
      targetDigest: digest("target-unknown"),
      actionDigest: digest("action-unknown"),
      intentSummary: "submit asynchronous fixture",
    });
    await repository.markDispatchStarted(admitted.effect.id, ownerGeneration);
    await repository.markUnknown(
      admitted.effect.id,
      ownerGeneration,
      "response_lost_after_dispatch",
    );
    await expect(repository.finalizeSession(sessionId, ownerGeneration)).rejects.toThrow(
      "SCRY_BROWSER_SESSION_INCOMPLETE",
    );
    await expect(
      repository.admitEffect({
        sessionId,
        ownerGeneration,
        documentEpoch: 1,
        idempotencyKey: "business-effect-replay-forbidden",
        effectClass: "business",
        expectedOrigin: "https://fixture.example",
        targetDigest: digest("target-unknown-2"),
        actionDigest: digest("action-unknown-2"),
        intentSummary: "do not replay unknown mutation",
      }),
    ).rejects.toThrow("SCRY_BROWSER_EFFECT_UNRESOLVED");
  });

  it("permits evidence-backed failure finalization while preserving UNKNOWN", async () => {
    const unknown = await database.query<{ id: string }>(
      "SELECT id FROM browser_effects WHERE session_id=$1 AND mutation_outcome='unknown' ORDER BY effect_ordinal DESC LIMIT 1",
      [sessionId],
    );
    expect(unknown.rows[0]).toBeDefined();
    await repository.prepareFailureFinalization(sessionId, ownerGeneration);
    await database.query(
      `INSERT INTO browser_evidence_streams(id,session_id,run_id,state,chain_head,chunk_count,total_bytes,replay_artifact_key,retention_expires_at,completed_at)
       VALUES($1,$2,$3,'complete',$4,1,64,'local://failure-evidence',now()+interval '30 days',now())`,
      [randomUUID(), sessionId, runId, digest("failure-evidence-chain")],
    );
    await repository.finalizeFailedSession(sessionId, ownerGeneration);
    expect(await repository.observeEffect(unknown.rows[0]!.id)).toMatchObject({
      mutation_outcome: "unknown",
    });
    const stored = await database.query<{ state: string }>(
      "SELECT state FROM browser_execution_sessions WHERE id=$1",
      [sessionId],
    );
    expect(stored.rows[0]?.state).toBe("completed");
  });

  it("survives 100 seeded admission and owner-recovery contention repetitions", async () => {
    const campaignId = randomUUID();
    for (let seed = 0; seed < 100; seed += 1) {
      const repeatedRunId = randomUUID();
      const repeatedSessionId = randomUUID();
      await database.query(
        `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          repeatedRunId,
          projectId,
          missionId,
          objectiveId,
          agentSessionId,
          flowId,
          flowRevisionId,
          environmentId,
          `contention-run-${seed}`,
        ],
      );
      await repository.createSession({
        id: repeatedSessionId,
        runId: repeatedRunId,
        projectId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        authenticationCommitLimit: 0,
        businessCommitLimit: 1,
        allowedFirstPartyOrigins: ["https://fixture.example"],
        idempotencyKey: `contention-session-${seed}`,
      });
      const firstOwner = await repository.claimOwner(
        repeatedSessionId,
        `worker-initial-${seed}`,
        60_000,
      );
      const proposed = {
        sessionId: repeatedSessionId,
        ownerGeneration: firstOwner.generation,
        documentEpoch: seed,
        idempotencyKey: `effect-${seed}`,
        effectClass: "business" as const,
        expectedOrigin: "https://fixture.example",
        targetDigest: digest(`target-${seed}`),
        actionDigest: digest(`action-${seed}`),
        intentSummary: `create seeded item ${seed}`,
      };
      const admissions = await Promise.all(
        Array.from({ length: 8 }, () => repository.admitEffect(proposed)),
      );
      expect(admissions.filter(({ replay }) => !replay)).toHaveLength(1);
      const effectId = admissions[0]!.effect.id;
      await repository.markDispatchStarted(effectId, firstOwner.generation);
      await database.query(
        "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
        [repeatedSessionId],
      );
      const ownerRace = await Promise.allSettled([
        repository.claimOwner(
          repeatedSessionId,
          `worker-recovery-a-${seed}`,
          60_000,
          "seeded recovery",
        ),
        repository.claimOwner(
          repeatedSessionId,
          `worker-recovery-b-${seed}`,
          60_000,
          "seeded recovery",
        ),
      ]);
      const winners = ownerRace.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<BrowserExecutionRepository["claimOwner"]>>
        > => result.status === "fulfilled",
      );
      expect(winners).toHaveLength(1);
      const recoveredOwner = winners[0]!.value;
      expect(
        (
          await repository.admitEffect({
            ...proposed,
            ownerGeneration: recoveredOwner.generation,
            documentEpoch: seed + 1,
          })
        ).replay,
      ).toBe(true);
      const captureId = randomUUID();
      const encryptedPayload = Buffer.from(`ciphertext-${seed}`);
      await repository.registerCapture({
        effectId,
        ownerGeneration: recoveredOwner.generation,
        captureId,
        evidenceFormat: 1,
        objectKey: `captures/${campaignId}/seed-${seed}`,
        ciphertextDigest: digest(encryptedPayload),
        encryptedPayload,
        encryptedPayloadDigest: digest(encryptedPayload),
        responseStatus: 201,
        authenticatedMetadata: { seed },
        contentClass: "http_json",
        byteSize: 64,
        structuralIndex: [{ path: ["resourceId"], classification: "uncertain" }],
        capturedAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      await repository.determine(
        effectId,
        recoveredOwner.generation,
        "applied",
        "seeded_owned_response",
      );
      await repository.publishOutputs({
        effectId,
        ownerGeneration: recoveredOwner.generation,
        captureId,
        selectionDigest: digest(`selection-${seed}`),
        publicOutputs: { resourceId: `item-${seed}` },
        protectedOutputs: {},
        decisions: protectionDecisions(effectId, captureId, { resourceId: `item-${seed}` }, {}),
      });
      expect(await repository.recoverEffect(effectId)).toMatchObject({
        truth: { mutation_outcome: "applied" },
        capture: { captureId, phase: "published" },
        publicOutputs: { resourceId: `item-${seed}` },
      });
    }
  }, 60_000);

  it("refuses an incompatible worker capability at the database boundary", async () => {
    await expect(
      database.query(
        "UPDATE schema_baseline SET runtime_capability_id='incompatible-browser-worker' WHERE singleton=true",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(repository.assertCompatibleBaseline()).resolves.toBeUndefined();
  });
});
