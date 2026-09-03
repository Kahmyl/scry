import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startQ3Fixture,
  type Q3Fixture,
} from "../../../packages/assurance/src/architecture/q3/fixture.js";
import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { Database } from "../src/infrastructure/index.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";
import { ProtectedOperationRepository } from "../src/runtime/repositories/protected-operation.repository.js";
import { RunAttemptRepository } from "../src/runtime/repositories/run-attempt.repository.js";

const databaseUrl = process.env.SCRY_M6_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const ownerScript = fileURLToPath(new URL("../scripts/m6-process-owner.ts", import.meta.url));
const fixturePassword = "m6-process-protected-8Kp4";
type OwnerInput = {
  runId?: string;
  operationId?: string;
  mutationIdentity?: string;
  fixtureOrigin?: string;
  adaptiveSessionId?: string;
};

integration("M6 actual process-loss qualification", () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const flowDraftId = randomUUID();
  const adaptiveSessionId = randomUUID();
  const reconciliationSessionId = randomUUID();
  const protectedAuthorizationId = randomUUID();
  const principal = {
    kind: "user" as const,
    subject: userId,
    userId,
    email: "m6-process@example.test",
    workspaceId,
    role: "owner" as const,
  };
  let database: Database;
  let campaigns: QualificationCampaignRepository;
  let sessions: AdaptiveSessionRepository;
  let attempts: RunAttemptRepository;
  let protectedOperations: ProtectedOperationRepository;
  let fixture: Q3Fixture;
  const processEvidence: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    fixture = await startQ3Fixture({
      seed: 6400,
      mode: "NORMAL",
      evidenceMode: "REQUIRED_AVAILABLE",
      username: "m6-local-user",
      password: fixturePassword,
    });
    database = new Database();
    campaigns = new QualificationCampaignRepository(database);
    sessions = new AdaptiveSessionRepository(database);
    attempts = new RunAttemptRepository(database);
    protectedOperations = new ProtectedOperationRepository(database);
    await seedScope();
  });

  afterAll(async () => {
    await fixture?.close();
    await database?.onModuleDestroy();
  });

  it("kills real owners across P1-P8 and preserves conservative campaign truth", async () => {
    const p1 = await boundedRun("p1");
    processEvidence.push(await killAt("before_consumption", p1));
    expect(await consumed(p1.campaignId)).toBe(0);
    await campaigns.settleRun(p1.runId, "inconclusive");
    await attachDurableEvidence(processEvidence.at(-1)!, p1);

    const p2 = await boundedRun("p2");
    processEvidence.push(await killAt("after_consumption", p2));
    expect(await consumed(p2.campaignId)).toBe(1);
    await campaigns.settleMutation(p2.runId, p2.operationId, "unknown");
    await expect(secondMutation(p2)).rejects.toMatchObject({
      response: { code: "QUALIFICATION_MUTATION_CAPABILITY_CONSUMED" },
    });
    await attachDurableEvidence(processEvidence.at(-1)!, p2);

    const delayed = await replaceFixture("DELAYED_ACK", 5_000, 6403);
    const p3 = await boundedRun("p3");
    const initiated = startOwner("request_initiated", p3);
    const marker = await markerFrom(initiated);
    await waitFor(() => delayed.readGroundTruth().mutationRequests.length === 1);
    await killOwner(initiated);
    processEvidence.push(marker);
    expect(delayed.readGroundTruth().resources).toHaveLength(1);
    await campaigns.settleMutation(p3.runId, p3.operationId, "unknown");
    expect((await campaigns.get(principal, p3.campaignId)).disposition).toBe("inconclusive");
    await attachDurableEvidence(processEvidence.at(-1)!, p3);

    const dropped = await replaceFixture("DROP_ACK_AFTER_COMMIT", undefined, 6404);
    const p4 = await boundedRun("p4");
    processEvidence.push(await killAt("after_external_commit", p4));
    expect(dropped.readGroundTruth().resources).toHaveLength(1);
    await campaigns.settleMutation(p4.runId, p4.operationId, "unknown");
    await attachDurableEvidence(processEvidence.at(-1)!, p4);

    const normal = await replaceFixture("NORMAL", undefined, 6405);
    const p5 = await boundedRun("p5");
    processEvidence.push(await killAt("after_verification", p5));
    expect(normal.readGroundTruth().resources).toHaveLength(1);
    expect(normal.readGroundTruth().mutationRequests).toHaveLength(1);
    await campaigns.settleMutation(p5.runId, p5.operationId, "unknown");
    await attachDurableEvidence(processEvidence.at(-1)!, p5);

    const p6 = await boundedRun("p6");
    processEvidence.push(await killAt("after_settlement", p6));
    expect(await mutationOutcome(p6.campaignId)).toBe("applied");
    expect(
      normal
        .readGroundTruth()
        .resources.some(({ idempotencyKey }) => idempotencyKey === p6.mutationIdentity),
    ).toBe(true);
    await expect(secondMutation(p6)).rejects.toMatchObject({
      response: { code: "QUALIFICATION_MUTATION_CAPABILITY_CONSUMED" },
    });
    await campaigns.settleRun(p6.runId, "inconclusive");
    await attachDurableEvidence(processEvidence.at(-1)!, p6);

    const p7 = await boundedRun("p7");
    processEvidence.push(await killAt("after_verification", p7));
    expect(
      normal
        .readGroundTruth()
        .resources.some((resource) => resource.idempotencyKey === p7.mutationIdentity),
    ).toBe(true);
    await campaigns.settleMutation(p7.runId, p7.operationId, "unknown");
    await attachDurableEvidence(processEvidence.at(-1)!, p7);

    const p8 = await boundedRun("p8");
    processEvidence.push(await killAt("run_finalization", p8));
    expect((await campaigns.get(principal, p8.campaignId)).disposition).toBe("succeeded");
    await attachDurableEvidence(processEvidence.at(-1)!, p8);

    expect(new Set(processEvidence.map(({ pid }) => pid)).size).toBe(processEvidence.length);
    expect(processEvidence.every(({ pid }) => Number(pid) > 0)).toBe(true);
  }, 60_000);

  it("kills real browser/runtime/agent owners and rejects retained stale authority", async () => {
    await database.query(
      `UPDATE adaptive_sessions SET allowed_origins=$2::jsonb
        WHERE id=ANY($1::uuid[])`,
      [[adaptiveSessionId, reconciliationSessionId], JSON.stringify([fixture.origin])],
    );
    const browser = startOwner("browser_owner", { fixtureOrigin: fixture.origin });
    const browserMarker = await markerFrom(browser);
    await killOwner(browser);
    processEvidence.push(browserMarker);
    expect(browserMarker.pid).toBeGreaterThan(0);

    const lease = startOwner("runtime_lease_owner", { adaptiveSessionId });
    const leaseMarker = (await markerFrom(lease)) as {
      phase: string;
      pid: number;
      ownerId: string;
      fencingToken: number;
    };
    await killOwner(lease);
    processEvidence.push(leaseMarker);
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(
      await sessions.releaseRuntimeLease({
        sessionId: adaptiveSessionId,
        ownerId: leaseMarker.ownerId,
        fencingToken: leaseMarker.fencingToken,
      }),
    ).toBe(false);
    const replacementOwnerId = randomUUID();
    const replacement = await sessions.claimRuntimeLease({
      sessionId: adaptiveSessionId,
      ownerId: replacementOwnerId,
      leaseDurationMs: 5_000,
    });
    expect(replacement.fencingToken).toBeGreaterThan(leaseMarker.fencingToken);
    expect(
      await sessions.releaseRuntimeLease({
        sessionId: adaptiveSessionId,
        ownerId: leaseMarker.ownerId,
        fencingToken: leaseMarker.fencingToken,
      }),
    ).toBe(false);
    await expect(
      sessions.heartbeatRuntimeLease({
        sessionId: adaptiveSessionId,
        ownerId: leaseMarker.ownerId,
        fencingToken: leaseMarker.fencingToken,
        leaseDurationMs: 1_000,
      }),
    ).rejects.toMatchObject({ response: { code: "ADAPTIVE_SESSION_RUNTIME_LEASE_LOST" } });
    expect(
      await sessions.releaseRuntimeLease({
        sessionId: adaptiveSessionId,
        ownerId: replacementOwnerId,
        fencingToken: replacement.fencingToken,
      }),
    ).toBe(true);

    const convergedOwner = startOwner("runtime_lease_owner", { adaptiveSessionId });
    const convergedMarker = (await markerFrom(convergedOwner)) as {
      phase: string;
      pid: number;
      ownerId: string;
      fencingToken: number;
    };
    await killOwner(convergedOwner);
    processEvidence.push(convergedMarker);
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(
      await sessions.releaseRuntimeLease({
        sessionId: adaptiveSessionId,
        ownerId: convergedMarker.ownerId,
        fencingToken: convergedMarker.fencingToken,
      }),
    ).toBe(false);
    expect(await sessions.convergeExpiredRuntimeOwners()).toContain(adaptiveSessionId);
    const converged = await database.query<{ state: string; liveLease: boolean }>(
      `SELECT session.state,lease.lease_expires_at>now() AS "liveLease"
         FROM adaptive_sessions session
         JOIN adaptive_session_runtime_leases lease ON lease.session_id=session.id
        WHERE session.id=$1`,
      [adaptiveSessionId],
    );
    expect(converged.rows[0]).toMatchObject({ state: "failed", liveLease: false });

    const agent = startOwner("agent_owner", { adaptiveSessionId: agentSessionId });
    const agentMarker = await markerFrom(agent);
    await killOwner(agent);
    processEvidence.push(agentMarker);
    expect(agentMarker.pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 850));
    const expired = await database.query<{ expired: boolean }>(
      `SELECT lease_expires_at<=now() AS expired FROM agent_sessions WHERE id=$1`,
      [agentSessionId],
    );
    expect(expired.rows[0]!.expired).toBe(true);

    const staleAttemptRun = await boundedRun("stale-attempt");
    const attemptOwner = startOwner("run_attempt_owner", staleAttemptRun);
    const attemptMarker = (await markerFrom(attemptOwner)) as {
      phase: string;
      pid: number;
      attemptId: string;
      claimToken: string;
    };
    await killOwner(attemptOwner);
    processEvidence.push(attemptMarker);
    expect(await attempts.recoverStaleAttempts(new Date(Date.now() + 1_000))).toContain(
      staleAttemptRun.runId,
    );
    expect(await attempts.heartbeat(attemptMarker.attemptId, attemptMarker.claimToken)).toBe(false);
    await expect(
      attempts.completeAttempt(
        staleAttemptRun.runId,
        attemptMarker.attemptId,
        attemptMarker.claimToken,
        "failed",
        "infrastructure_failure",
        { kind: "forbidden", reason: "run_not_successful" },
      ),
    ).rejects.toMatchObject({ response: { message: "Attempt claim was lost" } });
    const replacementAttempt = await attempts.claimAttempt(
      staleAttemptRun.runId,
      "m6-replacement-worker",
      randomUUID(),
    );
    expect(replacementAttempt?.attemptNumber).toBe(2);
    await attempts.failAttempt(
      staleAttemptRun.runId,
      replacementAttempt!.id,
      replacementAttempt!.claimToken,
      "M6_PROCESS_OWNER_LOST",
      false,
    );
    expect((await campaigns.get(principal, staleAttemptRun.campaignId)).disposition).toBe(
      "inconclusive",
    );

    const reconciliationOperationId = `m6-reconciliation-${randomUUID()}`;
    await prepareUnknownOperation(reconciliationOperationId);
    const reconciliationOwner = startOwner("reconciliation_owner", {
      adaptiveSessionId: reconciliationSessionId,
      operationId: reconciliationOperationId,
      mutationIdentity: `m6-reconciliation-owner-${randomUUID()}`,
    });
    const reconciliationMarker = (await markerFrom(reconciliationOwner)) as {
      phase: string;
      pid: number;
      reconciliationId: string;
      fencingToken: number;
      idempotencyKey: string;
    };
    await killOwner(reconciliationOwner);
    processEvidence.push(reconciliationMarker);
    await new Promise((resolve) => setTimeout(resolve, 850));
    const replacementReconciliationKey = `m6-reconciliation-replacement-${randomUUID()}`;
    const replacementReconciliation = await sessions.beginUnknownReconciliation({
      workspaceId,
      sessionId: reconciliationSessionId,
      missionId,
      operationId: reconciliationOperationId,
      idempotencyKey: replacementReconciliationKey,
    });
    await expect(
      sessions.completeUnknownReconciliation({
        sessionId: reconciliationSessionId,
        missionId,
        operationId: reconciliationOperationId,
        idempotencyKey: reconciliationMarker.idempotencyKey,
        reconciliationId: reconciliationMarker.reconciliationId,
        fencingToken: reconciliationMarker.fencingToken,
        result: "proven_not_applied",
        reasonCode: "M6_STALE_RECONCILIATION_OWNER",
        evidence: { staleOwner: true },
        runtimeOwned: false,
      }),
    ).rejects.toMatchObject({ response: { code: "UNKNOWN_RECONCILIATION_FENCE_LOST" } });
    await sessions.completeUnknownReconciliation({
      sessionId: reconciliationSessionId,
      missionId,
      operationId: reconciliationOperationId,
      idempotencyKey: replacementReconciliationKey,
      reconciliationId: replacementReconciliation.id!,
      fencingToken: replacementReconciliation.fencingToken!,
      result: "still_unknown",
      reasonCode: "M6_OBSERVATION_REMAINS_AMBIGUOUS",
      evidence: { observationOnly: true },
      runtimeOwned: false,
    });

    const protectedOperationId = `m6-protected-${randomUUID()}`;
    const protectedMutationIdentity = `m6-protected-mutation-${randomUUID()}`;
    await protectedOperations.create({
      ownerKind: "authoring_session",
      ownerId: reconciliationSessionId,
      flowDraftId,
      authorizationId: protectedAuthorizationId,
      operationId: protectedOperationId,
      mutationIdentity: protectedMutationIdentity,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      programDigest: "a".repeat(64),
      safeOutputManifest: [],
    });
    const protectedOwner = startOwner("protected_operation_owner", {
      adaptiveSessionId: reconciliationSessionId,
      operationId: protectedOperationId,
      mutationIdentity: protectedMutationIdentity,
    });
    const protectedMarker = (await markerFrom(protectedOwner)) as {
      phase: string;
      pid: number;
      protectedOperationId: string;
      leaseOwner: string;
      fencingToken: number;
    };
    await killOwner(protectedOwner);
    processEvidence.push(protectedMarker);
    await new Promise((resolve) => setTimeout(resolve, 850));
    const replacementProtected = await protectedOperations.claim({
      ownerKind: "authoring_session",
      ownerId: reconciliationSessionId,
      operationId: protectedOperationId,
      leaseOwner: "m6-protected-replacement",
      leaseDurationMs: 5_000,
      binding: protectedBinding(protectedMutationIdentity),
    });
    expect(replacementProtected).toMatchObject({
      state: "recovery_required",
      mutationOutcome: "unknown",
    });
    await expect(
      protectedOperations.heartbeat({
        id: protectedMarker.protectedOperationId,
        leaseOwner: protectedMarker.leaseOwner,
        fencingToken: protectedMarker.fencingToken,
        leaseDurationMs: 1_000,
      }),
    ).rejects.toThrow("PROTECTED_OPERATION_FENCED");
    await database.query(
      `UPDATE protected_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [replacementProtected.id],
    );

    const output = path.resolve(apiRoot, "../../artifacts/system-correctness/m6");
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, "q4-process-evidence.json"),
      `${JSON.stringify(
        {
          evidenceVersion: 1,
          processDeathMechanism: "detached OS process group SIGKILL",
          processes: processEvidence,
          protectedValuesIncluded: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }, 30_000);

  async function replaceFixture(
    mode: "NORMAL" | "DELAYED_ACK" | "DROP_ACK_AFTER_COMMIT",
    acknowledgementDelayMs: number | undefined,
    seed: number,
  ) {
    await fixture.close();
    fixture = await startQ3Fixture({
      seed,
      mode,
      evidenceMode: "REQUIRED_AVAILABLE",
      username: "m6-local-user",
      password: fixturePassword,
      ...(acknowledgementDelayMs ? { acknowledgementDelayMs } : {}),
    });
    await database.query(`UPDATE environments SET base_origin=$2,policy=$3::jsonb WHERE id=$1`, [
      environmentId,
      fixture.origin,
      JSON.stringify(policy(fixture.origin)),
    ]);
    return fixture;
  }

  async function attachDurableEvidence(
    evidence: Record<string, unknown>,
    input: Awaited<ReturnType<typeof boundedRun>>,
  ) {
    const oracle = fixture.readGroundTruth();
    const campaign = await campaigns.get(principal, input.campaignId);
    evidence.oracle = {
      requests: oracle.mutationRequests.filter(
        ({ idempotencyKey }) => idempotencyKey === input.mutationIdentity,
      ).length,
      effects: oracle.resources.filter(
        ({ idempotencyKey }) => idempotencyKey === input.mutationIdentity,
      ).length,
      resourceIds: oracle.resources
        .filter(({ idempotencyKey }) => idempotencyKey === input.mutationIdentity)
        .map(({ id }) => id),
      idempotencyKey: input.mutationIdentity,
    };
    evidence.scry = {
      campaignDisposition: campaign.disposition,
      runsConsumed: campaign.runsConsumed,
      mutationsConsumed: campaign.businessMutationDispatchesConsumed,
      mutationOutcome:
        campaign.businessMutationDispatchesConsumed > 0
          ? await mutationOutcome(input.campaignId)
          : "not_applied",
    };
  }

  async function prepareUnknownOperation(operationId: string) {
    const ownerId = randomUUID();
    const lease = await sessions.claimRuntimeLease({
      sessionId: reconciliationSessionId,
      ownerId,
      leaseDurationMs: 5_000,
    });
    await sessions.beginOperation(workspaceId, reconciliationSessionId, {
      operationId,
      idempotencyKey: `${operationId}-key`,
      action: {
        type: "click",
        target: {
          concept: "local resource mutation",
          requiredCapabilities: ["pointer_activatable"],
          preferredEvidence: {
            roles: ["button"],
            names: ["Create resource"],
            labels: [],
            descriptions: [],
            placeholders: [],
            inputTypes: [],
            testIds: [],
          },
          scope: { kind: "page" },
          relations: [],
          prohibited: ["hidden", "disabled"],
          risk: "ordinary",
          confidence: { requiredFamilies: [] },
          matching: "exact",
        },
        expectedEffect: { type: "none" },
        timeoutMs: 10_000,
      },
      expectedEffect: { type: "none" },
      mode: "transact",
      protectedInputReferences: [],
    });
    await sessions.markOperationDispatching({
      sessionId: reconciliationSessionId,
      operationId,
      ownerId,
      fencingToken: lease.fencingToken,
    });
    await sessions.settleOperation({
      sessionId: reconciliationSessionId,
      operationId,
      capabilityManifestDigest: "b".repeat(64),
      outcome: {
        operationId,
        functionalResult: "failed",
        mutationOutcome: "unknown",
        privacyResult: "verified",
        evidenceResult: [],
        qualityFindings: [],
        durationMs: 1,
        reasonCode: "M6_PROCESS_OWNER_LOST",
      },
      decisionBoundary: {
        type: "mutation_reconciliation_required",
        reasonCode: "MUTATION_OUTCOME_UNKNOWN",
        safeActions: ["get_flow_authoring"],
      },
    });
    await sessions.releaseRuntimeLease({
      sessionId: reconciliationSessionId,
      ownerId,
      fencingToken: lease.fencingToken,
    });
  }

  function protectedBinding(mutationIdentity: string) {
    return {
      mutationIdentity,
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      programDigest: "a".repeat(64),
      flowDraftId,
      authorizationId: protectedAuthorizationId,
      safeOutputManifest: [],
    };
  }

  async function boundedRun(label: string) {
    const campaign = await campaigns.create(principal, projectId, {
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      purpose: "system_correctness",
      targetOrigin: fixture.origin,
      applicationIdentity: "q3-local-resource-fixture",
      qualificationMode: "local_test",
      releaseIdentity: "c".repeat(64),
      schemaIdentity: "15b258b1b7c1f6d446d2addaab7e25f5c0e111dba3a87210679d9aea50e03237",
      maxRuns: 1,
      maxBusinessMutationDispatches: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const runId = await database.transaction(async (client) => {
      const bound = await campaigns.consumeRun(client, {
        campaignId: campaign.id,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
      });
      const id = randomUUID();
      await client.query(
        `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,execution_snapshot,idempotency_key,qualification_campaign_authorization_id) VALUES($1,$2,$3,$4,$5,$6,$7,'running','executing_action','{}','{}','{}',$8::jsonb,'{}',$9,$10)`,
        [
          id,
          projectId,
          missionId,
          objectiveId,
          agentSessionId,
          environmentId,
          flowRevisionId,
          JSON.stringify({ schemaVersion: 1, digest: "d".repeat(64) }),
          `m6-${label}-${id}`,
          bound,
        ],
      );
      return id;
    });
    return {
      campaignId: campaign.id,
      runId,
      operationId: `m6-${label}`,
      mutationIdentity: `m6-key-${label}-${randomUUID()}`,
      fixtureOrigin: fixture.origin,
    };
  }

  function startOwner(mode: string, input: OwnerInput) {
    return spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        ownerScript,
        mode,
        input.runId ?? "-",
        input.operationId ?? "-",
        input.mutationIdentity ?? "-",
        input.fixtureOrigin ?? fixture.origin,
        input.adaptiveSessionId ?? "-",
      ],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl!,
          M6_FIXTURE_PASSWORD: fixturePassword,
          M6_WORKSPACE_ID: workspaceId,
          M6_PROJECT_ID: projectId,
          M6_ENVIRONMENT_ID: environmentId,
          M6_MISSION_ID: missionId,
          M6_OBJECTIVE_ID: objectiveId,
          M6_AGENT_SESSION_ID: agentSessionId,
          M6_FLOW_DRAFT_ID: flowDraftId,
          M6_PROTECTED_AUTHORIZATION_ID: protectedAuthorizationId,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  async function killAt(mode: string, input: Awaited<ReturnType<typeof boundedRun>>) {
    const child = startOwner(mode, input);
    const marker = await markerFrom(child);
    await killOwner(child);
    return marker;
  }

  async function markerFrom(child: ChildProcess): Promise<{ phase: string; pid: number }> {
    let buffer = "";
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`M6_OWNER_MARKER_TIMEOUT:${buffer.slice(-2_000)}`)),
        30_000,
      );
      child.stderr!.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      child.stdout!.on("data", (chunk) => {
        const line = chunk
          .toString()
          .trim()
          .split("\n")
          .find((value: string) => value.startsWith("{"));
        if (!line) return;
        clearTimeout(timeout);
        resolve(JSON.parse(line));
      });
      child.once("exit", (code) => {
        if (code && code !== 137) reject(new Error(`M6_OWNER_EXIT_${code}:${buffer}`));
      });
    });
  }

  async function killOwner(child: ChildProcess) {
    const descendants = child.pid ? descendantPids(child.pid) : [];
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    await once(child, "exit");
    for (const pid of descendants.reverse()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  function descendantPids(rootPid: number) {
    const children = new Map<number, number[]>();
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).split(
      "\n",
    )) {
      const [pidText, parentText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const found: number[] = [];
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length) {
      const pid = pending.shift()!;
      found.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return found;
  }

  async function consumed(campaignId: string) {
    return count(
      `SELECT business_mutation_dispatches_consumed::int count FROM qualification_campaign_authorizations WHERE id=$1`,
      [campaignId],
    );
  }
  async function mutationOutcome(campaignId: string) {
    const result = await database.query<{ mutationOutcome: string }>(
      `SELECT mutation_outcome AS "mutationOutcome" FROM qualification_campaign_mutation_consumptions WHERE campaign_authorization_id=$1`,
      [campaignId],
    );
    return result.rows[0]!.mutationOutcome;
  }
  function secondMutation(input: Awaited<ReturnType<typeof boundedRun>>) {
    return campaigns.consumeBusinessMutation({
      runId: input.runId,
      operationId: `${input.operationId}-second`,
      mutationIdentity: `${input.mutationIdentity}-second`,
    });
  }
  async function count(sql: string, values: unknown[]) {
    const result = await database.query<{ count: number }>(sql, values);
    return Number(result.rows[0]!.count);
  }
  async function waitFor(check: () => boolean) {
    for (let index = 0; index < 200; index += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("M6_ORACLE_WAIT_TIMEOUT");
  }

  async function seedScope() {
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'M6 process',$2)`, [
      workspaceId,
      `m6-process-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'M6 process')`, [
      projectId,
      workspaceId,
    ]);
    await database.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,'M6 local',$3,$4::jsonb)`,
      [environmentId, projectId, fixture.origin, JSON.stringify(policy(fixture.origin))],
    );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status) VALUES($1,$2,'M6 process','One local mutation','running')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order) VALUES($1,$2,'One mutation','[]',0)`,
      [objectiveId, missionId],
    );
    await database.query(
      `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key,project_id,workspace_id) VALUES($1,$2,'deterministic_process','Repository-blind owner',$3,$4,$5)`,
      [agentSessionId, missionId, `m6-process-agent-${agentSessionId}`, projectId, workspaceId],
    );
    await database.transaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO flows(id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id) VALUES($1,$2,'M6 Process Flow',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
        [flowId, projectId, flowRevisionId, missionId, objectiveId, agentSessionId],
      );
      await client.query(
        `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,1,'{}','{}','{}',$3,'M6 process')`,
        [flowRevisionId, flowId, agentSessionId],
      );
    });
    await database.query(
      `INSERT INTO flow_drafts(id,project_id,mission_id,objective_id,environment_id,name,content,plan,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,'M6 process draft','{}','{}',$6)`,
      [flowDraftId, projectId, missionId, objectiveId, environmentId, agentSessionId],
    );
    await database.query(
      `INSERT INTO adaptive_sessions(id,project_id,environment_id,correlation_id,state,objective,allowed_origins,mission_id,objective_id,flow_draft_id,active_objective_id,active_flow_draft_id,idempotency_key,authoring_turn_budgets,protected_reference_allowlist,agent_session_id) VALUES($1,$2,$3,$4,'active','M6 process owner',$5::jsonb,$6,$7,$8,$7,$8,$9,'{}','[]',$10)`,
      [
        adaptiveSessionId,
        projectId,
        environmentId,
        randomUUID(),
        JSON.stringify([fixture.origin]),
        missionId,
        objectiveId,
        flowDraftId,
        `m6-process-session-${adaptiveSessionId}`,
        agentSessionId,
      ],
    );
    await database.query(
      `INSERT INTO adaptive_sessions(id,project_id,environment_id,correlation_id,state,objective,allowed_origins,mission_id,objective_id,flow_draft_id,active_objective_id,active_flow_draft_id,idempotency_key,authoring_turn_budgets,protected_reference_allowlist,agent_session_id) VALUES($1,$2,$3,$4,'active','M6 reconciliation owner',$5::jsonb,$6,$7,$8,$7,$8,$9,'{}','[]',$10)`,
      [
        reconciliationSessionId,
        projectId,
        environmentId,
        randomUUID(),
        JSON.stringify([fixture.origin]),
        missionId,
        objectiveId,
        flowDraftId,
        `m6-reconciliation-session-${reconciliationSessionId}`,
        agentSessionId,
      ],
    );
    await database.query(
      `INSERT INTO mission_authorizations(id,mission_id,objective_id,environment_id,kind,reason,status,granted_by_agent_session_id,granted_by_user_id,operation_id,praxis_session_id) VALUES($1,$2,$3,$4,'live_mutation','M6 protected stale-owner qualification','approved',$5,$6,'m6-protected-scope',$7)`,
      [
        protectedAuthorizationId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        userId,
        reconciliationSessionId,
      ],
    );
  }
});

function policy(origin: string) {
  return {
    allowedOrigins: [origin],
    allowPrivateNetwork: true,
    allowDownloads: false,
    allowPopups: false,
    maxActions: 20,
    maxDurationMs: 60_000,
    maxNavigations: 10,
  };
}
