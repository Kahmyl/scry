import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startQ3Fixture,
  type Q3Fixture,
} from "../../../packages/assurance/src/architecture/q3/fixture.js";
import { Database } from "../src/infrastructure/index.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";

const databaseUrl = process.env.SCRY_M6_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const schemaIdentity = "15b258b1b7c1f6d446d2addaab7e25f5c0e111dba3a87210679d9aea50e03237";
const childDiagnostics: string[] = [];

integration("M6 actual MCP campaign adversary", () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const wrongEnvironmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const serviceToken = `m6_adversary_${randomBytes(24).toString("hex")}`;
  const children: ChildProcess[] = [];
  const principal = {
    kind: "user" as const,
    subject: userId,
    userId,
    email: "m6-mcp-owner@example.test",
    workspaceId,
    role: "owner" as const,
  };
  let database: Database;
  let campaigns: QualificationCampaignRepository;
  let fixture: Q3Fixture;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    fixture = await startQ3Fixture({
      seed: 6601,
      mode: "NORMAL",
      evidenceMode: "REQUIRED_AVAILABLE",
      username: "m6-mcp-user",
      password: "m6-mcp-protected-G7v2",
    });
    database = new Database();
    campaigns = new QualificationCampaignRepository(database);
    await seedCommonScope();
    const common = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:56389",
      SCRY_SERVICE_TOKEN: serviceToken,
      SCRY_RELEASE_ID: "m6-mcp-adversary",
      SCRY_SCHEMA_FINGERPRINT: schemaIdentity,
      SCRY_SOURCE_MANIFEST_SHA256: "e".repeat(64),
      SCRY_GIT_COMMIT: "m6-local",
      SCRY_SOURCE_DIRTY: "true",
      SCRY_RUNTIME_VERSION: "m6-local",
      SCRY_BROWSER_CHANNEL: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      VEIL_ADMISSION_KEY: "m6-local-veil-admission-key-32-bytes",
      ADAPTIVE_SESSION_RUNTIME_LEASE_MS: "3600000",
    };
    children.push(
      startNode(path.join(root, "apps/api/src/main.ts"), {
        ...common,
        API_PORT: "4017",
        API_HOST: "127.0.0.1",
      }),
      startNode(path.join(root, "apps/api/src/worker.ts"), common),
    );
    await waitForHttp("http://127.0.0.1:4017/api/ready", serviceToken, 60_000);
    children.push(
      startNode(path.join(root, "apps/mcp/src/http.ts"), {
        ...common,
        MCP_PORT: "4117",
        MCP_HOST: "127.0.0.1",
        SCRY_API_BASE_URL: "http://127.0.0.1:4017/api",
        SCRY_PUBLIC_API_BASE_URL: "http://127.0.0.1:4017/api",
      }),
    );
    await waitForHttp("http://127.0.0.1:4117/health", serviceToken, 30_000);
  }, 90_000);

  afterAll(async () => {
    for (const child of children.reverse()) child.kill("SIGTERM");
    await fixture?.close();
    await database?.onModuleDestroy();
  });

  it.each(["succeeded", "failed", "inconclusive"] as const)(
    "negotiates current MCP and refuses a second Run after %s",
    async (disposition) => {
      const agentSessionId = await seedAgent(`run-${disposition}`);
      const campaign = await createCampaign(agentSessionId);
      await admitRun(campaign.id, agentSessionId, disposition);
      const response = await callMcp("start_run", {
        projectId,
        missionId,
        objectiveId,
        agentSessionId,
        environmentId,
        flowRevisionId,
        praxisSessionId: randomUUID(),
        qualificationCampaignAuthorizationId: campaign.id,
        protectedAuthorizations: [],
        idempotencyKey: `m6-second-${disposition}`,
      });
      expect(response.protocolVersion).toBe("2025-11-25");
      expect(response.toolNames).toContain("start_run");
      expect(rejectionCode(response)).toBe("QUALIFICATION_RUN_CAPABILITY_CONSUMED");
      expect(await runCount(campaign.id)).toBe(1);
    },
  );

  it("refuses a wrong-environment campaign at the actual MCP/API boundary", async () => {
    const agentSessionId = await seedAgent("wrong-environment");
    const campaign = await createCampaign(agentSessionId);
    const response = await callMcp("start_run", {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      environmentId: wrongEnvironmentId,
      flowRevisionId,
      praxisSessionId: randomUUID(),
      qualificationCampaignAuthorizationId: campaign.id,
      protectedAuthorizations: [],
      idempotencyKey: "m6-wrong-environment",
    });
    expect(rejectionCode(response)).toBe("QUALIFICATION_CAMPAIGN_SCOPE_MISMATCH");
    expect(await runCount(campaign.id)).toBe(0);
  });

  it("refuses a second business mutation before fixture dispatch through actual MCP", async () => {
    const agentSessionId = await seedAgent("second-mutation");
    const flowDraftId = randomUUID();
    await database.query(
      `INSERT INTO flow_drafts(
       id,project_id,mission_id,objective_id,environment_id,name,content,plan,
       created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'M6 MCP mutation','{}',$7::jsonb,$6)`,
      [
        flowDraftId,
        projectId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        JSON.stringify(qualificationPlan()),
      ],
    );
    const started = await callMcp("start_praxis_session", {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      environmentId,
      objective: "Exercise one bounded local mutation",
      allowedOrigins: [fixture.origin],
      protection: "ordinary",
    });
    const praxisSessionId = (
      started.result.structured_content as { session?: { id?: string } } | undefined
    )?.session?.id;
    expect(praxisSessionId, JSON.stringify(started)).toEqual(expect.any(String));
    const campaign = await createCampaign(agentSessionId);
    const runAdmission = await callMcp("start_run", {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      environmentId,
      flowRevisionId,
      praxisSessionId: praxisSessionId!,
      qualificationCampaignAuthorizationId: campaign.id,
      protectedAuthorizations: [],
      idempotencyKey: `m6-live-mutation-run-${randomUUID()}`,
    });
    const runId = (
      runAdmission.result.structured_content as { run?: { runId?: string } } | undefined
    )?.run?.runId;
    expect(runId, JSON.stringify({ runAdmission, childDiagnostics })).toEqual(expect.any(String));
    await campaigns.consumeBusinessMutation({
      runId: runId!,
      operationId: "m6-first-possible-dispatch",
      mutationIdentity: `m6-first-${randomUUID()}`,
    });
    const authorizationId = randomUUID();
    await database.query(
      `INSERT INTO mission_authorizations(
         id,mission_id,objective_id,environment_id,kind,reason,status,
         granted_by_agent_session_id,granted_by_user_id,operation_id,praxis_session_id
       ) VALUES($1,$2,$3,$4,'live_mutation','M6 deterministic adversary','approved',$5,$6,$7,$8)`,
      [
        authorizationId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        userId,
        "m6-deliberate-second-mutation",
        praxisSessionId!,
      ],
    );
    const before = fixture.readGroundTruth();
    const response = await callMcp("dispatch_run_operation", {
      runId: runId!,
      praxisSessionId: praxisSessionId!,
      intent: {
        intentId: "m6-deliberate-second-mutation",
        objectiveId,
        flowDraftId,
        action: {
          kind: "same_origin_request",
          method: "POST",
          authentication: "current_browser_session",
          path: "/api/resources",
          body: { label: "must be refused", quantity: 1 },
          expectedStatus: { min: 200, max: 299 },
        },
        expectedEffect: { kind: "none" },
        constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "live_mutation", authorizationId },
        protectedInputReferences: [],
      },
    });
    expect(rejectionCode(response), JSON.stringify(response)).toBe(
      "QUALIFICATION_MUTATION_CAPABILITY_CONSUMED",
    );
    expect(fixture.readGroundTruth().mutationRequests).toEqual(before.mutationRequests);
    expect(
      await database.query(
        `SELECT count(*)::int AS count FROM qualification_campaign_mutation_consumptions
          WHERE campaign_authorization_id=$1`,
        [campaign.id],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
  }, 60_000);

  it("keeps explicit activation semantics aligned with actual MCP campaign accounting", async () => {
    const omitted = await prepareActivation("omitted");
    const omittedResponse = await callMcp("dispatch_run_operation", {
      runId: omitted.runId,
      praxisSessionId: omitted.praxisSessionId,
      intent: activationIntent(omitted, "omitted"),
    });
    expect(omittedResponse.result.is_error).toBe(true);
    expect(await mutationCount(omitted.campaignId)).toBe(0);
    const omittedObservation = await callMcp("observe_praxis_session", {
      praxisSessionId: omitted.praxisSessionId,
    });
    expect(
      (omittedObservation.result.structured_content as { observation?: { url?: string } })
        .observation?.url,
    ).toBe(fixture.docsUrl);

    const readContext = await prepareActivation("read-context");
    const readResponse = await callMcp("dispatch_run_operation", {
      runId: readContext.runId,
      praxisSessionId: readContext.praxisSessionId,
      intent: activationIntent(readContext, "read-context", "read_context_transition", "live_read"),
    });
    expect(readResponse.result.is_error, JSON.stringify(readResponse)).toBe(false);
    expect(operationResult(readResponse)).toMatchObject({
      functionalResult: "succeeded",
      mutationOutcome: "not_applied",
    });
    expect(await mutationCount(readContext.campaignId)).toBe(0);

    for (const semanticEffect of ["resource_mutation", "unknown"] as const) {
      const activation = await prepareActivation(semanticEffect);
      const response = await callMcp("dispatch_run_operation", {
        runId: activation.runId,
        praxisSessionId: activation.praxisSessionId,
        intent: activationIntent(activation, semanticEffect, semanticEffect, "ordinary"),
      });
      expect(response.result.is_error, JSON.stringify(response)).toBe(false);
      expect(operationResult(response)).toMatchObject({
        functionalResult: "succeeded",
        mutationOutcome: "applied",
      });
      expect(await mutationCount(activation.campaignId)).toBe(1);
    }

    expect(fixture.readGroundTruth().mutationRequests).toHaveLength(0);
  }, 90_000);

  async function seedCommonScope() {
    await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'M6 MCP',$2)`, [
      workspaceId,
      `m6-mcp-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'M6 MCP')`, [
      projectId,
      workspaceId,
    ]);
    for (const [id, name] of [
      [environmentId, "M6 MCP local"],
      [wrongEnvironmentId, "M6 MCP wrong"],
    ] as const)
      await database.query(
        `INSERT INTO environments(id,project_id,name,base_origin,policy)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [
          id,
          projectId,
          name,
          fixture.origin,
          JSON.stringify({
            allowedOrigins: [fixture.origin],
            allowPrivateNetwork: true,
            allowDownloads: false,
            allowPopups: false,
            maxActions: 20,
            maxDurationMs: 60_000,
            maxNavigations: 10,
          }),
        ],
      );
    await database.query(
      `INSERT INTO missions(id,project_id,title,original_instruction,status)
       VALUES($1,$2,'M6 MCP','Adversarial campaign calls','running')`,
      [missionId, projectId],
    );
    await database.query(
      `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order,status)
       VALUES($1,$2,'M6 MCP objective','[]',0,'running')`,
      [objectiveId, missionId],
    );
    const creator = await seedAgent("flow-creator");
    await database.transaction(async (client) => {
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(
        `INSERT INTO flows(
           id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,
           origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id
         ) VALUES($1,$2,'M6 MCP flow',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
        [flowId, projectId, flowRevisionId, missionId, objectiveId, creator],
      );
      await client.query(
        `INSERT INTO flow_revisions(
           id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason
         ) VALUES($1,$2,1,'{}',$4::jsonb,'{}',$3,'M6 MCP')`,
        [flowRevisionId, flowId, creator, JSON.stringify(qualificationPlan())],
      );
    });
  }

  async function prepareActivation(label: string) {
    const agentSessionId = await seedAgent(`activation-${label}`);
    const flowDraftId = randomUUID();
    await database.query(
      `INSERT INTO flow_drafts(
       id,project_id,mission_id,objective_id,environment_id,name,content,plan,
       created_by_agent_session_id
       ) VALUES($1,$2,$3,$4,$5,'M6 MCP activation','{}',$7::jsonb,$6)`,
      [
        flowDraftId,
        projectId,
        missionId,
        objectiveId,
        environmentId,
        agentSessionId,
        JSON.stringify(qualificationPlan()),
      ],
    );
    const started = await callMcp("start_praxis_session", {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      environmentId,
      objective: "Classify one local documentation transition",
      allowedOrigins: [fixture.origin],
      protection: "ordinary",
    });
    const praxisSessionId = (
      started.result.structured_content as { session?: { id?: string } } | undefined
    )?.session?.id;
    expect(praxisSessionId, JSON.stringify(started)).toEqual(expect.any(String));
    const campaign = await createCampaign(agentSessionId);
    const admitted = await callMcp("start_run", {
      projectId,
      missionId,
      objectiveId,
      agentSessionId,
      environmentId,
      flowRevisionId,
      praxisSessionId,
      qualificationCampaignAuthorizationId: campaign.id,
      protectedAuthorizations: [],
      idempotencyKey: `m6-activation-run-${label}-${randomUUID()}`,
    });
    const runId = (admitted.result.structured_content as { run?: { runId?: string } } | undefined)
      ?.run?.runId;
    expect(runId, JSON.stringify(admitted)).toEqual(expect.any(String));
    const navigation = await callMcp("dispatch_run_operation", {
      runId,
      praxisSessionId,
      intent: {
        intentId: `m6-activation-docs-${label}`,
        objectiveId,
        flowDraftId,
        action: { kind: "navigate", url: fixture.docsUrl },
        expectedEffect: { kind: "navigation", url: fixture.docsUrl, match: "exact" },
        constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      },
    });
    expect(navigation.result.is_error, JSON.stringify(navigation)).toBe(false);
    const result = operationResult(navigation);
    const target = result.successorObservation?.semanticPageContext?.controls?.find(
      (control: any) =>
        control.role === "link" && control.name === "Open local resource application",
    );
    expect(target, JSON.stringify(result.successorObservation)).toMatchObject({
      reference: expect.stringMatching(/^context-control-[a-f0-9]{32}$/),
    });
    expect(await mutationCount(campaign.id)).toBe(0);
    return {
      campaignId: campaign.id,
      flowDraftId,
      praxisSessionId: praxisSessionId!,
      runId: runId!,
      target: {
        concept: "Open local resource application",
        reference: target.reference as string,
        role: "link",
        name: "Open local resource application",
      },
    };
  }

  function activationIntent(
    activation: Awaited<ReturnType<typeof prepareActivation>>,
    label: string,
    semanticEffect?: "read_context_transition" | "resource_mutation" | "unknown",
    authorization: "ordinary" | "live_read" = "ordinary",
  ) {
    return {
      intentId: `m6-activation-${label}`,
      objectiveId,
      flowDraftId: activation.flowDraftId,
      action: {
        kind: "activate",
        target: activation.target,
        ...(semanticEffect ? { semanticEffect } : {}),
      },
      expectedEffect: { kind: "navigation", url: fixture.appUrl, match: "exact" },
      constraints: { timeoutMs: 10_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: authorization },
      protectedInputReferences: [],
    };
  }

  function operationResult(response: Awaited<ReturnType<typeof callMcp>>) {
    return (response.result.structured_content as { result?: any } | undefined)?.result ?? {};
  }

  async function seedAgent(label: string) {
    const id = randomUUID();
    await database.query(
      `INSERT INTO agent_sessions(
         id,mission_id,provider,instruction_snapshot,idempotency_key,project_id,workspace_id
       ) VALUES($1,$2,'deterministic_mcp','M6 deterministic MCP adversary',$3,$4,$5)`,
      [id, missionId, `m6-mcp-${label}-${id}`, projectId, workspaceId],
    );
    return id;
  }

  function qualificationPlan() {
    return {
      name: "M6 deterministic MCP adversary",
      objective: "Exercise one bounded local mutation",
      preconditions: [],
      allowedOrigins: [fixture.origin],
      budgets: { maxActions: 20, maxDurationMs: 60_000, maxNavigations: 10 },
      checkpoints: [],
      steps: [],
    };
  }

  function createCampaign(agentSessionId: string) {
    return campaigns.create(principal, projectId, {
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      purpose: "system_correctness",
      targetOrigin: fixture.origin,
      applicationIdentity: "q3-local-resource-fixture",
      qualificationMode: "local_test",
      releaseIdentity: "e".repeat(64),
      schemaIdentity,
      maxRuns: 1,
      maxBusinessMutationDispatches: 1,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
  }

  async function admitRun(
    campaignId: string,
    agentSessionId: string,
    disposition: "running" | "succeeded" | "failed" | "inconclusive",
    runtime?: { praxisSessionId: string; flowDraftId: string },
  ) {
    const runId = await database.transaction(async (client) => {
      const bound = await campaigns.consumeRun(client, {
        campaignId,
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
      });
      const id = randomUUID();
      await client.query(
        `INSERT INTO runs(
           id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,
           state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,
           execution_snapshot,idempotency_key,qualification_campaign_authorization_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'running','executing_action','{}','{}','{}',$8::jsonb,$9::jsonb,$10,$11)`,
        [
          id,
          projectId,
          missionId,
          objectiveId,
          agentSessionId,
          environmentId,
          flowRevisionId,
          JSON.stringify({ schemaVersion: 1, digest: "d".repeat(64) }),
          JSON.stringify({
            executionModel: "agent_directed_v1",
            ...(runtime ? { praxisSessionId: runtime.praxisSessionId } : {}),
          }),
          `m6-mcp-run-${id}`,
          bound,
        ],
      );
      if (runtime) {
        await client.query(
          `INSERT INTO run_praxis_sessions(run_id,praxis_session_id,epoch,idempotency_key)
           VALUES($1,$2,1,$3)`,
          [id, runtime.praxisSessionId, `m6-binding-${id}`],
        );
        await client.query(
          `INSERT INTO attempts(
             run_id,attempt_number,state,claim_token,worker_id,heartbeat_at,started_at
           ) VALUES($1,1,'running',$2,'m6-mcp-adversary',now(),now())`,
          [id, randomUUID()],
        );
      }
      return id;
    });
    if (disposition !== "running") {
      await campaigns.settleRun(runId, disposition);
      await database.query(
        `UPDATE runs SET state=$2,phase='completed',updated_at=now() WHERE id=$1`,
        [runId, disposition === "succeeded" ? "passed" : "failed"],
      );
    }
    return runId;
  }

  async function callMcp(tool: string, args: Record<string, unknown>) {
    const command = spawn(
      path.join(root, "apps/agent-lab/.venv/bin/python"),
      [path.join(root, "apps/agent-lab/scripts/m6_mcp_call.py")],
      {
        cwd: path.join(root, "apps/agent-lab"),
        env: {
          ...process.env,
          SCRY_M6_MCP_URL: "http://127.0.0.1:4117/mcp",
          SCRY_M6_MCP_TOKEN: serviceToken,
          SCRY_M6_MCP_TOOL: tool,
          SCRY_M6_MCP_ARGUMENTS: JSON.stringify(args),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    command.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    command.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        command.kill("SIGTERM");
        reject(new Error("M6_MCP_CLIENT_TIMEOUT"));
      }, 90_000);
      command.once("error", reject);
      command.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    if (status !== 0) throw new Error(`M6_MCP_CLIENT_FAILED:${stderr}`);
    return JSON.parse(stdout) as {
      protocolVersion: string;
      toolNames: string[];
      result: { is_error: boolean; structured_content?: unknown; content: unknown[] };
    };
  }

  function rejectionCode(response: Awaited<ReturnType<typeof callMcp>>) {
    const structured = response.result.structured_content as
      { rejection?: { code?: string } } | undefined;
    return structured?.rejection?.code;
  }

  async function runCount(campaignId: string) {
    const result = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM runs
        WHERE qualification_campaign_authorization_id=$1`,
      [campaignId],
    );
    return result.rows[0]!.count;
  }

  async function mutationCount(campaignId: string) {
    const result = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM qualification_campaign_mutation_consumptions
        WHERE campaign_authorization_id=$1`,
      [campaignId],
    );
    return result.rows[0]!.count;
  }
});

function startNode(entry: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: entry.includes("apps/mcp") ? path.join(root, "apps/mcp") : path.join(root, "apps/api"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      childDiagnostics.push(`${path.basename(entry)}: ${String(chunk).slice(0, 2_000)}`);
      if (childDiagnostics.length > 20) childDiagnostics.shift();
    });
  return child;
}

async function waitForHttp(url: string, token: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`M6_MCP_READINESS_TIMEOUT:${url}\n${childDiagnostics.join("\n")}`);
}
