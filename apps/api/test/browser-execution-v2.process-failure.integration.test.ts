import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserProtectionDecision } from "@scry/contracts";

import { BrowserCommandRepository } from "../src/browser-execution/repositories/browser-command.repository.js";
import { BrowserExecutionRepository } from "../src/browser-execution/repositories/browser-execution.repository.js";
import { BrowserProtectedValueCipher } from "../src/browser-execution/protected-value-cipher.js";
import { Database } from "../src/infrastructure/database.js";

const databaseUrl = process.env.BROWSER_V2_TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fixturePath = fileURLToPath(new URL("./fixtures/browser-v2-crash-phase.ts", import.meta.url));

function publicDecision(
  effectId: string,
  captureId: string,
  value: string,
): BrowserProtectionDecision {
  return {
    captureId,
    effectId,
    key: "resourceId",
    path: ["resourceId"],
    label: "public" as const,
    allowedSinks: ["database_safe_field" as const, "mcp_response" as const],
    valueDigest: digest(value),
    decisionRevision: 1,
    decisionDigest: digest(`decision:${captureId}`),
    reason: "environment_policy:trusted_application_output",
    publicAdmissionMode: "trusted_application_output",
    publicSemantic: "resourceId",
    publicEvidenceDigest: digest(`evidence:${captureId}:resourceId`),
    publicProposalDigest: digest(`proposal:${captureId}:resourceId`),
  };
}

run("browser v2 actual process termination recovery", () => {
  let database: Database;
  let effects: BrowserExecutionRepository;
  let commands: BrowserCommandRepository;
  let projectId: string;
  let missionId: string;
  let objectiveId: string;
  let environmentId: string;
  let agentSessionId: string;
  let flowId: string;
  let flowRevisionId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BROWSER_V2_PROTECTED_KEY_BASE64 ??= randomBytes(32).toString("base64");
    database = new Database();
    const cipher = new BrowserProtectedValueCipher();
    effects = new BrowserExecutionRepository(database, cipher);
    commands = new BrowserCommandRepository(database, cipher);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    projectId = randomUUID();
    missionId = randomUUID();
    objectiveId = randomUUID();
    environmentId = randomUUID();
    agentSessionId = randomUUID();
    flowId = randomUUID();
    flowRevisionId = randomUUID();
    await database.transaction(async (client) => {
      await client.query("INSERT INTO app_users(id,supabase_user_id,email) VALUES($1,$2,$3)", [
        userId,
        randomUUID(),
        `${userId}@example.test`,
      ]);
      await client.query(
        "INSERT INTO workspaces(id,name,slug) VALUES($1,'process failure qualification',$2)",
        [workspaceId, `crash-${workspaceId}`],
      );
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspaceId, userId],
      );
      await client.query(
        "INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'process failure project')",
        [projectId, workspaceId],
      );
      await client.query(
        "INSERT INTO missions(id,project_id,title,original_instruction,idempotency_key) VALUES($1,$2,'crash qualification','qualify process loss',$3)",
        [missionId, projectId, `mission-${missionId}`],
      );
      await client.query(
        "INSERT INTO agent_sessions(id,mission_id,project_id,provider,instruction_snapshot,idempotency_key) VALUES($1,$2,$3,'codex','process failure',$4)",
        [agentSessionId, missionId, projectId, `agent-${agentSessionId}`],
      );
      await client.query(
        "INSERT INTO mission_objectives(id,mission_id,project_id,title,completion_criteria,objective_order,idempotency_key) VALUES($1,$2,$3,'survive crashes','{}'::jsonb,0,$4)",
        [objectiveId, missionId, projectId, `objective-${objectiveId}`],
      );
      await client.query(
        "INSERT INTO environments(id,project_id,name,base_origin,disclosure_mode) VALUES($1,$2,'local fixture','https://fixture.example','trusted_application_output')",
        [environmentId, projectId],
      );
      await client.query(
        "INSERT INTO flows(id,project_id,mission_id,created_by_agent_session_id,name,idempotency_key) VALUES($1,$2,$3,$4,'crash flow',$5)",
        [flowId, projectId, missionId, agentSessionId, `flow-${flowId}`],
      );
      await client.query(
        "INSERT INTO flow_revisions(id,flow_id,mission_id,project_id,revision,state,created_by_agent_session_id,activated_at) VALUES($1,$2,$3,$4,1,'active',$5,now())",
        [flowRevisionId, flowId, missionId, projectId, agentSessionId],
      );
    });
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
  });

  it("recovers authoritative state at every required process-loss boundary", async () => {
    const before = await session("before-dispatch", 1);
    const beforeIntent = effectIntent(
      before.sessionId,
      before.ownerGeneration,
      "before-dispatch-effect",
    );
    await killAt("before_dispatch", { effect: beforeIntent });
    const beforeEffect = await oneEffect(before.sessionId);
    await replaceOwner(before.sessionId);
    expect(await effects.observeEffect(beforeEffect.id)).toMatchObject({
      dispatch_state: "not_started",
      mutation_outcome: "not_applied",
      determination_source: "owner_replaced_before_dispatch",
    });
    expect((await budget(before.sessionId)).business_commits_used).toBe(0);

    const receipt = await session("provider-receipt", 2);
    const admittedReceipt = await effects.admitEffect(
      effectIntent(receipt.sessionId, receipt.ownerGeneration, "provider-receipt-effect"),
    );
    await effects.markDispatchStarted(admittedReceipt.effect.id, receipt.ownerGeneration);
    await killAt("after_provider_receipt", {
      effectId: admittedReceipt.effect.id,
      ownerGeneration: receipt.ownerGeneration,
      status: 201,
    });
    expect(await effects.observeEffect(admittedReceipt.effect.id)).toMatchObject({
      dispatch_state: "started",
      mutation_outcome: "pending",
    });
    const receiptOwner = await replaceOwner(receipt.sessionId);
    expect(await effects.observeEffect(admittedReceipt.effect.id)).toMatchObject({
      dispatch_state: "unknown",
      mutation_outcome: "unknown",
      determination_source: "owner_replaced_after_dispatch",
    });
    await expect(
      effects.admitEffect(effectIntent(receipt.sessionId, receiptOwner, "forbidden-redispatch")),
    ).rejects.toThrow("BROWSER_V2_EFFECT_UNRESOLVED");
    expect(
      (
        await effects.admitEffect({
          ...effectIntent(receipt.sessionId, receiptOwner, "provider-receipt-effect"),
          documentEpoch: 3,
        })
      ).replay,
    ).toBe(true);

    const capture = await session("capture-commit", 2);
    const admittedCapture = await effects.admitEffect(
      effectIntent(capture.sessionId, capture.ownerGeneration, "capture-effect"),
    );
    await effects.markDispatchStarted(admittedCapture.effect.id, capture.ownerGeneration);
    const captureId = randomUUID();
    await killAt("after_capture_commit", {
      capture: captureInput(
        admittedCapture.effect.id,
        capture.sessionId,
        capture.ownerGeneration,
        captureId,
      ),
    });
    const captureOwner = await replaceOwner(capture.sessionId);
    expect(await effects.recoverEffect(admittedCapture.effect.id)).toMatchObject({
      truth: { mutation_outcome: "unknown" },
      capture: { captureId, phase: "captured" },
    });
    await effects.determine(
      admittedCapture.effect.id,
      captureOwner,
      "applied",
      "durable_owned_capture",
    );
    await effects.publishOutputs({
      effectId: admittedCapture.effect.id,
      ownerGeneration: captureOwner,
      captureId,
      selectionDigest: digest("capture-selection"),
      publicOutputs: { resourceId: "captured-item" },
      protectedOutputs: {},
      decisions: [publicDecision(admittedCapture.effect.id, captureId, "captured-item")],
    });

    const publication = await session("publication", 1);
    const admittedPublication = await effects.admitEffect(
      effectIntent(publication.sessionId, publication.ownerGeneration, "publication-effect"),
    );
    await effects.markDispatchStarted(admittedPublication.effect.id, publication.ownerGeneration);
    const publicationCaptureId = randomUUID();
    await effects.registerCapture(
      captureInput(
        admittedPublication.effect.id,
        publication.sessionId,
        publication.ownerGeneration,
        publicationCaptureId,
      ),
    );
    await effects.determine(
      admittedPublication.effect.id,
      publication.ownerGeneration,
      "applied",
      "owned_response",
    );
    const selectionDigest = digest("publication-selection");
    await killAt("during_publication", {
      effectId: admittedPublication.effect.id,
      sessionId: publication.sessionId,
      captureId: publicationCaptureId,
      selectionDigest,
    });
    expect(
      Number(
        (
          await database.query<{ count: string }>(
            "SELECT count(*) FROM browser_publications WHERE capture_id=$1",
            [publicationCaptureId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(0);
    const published = await effects.publishOutputs({
      effectId: admittedPublication.effect.id,
      ownerGeneration: publication.ownerGeneration,
      captureId: publicationCaptureId,
      selectionDigest,
      publicOutputs: { resourceId: "publication-item" },
      protectedOutputs: {},
      decisions: [
        publicDecision(admittedPublication.effect.id, publicationCaptureId, "publication-item"),
      ],
    });
    expect(
      (
        await effects.publishOutputs({
          effectId: admittedPublication.effect.id,
          ownerGeneration: publication.ownerGeneration,
          captureId: publicationCaptureId,
          selectionDigest,
          publicOutputs: { resourceId: "publication-item" },
          protectedOutputs: {},
          decisions: [
            publicDecision(admittedPublication.effect.id, publicationCaptureId, "publication-item"),
          ],
        })
      ).publicationId,
    ).toBe(published.publicationId);

    const continuation = await session("continuation", 0);
    const submitted = await commands.submit(continuation.sessionId, {
      idempotencyKey: "continuation-observe",
      command: { kind: "observe" },
    });
    await killAt("before_continuation_ack", { commandId: submitted.commandId });
    expect(await commands.observe(submitted.commandId)).toMatchObject({ state: "running" });
    await database.query(
      "UPDATE browser_commands SET claim_lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [submitted.commandId],
    );
    const reclaimed = await commands.claim(submitted.commandId, 30_000);
    expect(reclaimed?.attempt_count).toBe(2);
    await commands.complete(submitted.commandId, reclaimed!.claim_token!, { recovered: true });
    expect(await commands.observe(submitted.commandId)).toMatchObject({
      state: "completed",
      result: { recovered: true },
    });
  }, 60_000);

  async function session(name: string, businessCommitLimit: number) {
    const runId = randomUUID();
    const sessionId = randomUUID();
    await database.query(
      `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,flow_id,flow_revision_id,environment_id,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        runId,
        projectId,
        missionId,
        objectiveId,
        agentSessionId,
        flowId,
        flowRevisionId,
        environmentId,
        `${name}-${runId}`,
      ],
    );
    await effects.createSession({
      id: sessionId,
      runId,
      projectId,
      missionId,
      objectiveId,
      environmentId,
      agentSessionId,
      authenticationCommitLimit: 0,
      businessCommitLimit,
      allowedFirstPartyOrigins: ["https://fixture.example"],
      idempotencyKey: `${name}-${sessionId}`,
    });
    const owner = await effects.claimOwner(sessionId, `worker-${name}`, 60_000);
    return { sessionId, ownerGeneration: owner.generation };
  }

  function effectIntent(sessionId: string, ownerGeneration: number, idempotencyKey: string) {
    return {
      sessionId,
      ownerGeneration,
      documentEpoch: 1,
      idempotencyKey,
      effectClass: "business" as const,
      expectedOrigin: "https://fixture.example",
      targetDigest: digest(`${idempotencyKey}-target`),
      actionDigest: digest(`${idempotencyKey}-action`),
      intentSummary: idempotencyKey,
    };
  }

  function captureInput(
    effectId: string,
    sessionId: string,
    ownerGeneration: number,
    captureId: string,
  ) {
    const encryptedPayload = Buffer.from(`ciphertext-${captureId}`);
    return {
      effectId,
      ownerGeneration,
      captureId,
      evidenceVersion: 1,
      objectKey: `captures/${captureId}`,
      ciphertextDigest: digest(encryptedPayload),
      encryptedPayload,
      encryptedPayloadDigest: digest(encryptedPayload),
      responseStatus: 201,
      authenticatedMetadata: { version: 1 },
      contentClass: "http_json" as const,
      byteSize: 64,
      structuralIndex: [{ path: ["resourceId"], classification: "public" }],
      capturedAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    };
  }

  async function oneEffect(sessionId: string) {
    return (
      await database.query<{ id: string }>("SELECT id FROM browser_effects WHERE session_id=$1", [
        sessionId,
      ])
    ).rows[0]!;
  }

  async function budget(sessionId: string) {
    return (
      await database.query<{ business_commits_used: number }>(
        "SELECT business_commits_used FROM browser_execution_sessions WHERE id=$1",
        [sessionId],
      )
    ).rows[0]!;
  }

  async function replaceOwner(sessionId: string): Promise<number> {
    await database.query(
      "UPDATE browser_owner_generations SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1 AND state='active'",
      [sessionId],
    );
    return (
      await effects.claimOwner(
        sessionId,
        `recovery-${randomUUID()}`,
        60_000,
        "actual process termination",
      )
    ).generation;
  }

  async function killAt(phase: string, value: unknown): Promise<void> {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fixturePath,
        phase,
        Buffer.from(JSON.stringify(value)).toString("base64url"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    const deadline = Date.now() + 10_000;
    while (!output.includes(`READY:${phase}`) && child.exitCode === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (!output.includes(`READY:${phase}`)) {
      child.kill("SIGKILL");
      throw new Error(`crash_phase_not_ready:${phase}:${errors}`);
    }
    const backendPid = Number(output.match(new RegExp(`READY:${phase}:(\\d+)`, "u"))?.[1]);
    if (!Number.isSafeInteger(backendPid))
      throw new Error(`crash_phase_backend_pid_missing:${phase}`);
    child.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`crash_phase_kill_timeout:${phase}`)), 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const backendDeadline = Date.now() + 10_000;
    while (Date.now() < backendDeadline) {
      const active = await database.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
        backendPid,
      ]);
      if (!active.rowCount) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`crash_phase_backend_still_active:${phase}:${backendPid}`);
  }
});
