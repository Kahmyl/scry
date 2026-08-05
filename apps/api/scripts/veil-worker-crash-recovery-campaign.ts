import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import { currentPlanSchema, executionPolicySchema } from "@scry/contracts";
import { snapshotVeilPolicy } from "../src/veil/policy-snapshot.js";

const db = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://scry:scry-local@127.0.0.1:54329/scry",
});
const api = process.env.SCRY_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.SCRY_SERVICE_TOKEN;
if (!token) throw new Error("SCRY_SERVICE_TOKEN is required");
if (process.env.VEIL_CRASH_EPHEMERAL_DATABASE !== "true")
  throw new Error(
    "VEIL_CRASH_EPHEMERAL_DATABASE=true is required: this destructive recovery campaign may run only against a disposable database topology.",
  );
const compose =
  process.env.SCRY_COMPOSE_FILE ?? path.resolve(process.cwd(), "../../docker-compose.yml");
const composeArgs = [
  "compose",
  ...(process.env.SCRY_COMPOSE_PROJECT ? ["-p", process.env.SCRY_COMPOSE_PROJECT] : []),
  "-f",
  compose,
];
const operationId = `veil-crash-${randomUUID()}`;
const canary = `VEIL_WORKER_CRASH_${randomUUID()}`;
let mutationMode = false;
let posts = 0;
let held: import("node:http").ServerResponse | undefined;
const server = createServer((req, res) => {
  if (req.url === "/mutate" && req.method === "POST") {
    posts += 1;
    if (mutationMode) {
      held = res;
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ publicValue: "public-value", protectedValue: canary }));
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    `<label>Purpose<input></label><button>Generate</button><output aria-label="Public identifier"></output><output aria-label="Protected generated value" data-scry-redacted=true></output><script>document.querySelector('button').onclick=()=>fetch('/mutate',{method:'POST'}).then(r=>r.json()).then(v=>{document.querySelector('[aria-label="Public identifier"]').textContent=v.publicValue;document.querySelector('[aria-label="Protected generated value"]').textContent=v.protectedValue})</script>`,
  );
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const intent = (concept: string, role: "textbox" | "button" | "value") =>
  ({
    concept,
    requiredCapabilities:
      role === "textbox"
        ? ["focusable", "accepts_text", "editable", "readable_value"]
        : role === "button"
          ? ["pointer_activatable"]
          : ["readable_value"],
    preferredEvidence: {
      roles: [role],
      names: [concept],
      labels: role === "textbox" ? [concept] : [],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "ordinary",
    confidence: { requiredFamilies: [], minimum: 0.45, minimumMargin: 0, minimumFamilyCount: 1 },
  }) as const;

async function main() {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.VEIL_CRASH_HTTP_PORT ?? 43871), "0.0.0.0", resolve);
  });
  const origin = `http://host.docker.internal:${(server.address() as { port: number }).port}`;
  const purpose = intent("Purpose", "textbox"),
    button = intent("Generate", "button"),
    pub = intent("Public identifier", "value"),
    secret = intent("Protected generated value", "value");
  const action: any = {
    type: "protectedTransaction",
    operationId,
    entry: { url: origin, assertions: [{ type: "visible", target: purpose }] },
    inputs: {},
    preparation: {
      effectPolicy: { ignoredRequests: [] },
      actions: [
        { type: "assertion", assertion: { type: "visible", target: purpose }, effect: "read_only" },
      ],
      assertions: [{ type: "visible", target: purpose }],
    },
    mutation: {
      action: {
        type: "click",
        target: button,
        expectedEffect: { type: "new_region", target: secret },
      },
      kind: "one_time",
      reconciliation: { strategy: "none", acceptUnknownOutcome: true },
    },
    extraction: {
      outputs: [
        {
          classification: "public",
          reference: "publicIdentifier",
          acquisition: {
            target: pub,
            classification: "public",
            permittedMethods: ["semantic_field_value"],
            validation: { minimumLength: 1, maximumLength: 200 },
          },
          storage: { name: "Public ID", scope: "run" },
        },
        {
          classification: "protected",
          reference: "generatedSecret",
          acquisition: {
            target: secret,
            classification: "unknown_secret",
            permittedMethods: ["semantic_field_value"],
            validation: { minimumLength: 1, maximumLength: 200 },
          },
          storage: { credentialName: "Crash secret", scope: "run" },
        },
      ],
      timeoutMs: 10_000,
      scheduling: "fair_shared_timeout",
    },
    acquisitionReadiness: {
      ceremonyIntent: button,
      expectedContainerModel: {
        version: 2,
        digest: "a".repeat(64),
        concept: "Crash form",
        scopeKind: "page",
        capabilityDigest: "b".repeat(64),
        structuralPath: [],
      },
      valueIntent: secret,
      approvedMethods: ["semantic_field_value"],
      minimumConfidence: 0.5,
      minimumConfidenceMargin: 0,
      recoveryPolicy: "abandon",
      recoveryWindowMs: 1_000,
    },
    continuation: {
      strategies: [
        {
          mode: "resume_parked_context",
          reentryUrl: origin,
          assertions: [{ type: "url", expected: "/", match: "path" }],
          continueAtStepId: "after-protected",
        },
      ],
    },
  };
  const plan: any = currentPlanSchema.parse({
    name: "Veil worker crash recovery",
    objective: "Prove no replay after worker loss",
    allowedOrigins: [origin],
    budgets: { maxActions: 3, maxDurationMs: 120_000, maxNavigations: 3 },
    checkpoints: [],
    steps: [
      {
        id: "open",
        title: "Open controlled app",
        action: { type: "navigate", url: origin },
        assertions: [],
        evidence: [],
        onFailure: "stop",
        captureIntent: "final",
      },
      {
        id: "protected",
        title: "Generate protected value",
        action,
        assertions: [],
        evidence: [],
        onFailure: "stop",
        captureIntent: "final",
      },
      {
        id: "after-protected",
        title: "Safe continuation",
        action: { type: "waitFor", target: purpose, state: "visible" },
        assertions: [],
        evidence: ["screenshot", "dom", "network"],
        onFailure: "stop",
        captureIntent: "final",
      },
    ],
  });
  const workspaceId = randomUUID(),
    userId = randomUUID(),
    projectId = randomUUID(),
    missionId = randomUUID(),
    objectiveId = randomUUID(),
    sessionId = randomUUID();
  await db.query(`INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)`, [
    workspaceId,
    "Veil worker crash fixture",
    `veil-crash-${workspaceId}`,
  ]);
  await db.query(
    `INSERT INTO app_users(id,supabase_user_id,email,display_name) VALUES($1,$2,$3,$4)`,
    [userId, randomUUID(), `veil-crash-${userId}@example.test`, "Veil Crash Fixture"],
  );
  await db.query(
    `INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')`,
    [workspaceId, userId],
  );
  await db.query(`INSERT INTO projects(id,workspace_id,name,description) VALUES($1,$2,$3,$4)`, [
    projectId,
    workspaceId,
    "Veil crash project",
    "isolated production recovery fixture",
  ]);
  await db.query(
    `INSERT INTO missions(id,project_id,title,original_instruction,status) VALUES($1,$2,$3,$4,'running')`,
    [missionId, projectId, "Veil crash mission", "Verify worker crash recovery"],
  );
  await db.query(
    `INSERT INTO mission_objectives(id,mission_id,title,description,status,completion_criteria,objective_order) VALUES($1,$2,$3,$4,'running',$5,0)`,
    [
      objectiveId,
      missionId,
      "Crash recovery",
      "No replay or protected artifact leakage",
      JSON.stringify([{ description: "Recovery is bounded and safe", required: true }]),
    ],
  );
  await db.query(`UPDATE missions SET current_objective_id=$2 WHERE id=$1`, [
    missionId,
    objectiveId,
  ]);
  await db.query(
    `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,status,idempotency_key) VALUES($1,$2,'codex',$3,'active',$4)`,
    [sessionId, missionId, { objective: "worker crash recovery" }, `session-${operationId}`],
  );
  const ctx = {
    project_id: projectId,
    mission_id: missionId,
    objective_id: objectiveId,
    session_id: sessionId,
    policy: executionPolicySchema.parse({ allowedOrigins: [origin], allowPrivateNetwork: true }),
  };
  const environmentId = randomUUID();
  const policy = executionPolicySchema.parse({
    ...ctx.policy,
    allowedOrigins: [origin],
    allowPrivateNetwork: true,
    maxActions: 10,
    maxDurationMs: 120_000,
    maxNavigations: 5,
  });
  await db.query(
    `INSERT INTO environments(id,project_id,name,base_origin,policy) VALUES($1,$2,$3,$4,$5)`,
    [environmentId, ctx.project_id, `veil-crash-${operationId}`, origin, policy],
  );
  const flowId = randomUUID(),
    sourceRevisionId = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO flows(id,project_id,name,description,latest_revision_id,visibility,purpose,origin_mission_id,origin_objective_id,created_by_agent_session_id) VALUES($1,$2,$3,$4,$5,'mission_local','verification',$6,$7,$8)`,
      [
        flowId,
        ctx.project_id,
        `Veil crash ${operationId}`,
        "synthetic crash recovery",
        sourceRevisionId,
        ctx.mission_id,
        ctx.objective_id,
        ctx.session_id,
      ],
    );
    await client.query(
      `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) VALUES($1,$2,1,$3,$4,$5,$6,'Veil crash campaign')`,
      [
        sourceRevisionId,
        flowId,
        {
          objective: "crash recovery",
          preconditions: [],
          expectedOutcomes: ["no replay"],
          prohibitedSideEffects: [],
        },
        plan,
        { valid: true },
        ctx.session_id,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const created = { flowId, revisionId: sourceRevisionId };
  const calibration = await request(`/api/projects/${ctx.project_id}/calibration-sessions`, {
    missionId: ctx.mission_id,
    objectiveId: ctx.objective_id,
    agentSessionId: ctx.session_id,
    name: `Calibration ${operationId}`,
    sourceFlowRevisionId: created.revisionId,
    operationId,
    environmentId,
    disposableDataConfirmed: true,
    confirmedUserAuthorized: true,
    purpose: "controlled synthetic crash verification",
    idempotencyKey: `cal-${operationId}`,
  });
  const attestation = await waitFor(
    async () =>
      (
        await db.query<any>(
          `SELECT a.id,a.boundary_structure FROM calibration_attestations a JOIN calibration_sessions s ON s.current_attempt_id=a.attempt_id WHERE s.id=$1`,
          [calibration.sessionId],
        )
      ).rows[0],
    "calibration attestation",
  );
  await db.query(
    `INSERT INTO calibration_decisions(attestation_id,decision,actor_id,reason_code) VALUES($1,'approved',$2,'CONTROLLED_CRASH_CAMPAIGN')`,
    [attestation.id, userId],
  );
  action.calibrationAttestationId = attestation.id;
  const boundInput = structuredClone(plan) as any;
  const protectedStep = boundInput.steps.find((step: any) => step.id === "protected");
  protectedStep.action = action;
  boundInput.checkpoints = [
    {
      id: "before-protected",
      beforeStepId: "protected",
      restorationUrl: origin,
      verificationAssertions: [{ type: "visible", target: purpose }],
      continueAtStepId: "after-protected",
      maxRestorations: 1,
      state: { cookies: true, localStorage: true, indexedDb: true },
    },
  ];
  const bound = currentPlanSchema.parse(boundInput);
  const revisionId = randomUUID();
  await db.query(
    `INSERT INTO flow_revisions(id,flow_id,revision,content,plan,validation,created_by_agent_session_id,reason) SELECT $1,flow_id,revision+1,content,$2,'{"valid":true}'::jsonb,$3,'bind crash calibration' FROM flow_revisions WHERE id=$4`,
    [revisionId, bound, ctx.session_id, created.revisionId],
  );
  await db.query(`UPDATE flows SET latest_revision_id=$2 WHERE id=$1`, [
    created.flowId,
    revisionId,
  ]);
  posts = 0;
  mutationMode = true;
  const runId = randomUUID();
  await db.query(
    `INSERT INTO runs(id,project_id,mission_id,objective_id,agent_session_id,environment_id,flow_revision_id,state,phase,plan_snapshot,environment_snapshot,policy_snapshot,veil_policy_snapshot,execution_snapshot,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,'queued','queued',$8,$9,$10,$11,$12,$13)`,
    [
      runId,
      ctx.project_id,
      ctx.mission_id,
      ctx.objective_id,
      ctx.session_id,
      environmentId,
      revisionId,
      bound,
      { id: environmentId, name: "veil-crash", baseOrigin: origin, policy, secretRefs: [] },
      policy,
      snapshotVeilPolicy(policy, undefined),
      { browser: "chromium", viewport: { width: 1280, height: 720 }, seed: 1 },
      `run-${operationId}`,
    ],
  );
  const heartbeat = (
    await db.query<any>(
      `SELECT release_id,schema_fingerprint FROM worker_heartbeats ORDER BY heartbeat_at DESC LIMIT 1`,
    )
  ).rows[0];
  await db.query(`INSERT INTO run_outbox(run_id,release_id,schema_fingerprint) VALUES($1,$2,$3)`, [
    runId,
    heartbeat.release_id,
    heartbeat.schema_fingerprint,
  ]);
  await request("/api/ready", undefined, "GET");
  await waitFor(
    async () =>
      (
        await db.query(
          `SELECT 1 FROM protected_transactions t JOIN protected_mutation_ledger l USING(run_id,operation_id) WHERE t.run_id=$1 AND t.lifecycle_state='mutation_dispatching' AND l.state='dispatching' AND l.invocation_started_at IS NOT NULL AND l.invocation_acknowledged_at IS NULL`,
          [runId],
        )
      ).rowCount
        ? true
        : undefined,
    "durable dispatch boundary",
  );
  execFileSync("docker", [...composeArgs, "kill", "-s", "SIGKILL", "worker"], { stdio: "inherit" });
  held?.destroy();
  execFileSync("docker", [...composeArgs, "up", "-d", "worker"], { stdio: "inherit" });
  await waitFor(
    async () =>
      (
        await db.query<any>(
          `SELECT reason_code FROM protected_transactions WHERE run_id=$1 AND reason_code='MUTATION_OUTCOME_UNKNOWN'`,
          [runId],
        )
      ).rows[0],
    "outcome unknown recovery",
    180_000,
  );
  const proof = (
    await db.query<any>(
      `SELECT (SELECT count(*) FROM attempts WHERE run_id=$1) attempts,(SELECT state FROM protected_mutation_ledger WHERE run_id=$1 AND operation_id=$2) ledger,(SELECT count(*) FROM run_checkpoints WHERE run_id=$1) checkpoints,((SELECT count(*) FROM artifacts WHERE attempt_id IN(SELECT id FROM attempts WHERE run_id=$1) AND (metadata::text LIKE $3 OR storage_key LIKE $3))+(SELECT count(*) FROM run_events WHERE attempt_id IN(SELECT id FROM attempts WHERE run_id=$1) AND payload::text LIKE $3)+(SELECT count(*) FROM step_results WHERE attempt_id IN(SELECT id FROM attempts WHERE run_id=$1) AND row_to_json(step_results)::text LIKE $3)) leaked`,
      [runId, operationId, `%${canary}%`],
    )
  ).rows[0];
  const scanProgram = `const fs=require('fs'),path=require('path');const [root,secret]=process.argv.slice(1);let files=0;function scan(p){if(!fs.existsSync(p))return;for(const entry of fs.readdirSync(p,{withFileTypes:true})){const full=path.join(p,entry.name);if(entry.name.includes(secret))throw new Error('canary in filename');if(entry.isDirectory())scan(full);else{files++;if(fs.readFileSync(full).includes(Buffer.from(secret)))throw new Error('canary in artifact bytes')}}}scan(root);process.stdout.write(String(files))`;
  const scannedFiles = Number(
    execFileSync(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "worker",
        "node",
        "-e",
        scanProgram,
        `/workspace/apps/api/artifacts/runs/${runId}`,
        canary,
      ],
      { encoding: "utf8" },
    ) || "0",
  );
  if (
    posts !== 1 ||
    proof.attempts < 2 ||
    proof.ledger === "acknowledged" ||
    proof.checkpoints < 1 ||
    Number(proof.leaked) !== 0
  )
    throw new Error(`Crash invariants failed ${JSON.stringify({ posts, ...proof, scannedFiles })}`);
  console.log(
    JSON.stringify({
      campaign: "veil-worker-crash-recovery",
      status: "passed",
      runId,
      posts,
      ...proof,
      scannedFiles,
    }),
  );
}
async function request(path: string, body?: unknown, method: "POST" | "GET" = "POST") {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
try {
  await main();
} finally {
  held?.destroy();
  server.close();
  await db.end();
}
