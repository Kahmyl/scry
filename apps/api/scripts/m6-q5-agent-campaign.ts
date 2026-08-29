import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { encryptCredential } from "../src/access/credential.crypto.js";
import { Database } from "../src/infrastructure/index.js";
import { QualificationCampaignRepository } from "../src/runtime/repositories/qualification-campaign.repository.js";
import { startQ3Fixture } from "../../../packages/assurance/src/architecture/q3/fixture.js";

const databaseUrl = process.env.SCRY_M6_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("SCRY_M6_TEST_DATABASE_URL_REQUIRED");
process.env.DATABASE_URL = databaseUrl;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outputDirectory = path.resolve(
  process.env.SCRY_M6_Q5_OUTPUT ?? path.join(root, "artifacts/system-correctness/m6/q5-agent"),
);
await mkdir(outputDirectory, { recursive: true });

const schemaIdentity = "15b258b1b7c1f6d446d2addaab7e25f5c0e111dba3a87210679d9aea50e03237";
const releaseIdentity = "e".repeat(64);
const agentWallTimeSeconds = Number(process.env.SCRY_M6_Q5_AGENT_WALL_TIME_SECONDS ?? 3_600);
const agentModel =
  process.env.SCRY_M6_Q5_MODEL ?? process.env.SCRY_AGENT_LAB_DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const serviceToken = `m6_local_${randomBytes(24).toString("hex")}`;
const externalRunId = randomUUID();
const experimentId = externalRunId;
const fixturePassword = "m6-agent-protected-6Rt9";
const fixture = await startQ3Fixture({
  seed: 6501,
  mode: "NORMAL",
  evidenceMode: "REQUIRED_AVAILABLE",
  username: "m6-local-user",
  password: fixturePassword,
});
const database = new Database();
const children: ChildProcess[] = [];

try {
  const scope = await seedAgentScope();
  const campaigns = new QualificationCampaignRepository(database);
  const campaign = await campaigns.create(
    {
      kind: "user",
      subject: scope.userId,
      userId: scope.userId,
      email: "m6-agent-owner@example.test",
      workspaceId: scope.workspaceId,
      role: "owner",
    },
    scope.projectId,
    {
      environmentId: scope.environmentId,
      missionId: scope.missionId,
      objectiveId: scope.objectiveId,
      agentSessionId: scope.agentSessionId,
      purpose: "system_correctness",
      targetOrigin: fixture.origin,
      applicationIdentity: "q3-local-resource-fixture",
      qualificationMode: "local_test",
      releaseIdentity,
      schemaIdentity,
      maxRuns: 1,
      maxBusinessMutationDispatches: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  );

  const common = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:56389",
    SCRY_SERVICE_TOKEN: serviceToken,
    SCRY_RELEASE_ID: "m6-local-qualification",
    SCRY_SCHEMA_FINGERPRINT: schemaIdentity,
    SCRY_SOURCE_MANIFEST_SHA256: releaseIdentity,
    SCRY_GIT_COMMIT: process.env.SCRY_GIT_COMMIT ?? "m6-local",
    SCRY_SOURCE_DIRTY: "true",
    SCRY_RUNTIME_VERSION: "m6-local",
    SCRY_BROWSER_CHANNEL: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    VEIL_ADMISSION_KEY: process.env.VEIL_ADMISSION_KEY ?? "m6-local-veil-admission-key-32-bytes",
    ADAPTIVE_SESSION_RUNTIME_LEASE_MS: "3600000",
    ARTIFACT_ROOT: path.join(outputDirectory, "runs"),
  };

  children.push(
    startNode(path.join(root, "apps/api/src/main.ts"), {
      ...common,
      API_PORT: "4016",
      API_HOST: "127.0.0.1",
    }),
    startNode(path.join(root, "apps/api/src/worker.ts"), common),
  );
  await waitForHttp("http://127.0.0.1:4016/api/ready", serviceToken, 60_000);
  children.push(
    startNode(path.join(root, "apps/mcp/src/http.ts"), {
      ...common,
      MCP_PORT: "4116",
      MCP_HOST: "127.0.0.1",
      SCRY_API_BASE_URL: "http://127.0.0.1:4016/api",
      SCRY_PUBLIC_API_BASE_URL: "http://127.0.0.1:4016/api",
    }),
  );
  await waitForHttp("http://127.0.0.1:4116/health", serviceToken, 30_000);

  const agentOutput = path.join(outputDirectory, `primary-${externalRunId}`);
  await mkdir(agentOutput, { recursive: true });
  const objective = [
    `Operate only within assigned local Project ${scope.projectId}, Mission ${scope.missionId}, Objective ${scope.objectiveId}, Agent Session ${scope.agentSessionId}, working Flow Draft ${scope.flowDraftId}, and published Flow Revision ${scope.flowRevisionId}.`,
    "Using only Scry MCP, discover the local application's documented operation and current UI facts.",
    "Authenticate through Scry's protected credential mechanisms, perform exactly one authorized local resource creation, retrieve and verify the created resource, satisfy required evidence, and finalize the Run.",
    `When opening the Run, bind the assigned qualificationCampaignAuthorizationId ${campaign.id}.`,
    "Open the durable Run and use the Run ID returned by Scry before dispatching any Run operation.",
    "Stop on authoritative completion or a factual blocker. Never retry an UNKNOWN mutation.",
  ].join(" ");
  const agent = spawn(
    path.join(root, "apps/agent-lab/.venv/bin/scry-agent-lab"),
    [
      "run",
      "--provider",
      "deepseek",
      "--model",
      agentModel,
      "--profile",
      "capable_live_journey",
      "--max-wall-time-seconds",
      String(agentWallTimeSeconds),
      "--external-run-id",
      externalRunId,
      "--experiment-id",
      experimentId,
      "--mcp-url",
      "http://127.0.0.1:4116/mcp",
      "--output-directory",
      agentOutput,
      "--objective",
      objective,
    ],
    {
      cwd: path.dirname(outputDirectory),
      env: {
        ...process.env,
        SCRY_AGENT_LAB_MCP_TOKEN: serviceToken,
        SCRY_AGENT_LAB_TOOL_RESULT_PROJECTION: "structured",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const agentLogs = await collect(agent, (agentWallTimeSeconds + 30) * 1_000);
  await writeFile(path.join(outputDirectory, "agent-safe.log"), agentLogs.safe, "utf8");

  const result = JSON.parse(await readFile(path.join(agentOutput, "result.json"), "utf8"));
  const transcript = await readFile(path.join(agentOutput, "transcript.jsonl"), "utf8");
  if (transcript.includes(fixturePassword)) throw new Error("M6_Q5_PROTECTED_VALUE_LEAK");
  const truth = fixture.readGroundTruth();
  const durable = await database.query<{
    runsConsumed: number;
    mutationsConsumed: number;
    disposition: string;
    runCount: number;
    consumptionCount: number;
  }>(
    `SELECT campaign.runs_consumed AS "runsConsumed",
            campaign.business_mutation_dispatches_consumed AS "mutationsConsumed",
            campaign.disposition,
            (SELECT count(*)::int FROM runs WHERE qualification_campaign_authorization_id=campaign.id) AS "runCount",
            (SELECT count(*)::int FROM qualification_campaign_mutation_consumptions WHERE campaign_authorization_id=campaign.id) AS "consumptionCount"
       FROM qualification_campaign_authorizations campaign WHERE campaign.id=$1`,
    [campaign.id],
  );
  const report = {
    agent: {
      provider: "deepseek",
      model: agentModel,
      externalRunId,
      result,
      repositoryBlindness: {
        cwdOutsideRepository: true,
        exposedCapabilities: ["Scry MCP"],
        shell: false,
        database: false,
        fixtureHttp: false,
        oracle: false,
        parentSemanticCoaching: false,
      },
    },
    campaign: { id: campaign.id, ...durable.rows[0] },
    oracle: truth,
    protectedLeakCount: 0,
  };
  await writeFile(
    path.join(outputDirectory, "q5-agent-result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (agentLogs.exitCode !== 0)
    throw new Error(`M6_Q5_AGENT_EXIT_${agentLogs.exitCode}:${agentLogs.stderr.slice(-2_000)}`);
  if (truth.resources.length !== 1 || truth.mutationRequests.length !== 1)
    throw new Error("M6_Q5_ORACLE_MUTATION_ACCOUNTING_FAILED");
  if (durable.rows[0]?.runsConsumed !== 1 || durable.rows[0]?.mutationsConsumed !== 1)
    throw new Error("M6_Q5_CAMPAIGN_CONSUMPTION_FAILED");
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await fixture.close();
  await database.onModuleDestroy();
}

async function seedAgentScope() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  await database.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,'M6 Q5',$2)`, [
    workspaceId,
    `m6-q5-${workspaceId}`,
  ]);
  await database.query(
    `INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'M6 Q5 local fixture')`,
    [projectId, workspaceId],
  );
  await database.query(
    `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,'Local qualification',$3,$4::jsonb)`,
    [
      environmentId,
      projectId,
      fixture.origin,
      JSON.stringify({
        allowedOrigins: [fixture.origin],
        allowPrivateNetwork: true,
        allowDownloads: false,
        allowPopups: false,
        maxActions: 80,
        maxDurationMs: 1_800_000,
        maxNavigations: 20,
      }),
    ],
  );
  await database.query(
    `INSERT INTO missions(id,project_id,title,original_instruction,status) VALUES($1,$2,'M6 repository-blind qualification','Create and verify one documented local resource','running')`,
    [missionId, projectId],
  );
  await database.query(
    `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order,status)
     VALUES($1,$2,'Create and verify one local resource',$3::jsonb,0,'pending')`,
    [
      objectiveId,
      missionId,
      JSON.stringify([
        {
          description:
            "One local resource is created, retrieved, and supported by accepted evidence",
          required: true,
        },
      ]),
    ],
  );
  await database.query(`UPDATE missions SET current_objective_id=$2 WHERE id=$1`, [
    missionId,
    objectiveId,
  ]);
  await database.query(
    `INSERT INTO agent_sessions(
       id,mission_id,project_id,workspace_id,provider,model,external_run_id,experiment_id,
       instruction_snapshot,idempotency_key,heartbeat_at,lease_expires_at
     ) VALUES(
       $1,$2,$3,$4,'deepseek',$8,$5,$6,
       'Repository-blind M6 objective',$7,now(),now()+interval '60 minutes'
     )`,
    [
      agentSessionId,
      missionId,
      projectId,
      workspaceId,
      externalRunId,
      experimentId,
      `external-run:${externalRunId}`,
      agentModel,
    ],
  );
  const plan = {
    name: "M6 agent-directed local qualification",
    objective: "Create and verify one documented local resource",
    preconditions: [],
    allowedOrigins: [fixture.origin],
    budgets: { maxActions: 80, maxDurationMs: 1_800_000, maxNavigations: 20 },
    checkpoints: [],
    steps: [
      {
        id: "open-local-documentation",
        title: "Open local documentation",
        action: { type: "navigate", url: fixture.docsUrl },
        assertions: [],
        onFailure: "stop",
        evidence: [],
        captureIntent: "final",
      },
    ],
  };
  await database.transaction(async (client) => {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO flows(
         id,project_id,name,latest_revision_id,visibility,purpose,origin_mission_id,
         origin_objective_id,created_by_agent_session_id,owner_mission_id,owner_objective_id
       ) VALUES($1,$2,'M6 assigned agent-directed flow',$3,'mission_local','primary',$4,$5,$6,$4,$5)`,
      [flowId, projectId, flowRevisionId, missionId, objectiveId, agentSessionId],
    );
    await client.query(
      `INSERT INTO flow_revisions(
         id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason
       ) VALUES($1,$2,1,$3::jsonb,$4::jsonb,'{}'::jsonb,$5,'M6 assigned representation')`,
      [
        flowRevisionId,
        flowId,
        JSON.stringify({
          objective: "Create and verify one documented local resource",
          preconditions: [],
          expectedOutcomes: ["One resource is created and verified"],
          prohibitedSideEffects: ["A second resource mutation"],
        }),
        JSON.stringify(plan),
        agentSessionId,
      ],
    );
  });
  await database.query(
    `INSERT INTO flow_drafts(
       id,project_id,mission_id,objective_id,environment_id,flow_id,name,content,plan,
       created_by_agent_session_id
     ) VALUES($1,$2,$3,$4,$5,$6,'M6 assigned working draft','{}'::jsonb,$7::jsonb,$8)`,
    [
      flowDraftId,
      projectId,
      missionId,
      objectiveId,
      environmentId,
      flowId,
      JSON.stringify(plan),
      agentSessionId,
    ],
  );
  for (const [name, value] of [
    ["Local fixture username", "m6-local-user"],
    ["Local fixture password", fixturePassword],
  ] as const) {
    const encrypted = encryptCredential(value);
    await database.query(
      `INSERT INTO project_credentials(project_id,name,ciphertext,initialization_vector,authentication_tag,origin_mission_id,origin_objective_id,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        projectId,
        name,
        encrypted.ciphertext,
        encrypted.initializationVector,
        encrypted.authenticationTag,
        missionId,
        objectiveId,
        agentSessionId,
      ],
    );
  }
  return {
    workspaceId,
    userId,
    projectId,
    environmentId,
    missionId,
    objectiveId,
    agentSessionId,
    flowDraftId,
    flowRevisionId,
  };
}

function startNode(entry: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: path.dirname(entry).includes("apps/mcp")
      ? path.join(root, "apps/mcp")
      : path.join(root, "apps/api"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
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
  throw new Error(`M6_SERVICE_READINESS_TIMEOUT:${url}`);
}

async function collect(child: ChildProcess, timeoutMs: number) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("M6_Q5_AGENT_TIMEOUT"));
    }, timeoutMs),
  );
  const code = await Promise.race([exit, timeout]);
  return {
    exitCode: code,
    stderr,
    safe: `${stdout}\n${stderr}`.slice(-20_000),
  };
}
