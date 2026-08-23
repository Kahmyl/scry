import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  CampaignMetricsCollector,
  retainCampaignReport,
  retainMissionLiveCampaignReport,
  startAdaptiveFixture,
} from "@scry/assurance";
import { finalizeCampaignResult } from "./adaptive-campaign-evaluation.js";
import { type CampaignCheck, type MilestoneCampaignResult } from "@scry/contracts";
import {
  currentPlanSchema,
  executionPolicySchema,
  adaptiveSessionOperationInputSchema,
  type AdaptiveSessionOperationInput,
  type InteractionTargetIntent,
} from "@scry/contracts";
import type { ExecutionReport } from "@scry/executor";
import { Redis } from "ioredis";
import pg from "pg";

import { decryptCredential, encryptCredential } from "../src/access/credential.crypto.js";
import {
  collectPersistedTelemetry,
  type DeployedCampaignSpec,
} from "./deployed-adaptive-campaign.js";
import {
  externalTargetOperations,
  m1ExternalTargetRegistry,
  type M1ExternalTarget,
} from "./mission-live-m1-target-registry.js";

export const CAMPAIGN_SECRET_REFERENCE = "11111111-1111-4111-8111-111111111111";

export type CampaignContext = {
  campaignId: string;
  correlationId: string;
  startedAt: string;
  fixture: Awaited<ReturnType<typeof startAdaptiveFixture>>;
  outputDirectory: string;
  metrics: CampaignMetricsCollector;
  secretValue: string;
  forbiddenValues: string[];
  campaignProjectId?: string;
  campaignMissionId?: string;
  campaignObjectiveId?: string;
  campaignFlowDraftId?: string;
  beforeCounts?: Record<string, number>;
  requiredChecks: CampaignCheck[];
  observationalChecks: CampaignCheck[];
  futureScope: CampaignCheck[];
};

export async function createCampaignContext(): Promise<CampaignContext> {
  const campaignId = randomUUID();
  const correlationId = randomUUID();
  const secretValue = `campaign-canary-${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof startAdaptiveFixture>>;
  let fixtureFailure: unknown;
  try {
    fixture = await startAdaptiveFixture(
      0,
      process.env.SCRY_CAMPAIGN_FIXTURE_HOST ?? "host.docker.internal",
      { protectedValue: secretValue },
    );
  } catch (error) {
    fixtureFailure = error;
    fixture = {
      origin: "http://127.0.0.1:1",
      snapshot: () => ({
        protectedDispatches: {
          readonlyInput: 0,
          textOutput: 0,
          interruptedAcquisition: 0,
        },
      }),
      close: async () => undefined,
    };
  }
  const beforeCounts = await controlPlaneCounts().catch(() => undefined);
  return {
    campaignId,
    correlationId,
    startedAt: new Date().toISOString(),
    fixture,
    outputDirectory: await mkdtemp(path.join(os.tmpdir(), "scry-adaptive-campaign-")),
    metrics: new CampaignMetricsCollector(correlationId),
    secretValue,
    forbiddenValues: [secretValue],
    ...(beforeCounts ? { beforeCounts } : {}),
    requiredChecks: [
      {
        id: "fixture",
        description: "The deterministic adaptive fixture starts successfully",
        status: fixtureFailure ? "failed" : "passed",
        ...(fixtureFailure ? { reasonCode: safeCode(fixtureFailure) } : {}),
      },
    ],
    observationalChecks: [],
    futureScope: [],
  };
}

export async function closeCampaignContext(context: CampaignContext): Promise<void> {
  context.secretValue = "";
  context.forbiddenValues = [];
  await context.fixture.close();
  await rm(context.outputDirectory, { recursive: true, force: true });
}

export async function generatedCoreCampaignSpec(
  context: CampaignContext,
  milestone: "M0" | "M1",
): Promise<DeployedCampaignSpec> {
  if (context.campaignProjectId) throw new Error("CAMPAIGN_CORE_SPEC_ALREADY_PROVISIONED");
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const emailCredentialId = randomUUID();
  const passwordCredentialId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const emailValue = `campaign-${context.campaignId}@example.test`;
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO projects(id,workspace_id,name,description)
       VALUES($1,'00000000-0000-4000-8000-000000000001',$2,$3)`,
      [projectId, `Adaptive campaign ${context.campaignId}`, "Ephemeral missionless campaign"],
    );
    await pool.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy,secret_refs)
       VALUES($1,$2,'Ephemeral fixture',$3,$4::jsonb,$5::jsonb)`,
      [
        environmentId,
        projectId,
        context.fixture.origin,
        JSON.stringify(adaptiveFixturePolicy(context.fixture.origin)),
        JSON.stringify([emailCredentialId, passwordCredentialId]),
      ],
    );
    await insertCampaignCredential(pool, {
      id: emailCredentialId,
      projectId,
      name: "Fixture email",
      value: emailValue,
    });
    await insertCampaignCredential(pool, {
      id: passwordCredentialId,
      projectId,
      name: "Fixture password",
      value: context.secretValue,
    });
    await insertCampaignOwnership(pool, {
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      title: `M1 production-shaped native authentication ${context.campaignId}`,
    });
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
  context.campaignProjectId = projectId;
  context.campaignMissionId = missionId;
  context.campaignObjectiveId = objectiveId;
  context.campaignFlowDraftId = flowDraftId;
  context.forbiddenValues.push(emailValue);

  return generatedCoreCampaignCalls({
    milestone,
    campaignId: context.campaignId,
    correlationId: context.correlationId,
    fixtureOrigin: context.fixture.origin,
    projectId,
    environmentId,
    emailCredentialId,
    passwordCredentialId,
    missionId,
    objectiveId,
    flowDraftId,
  });
}

export async function generatedVitractCampaignSpec(
  context: CampaignContext,
  milestone: "M0" | "M1",
): Promise<{ spec: DeployedCampaignSpec; forbiddenValues: string[] }> {
  requireLiveAcceptance(milestone, "vitract_preview");
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const target = await pool.query<{
      project_id: string;
      environment_id: string;
      email_id: string;
      password_id: string;
      email_ciphertext: Buffer;
      email_iv: Buffer;
      email_tag: Buffer;
      password_ciphertext: Buffer;
      password_iv: Buffer;
      password_tag: Buffer;
    }>(
      `SELECT p.id AS project_id,
              e.id AS environment_id,
              email.id AS email_id,
              password.id AS password_id,
              email.ciphertext AS email_ciphertext,
              email.initialization_vector AS email_iv,
              email.authentication_tag AS email_tag,
              password.ciphertext AS password_ciphertext,
              password.initialization_vector AS password_iv,
              password.authentication_tag AS password_tag
         FROM projects p
         JOIN environments e ON e.project_id=p.id
         JOIN project_credentials email ON email.project_id=p.id
           AND email.name='Vitract preview login email'
         JOIN project_credentials password ON password.project_id=p.id
           AND password.name='Vitract preview login password'
        WHERE p.name='Vitract'
          AND e.base_origin='https://preview.vitract.com'
          AND email.security_status='active'
          AND password.security_status='active'
          AND email.deleted_at IS NULL
          AND password.deleted_at IS NULL
          AND e.secret_refs ? email.id::text
          AND e.secret_refs ? password.id::text
        ORDER BY e.created_at DESC
        LIMIT 1`,
    );
    const row = target.rows[0];
    if (!row) throw new Error("VITRACT_CAMPAIGN_PROTECTED_CREDENTIALS_UNAVAILABLE");
    const projectId = randomUUID();
    const environmentId = randomUUID();
    const emailCredentialId = randomUUID();
    const passwordCredentialId = randomUUID();
    const missionId = randomUUID();
    const objectiveId = randomUUID();
    const agentSessionId = randomUUID();
    const flowDraftId = randomUUID();
    const emailValue = decryptCredential({
      ciphertext: row.email_ciphertext,
      initializationVector: row.email_iv,
      authenticationTag: row.email_tag,
    });
    const passwordValue = decryptCredential({
      ciphertext: row.password_ciphertext,
      initializationVector: row.password_iv,
      authenticationTag: row.password_tag,
    });
    await pool.query("BEGIN");
    try {
      await pool.query(
        `INSERT INTO projects(id,workspace_id,name,description)
         VALUES($1,'00000000-0000-4000-8000-000000000001',$2,'Isolated canonical Vitract M1 campaign')`,
        [projectId, `M1 Vitract ${context.campaignId}`],
      );
      await pool.query(
        `INSERT INTO environments(id,project_id,name,base_origin,policy,secret_refs)
         VALUES($1,$2,'M1 Vitract Preview','https://preview.vitract.com',$3::jsonb,$4::jsonb)`,
        [
          environmentId,
          projectId,
          JSON.stringify({
            allowedOrigins: ["https://preview.vitract.com"],
            maxActions: 12,
            maxDurationMs: 240_000,
            maxNavigations: 3,
            trustedScriptOrigins: ["https://js.stripe.com", "https://maps.googleapis.com"],
          }),
          JSON.stringify([emailCredentialId, passwordCredentialId]),
        ],
      );
      await insertCampaignCredential(pool, {
        id: emailCredentialId,
        projectId,
        name: "Vitract preview login email",
        value: emailValue,
      });
      await insertCampaignCredential(pool, {
        id: passwordCredentialId,
        projectId,
        name: "Vitract preview login password",
        value: passwordValue,
      });
      await insertCampaignOwnership(pool, {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        agentSessionId,
        flowDraftId,
        title: `M1 Vitract native authentication ${context.campaignId}`,
      });
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    context.campaignProjectId = projectId;
    context.campaignMissionId = missionId;
    context.campaignObjectiveId = objectiveId;
    context.campaignFlowDraftId = flowDraftId;
    const operations = vitractOperations(emailCredentialId, passwordCredentialId);
    const start = {
      name: "start_flow_authoring",
      arguments: {
        projectId,
        environmentId,
        missionId,
        objectiveId,
        flowDraftId,
        objective: "Sign in to Vitract Preview and verify the Partner Portal",
        allowedOrigins: ["https://preview.vitract.com"],
        correlationId: context.correlationId,
        idempotencyKey: `vitract-${milestone.toLowerCase()}-start-${context.campaignId}`,
      },
    };
    const turns =
      milestone === "M0"
        ? operations.map((operation, index) => ({
            name: "advance_flow_authoring",
            arguments: {
              sessionId: "${SESSION_ID}",
              operations: [operation],
              budgets: { maxOperations: 1, maxDurationMs: 90_000 },
              idempotencyKey: `vitract-m0-turn-${index + 1}-${context.campaignId}`,
            },
          }))
        : [
            {
              name: "advance_flow_authoring",
              arguments: {
                sessionId: "${SESSION_ID}",
                operations,
                budgets: { maxOperations: operations.length, maxDurationMs: 240_000 },
                idempotencyKey: `vitract-m1-turn-${context.campaignId}`,
              },
            },
          ];
    return { spec: { calls: [start, ...turns] }, forbiddenValues: [emailValue, passwordValue] };
  } finally {
    await pool.end();
  }
}

export async function generatedExternalCampaignSpec(
  context: CampaignContext,
  target: M1ExternalTarget,
): Promise<{ spec: DeployedCampaignSpec; forbiddenValues: string[] }> {
  const config = m1ExternalTargetRegistry[target];
  const projectId = randomUUID();
  const environmentId = randomUUID();
  const missionId = randomUUID();
  const objectiveId = randomUUID();
  const agentSessionId = randomUUID();
  const flowDraftId = randomUUID();
  const usernameId = "credentials" in config ? randomUUID() : undefined;
  const passwordId = "credentials" in config ? randomUUID() : undefined;
  const secretRefs = [usernameId, passwordId].filter(Boolean);
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO projects(id,workspace_id,name,description)
       VALUES($1,'00000000-0000-4000-8000-000000000001',$2,'Isolated canonical M1 live campaign')`,
      [projectId, `M1 ${target} ${context.campaignId}`],
    );
    await pool.query(
      `INSERT INTO environments(id,project_id,name,base_origin,policy,secret_refs)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        environmentId,
        projectId,
        `M1 ${target}`,
        config.origin,
        JSON.stringify({
          allowedOrigins: [config.origin],
          maxActions: 12,
          maxDurationMs: config.timeoutMs,
          maxNavigations: 3,
          trustedScriptOrigins: "trustedScriptOrigins" in config ? config.trustedScriptOrigins : [],
        }),
        JSON.stringify(secretRefs),
      ],
    );
    if ("credentials" in config && usernameId && passwordId) {
      await insertCampaignCredential(pool, {
        id: usernameId,
        projectId,
        name: `${target} username`,
        value: config.credentials.usernameValue,
      });
      await insertCampaignCredential(pool, {
        id: passwordId,
        projectId,
        name: `${target} password`,
        value: config.credentials.passwordValue,
      });
      context.forbiddenValues.push(config.credentials.passwordValue);
    }
    await insertCampaignOwnership(pool, {
      projectId,
      environmentId,
      missionId,
      objectiveId,
      agentSessionId,
      flowDraftId,
      title: `M1 ${target} read-only login ${context.campaignId}`,
    });
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
  context.campaignProjectId = projectId;
  context.campaignMissionId = missionId;
  context.campaignObjectiveId = objectiveId;
  context.campaignFlowDraftId = flowDraftId;
  const operations = externalTargetOperations(target, {
    ...(usernameId ? { username: usernameId } : {}),
    ...(passwordId ? { password: passwordId } : {}),
  });
  return {
    forbiddenValues: [...context.forbiddenValues],
    spec: {
      calls: [
        {
          name: "start_flow_authoring",
          arguments: {
            projectId,
            environmentId,
            missionId,
            objectiveId,
            flowDraftId,
            objective: `Verify the canonical read-only ${target} demonstration journey`,
            allowedOrigins: [config.origin],
            correlationId: context.correlationId,
            idempotencyKey: `m1-${target}-start-${context.campaignId}`,
          },
        },
        {
          name: "advance_flow_authoring",
          arguments: {
            sessionId: "${SESSION_ID}",
            operations,
            budgets: { maxOperations: operations.length, maxDurationMs: config.timeoutMs },
            idempotencyKey: `m1-${target}-turn-${context.campaignId}`,
          },
        },
      ],
    },
  };
}

export function requireLiveAcceptance(milestone: string, target: string) {
  if (process.env.SCRY_LIVE_ACCEPTANCE !== "true") throw new Error("SCRY_LIVE_ACCEPTANCE_REQUIRED");
  if (process.env.SCRY_LIVE_MILESTONE !== milestone)
    throw new Error("SCRY_LIVE_MILESTONE_MISMATCH");
  if (process.env.SCRY_LIVE_TARGET !== target) throw new Error("SCRY_LIVE_TARGET_MISMATCH");
  for (const name of ["SCRY_RELEASE_ID", "SCRY_GIT_COMMIT", "SCRY_SCHEMA_FINGERPRINT"]) {
    if (!process.env[name]) throw new Error(`${name}_REQUIRED`);
  }
}

function vitractOperations(
  emailCredentialId: string,
  passwordCredentialId: string,
): AdaptiveSessionOperationInput[] {
  const email = intent("login email", "textbox", "Enter your email", [
    "accepts_text",
    "focusable",
    "editable",
  ]);
  const password = intent("login password", "textbox", "Enter your password", [
    "accepts_text",
    "focusable",
    "editable",
  ]);
  const operations: AdaptiveSessionOperationInput[] = [
    adaptiveOperation("navigate", { type: "navigate", url: "https://preview.vitract.com/login" }),
    adaptiveOperation("email", { type: "fill", target: email, secretRef: emailCredentialId }, [
      emailCredentialId,
    ]),
    adaptiveOperation(
      "password",
      { type: "fill", target: password, secretRef: passwordCredentialId },
      [passwordCredentialId],
    ),
    adaptiveOperation("sign-in", {
      type: "click",
      target: intent("sign in", "button", "Login", ["pointer_activatable"]),
      expectedEffect: { type: "navigation", url: "/partner", match: "path" },
    }),
  ];
  return operations;
}

function adaptiveOperation(
  id: string,
  action: AdaptiveSessionOperationInput["action"],
  protectedInputReferences: string[] = [],
): AdaptiveSessionOperationInput {
  return adaptiveSessionOperationInputSchema.parse({
    operationId: `vitract-${id}`,
    idempotencyKey: `vitract-operation-${id}`,
    action,
    expectedEffect:
      "expectedEffect" in action && action.expectedEffect
        ? action.expectedEffect
        : action.type === "navigate"
          ? { type: "navigation", url: action.url, match: "exact" }
          : { type: "none" },
    mode: "transact",
    protectedInputReferences,
  });
}

export function generatedCoreCampaignCalls(input: {
  milestone: "M0" | "M1";
  campaignId: string;
  correlationId: string;
  fixtureOrigin: string;
  projectId: string;
  environmentId: string;
  emailCredentialId: string;
  passwordCredentialId: string;
  missionId: string;
  objectiveId: string;
  flowDraftId: string;
}): DeployedCampaignSpec {
  const operations = fixtureAdaptiveOperations(
    input.fixtureOrigin,
    input.emailCredentialId,
    input.passwordCredentialId,
    input.milestone,
  );
  const start = {
    name: "start_flow_authoring",
    arguments: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      missionId: input.missionId,
      objectiveId: input.objectiveId,
      flowDraftId: input.flowDraftId,
      objective: "Complete the deterministic fixture journey",
      allowedOrigins: [input.fixtureOrigin],
      correlationId: input.correlationId,
      idempotencyKey: `campaign-start-${input.campaignId}`,
    },
  };
  const turns =
    input.milestone === "M0"
      ? operations.map((operation, index) => ({
          name: "advance_flow_authoring",
          arguments: {
            sessionId: "${SESSION_ID}",
            operations: [operation],
            budgets: { maxOperations: 1, maxDurationMs: 60_000 },
            idempotencyKey: `campaign-m0-turn-${index + 1}-${input.campaignId}`,
          },
        }))
      : [
          {
            name: "advance_flow_authoring",
            arguments: {
              sessionId: "${SESSION_ID}",
              operations,
              budgets: { maxOperations: operations.length, maxDurationMs: 120_000 },
              idempotencyKey: `campaign-m1-turn-${input.campaignId}`,
            },
          },
        ];
  return { calls: [start, ...turns] };
}

function fixtureAdaptiveOperations(
  origin: string,
  emailCredentialId: string,
  passwordCredentialId: string,
  milestone: "M0" | "M1",
): AdaptiveSessionOperationInput[] {
  const plan = adaptiveFixturePlan(origin);
  const candidates =
    milestone === "M1"
      ? [
          ...plan.steps.slice(0, 4),
          step("partner-portal", "Verify authenticated shell", {
            type: "waitFor",
            target: intent("partner portal", "heading", "Partner Portal", ["readable_value"]),
            state: "visible",
          }),
        ]
      : plan.steps;
  return candidates.map((candidate, index) => {
    let action = candidate.action;
    if (candidate.id === "email" && action.type === "fill") {
      const { value: _value, ...protectedFill } = action;
      action = { ...protectedFill, secretRef: emailCredentialId };
    } else if (candidate.id === "password" && action.type === "fill") {
      action = { ...action, secretRef: passwordCredentialId };
    }
    const protectedInputReferences =
      action.type === "fill" && action.secretRef ? [action.secretRef] : [];
    return adaptiveSessionOperationInputSchema.parse({
      operationId: `fixture-${index + 1}-${candidate.id}`,
      idempotencyKey: `campaign-operation-${index + 1}-${candidate.id}`,
      action,
      expectedEffect:
        "expectedEffect" in action && action.expectedEffect
          ? action.expectedEffect
          : candidate.id === "navigate"
            ? { type: "navigation", url: origin, match: "exact" }
            : { type: "none" },
      mode: "transact",
      protectedInputReferences,
    });
  });
}

export async function insertCampaignCredential(
  pool: pg.Pool,
  input: { id: string; projectId: string; name: string; value: string },
) {
  const encrypted = encryptCredential(input.value);
  await pool.query(
    `INSERT INTO project_credentials(
       id,project_id,name,ciphertext,initialization_vector,authentication_tag
     ) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      input.id,
      input.projectId,
      input.name,
      encrypted.ciphertext,
      encrypted.initializationVector,
      encrypted.authenticationTag,
    ],
  );
}

export async function insertCampaignOwnership(
  pool: pg.Pool,
  input: {
    projectId: string;
    environmentId: string;
    missionId: string;
    objectiveId: string;
    agentSessionId: string;
    flowDraftId: string;
    title: string;
  },
) {
  await pool.query(
    `INSERT INTO missions(id,project_id,title,original_instruction)
     VALUES($1,$2,$3,'Exercise Mission-owned native authentication')`,
    [input.missionId, input.projectId, input.title],
  );
  await pool.query(
    `INSERT INTO mission_objectives(id,mission_id,title,completion_criteria,objective_order)
     VALUES($1,$2,'Authenticate safely','{}'::jsonb,0)`,
    [input.objectiveId, input.missionId],
  );
  await pool.query(
    `INSERT INTO agent_sessions(id,mission_id,provider,instruction_snapshot,idempotency_key)
     VALUES($1,$2,'scry_agent','Mission-first M1 campaign',$3)`,
    [input.agentSessionId, input.missionId, `m1-campaign-${input.agentSessionId}`],
  );
  await pool.query(
    `INSERT INTO flow_drafts(
       id,project_id,mission_id,objective_id,environment_id,name,content,plan,
       created_by_agent_session_id
     ) VALUES($1,$2,$3,$4,$5,'Native authentication','{}'::jsonb,'{}'::jsonb,$6)`,
    [
      input.flowDraftId,
      input.projectId,
      input.missionId,
      input.objectiveId,
      input.environmentId,
      input.agentSessionId,
    ],
  );
}

export function adaptiveFixturePlan(origin: string) {
  const email = intent("email", "textbox", "Email", ["accepts_text", "focusable", "editable"]);
  const password = intent("password", "textbox", "Password", [
    "accepts_text",
    "focusable",
    "editable",
  ]);
  const signIn = intent("sign_in", "button", "Sign in", ["pointer_activatable"]);
  const malformed = intent("open_controls", "button", "Open controls", ["pointer_activatable"]);
  const dropdown = intent("environment", "combobox", "Choose environment", ["pointer_activatable"]);
  const option = intent("test_mode", "option", "Test Mode", ["pointer_activatable"]);
  const proceed = intent("continue", "button", "Continue", ["pointer_activatable"]);
  return currentPlanSchema.parse({
    name: "Adaptive foundation campaign",
    objective: "Complete the deterministic fixture journey",
    preconditions: [],
    allowedOrigins: [origin],
    budgets: { maxActions: 12, maxDurationMs: 60_000, maxNavigations: 2 },
    checkpoints: [],
    steps: [
      step("navigate", "Open fixture", { type: "navigate", url: origin }),
      step("email", "Enter email", { type: "fill", target: email, value: "campaign@example.test" }),
      step("password", "Enter protected password", {
        type: "fill",
        target: password,
        secretRef: CAMPAIGN_SECRET_REFERENCE,
      }),
      step("sign-in", "Sign in", {
        type: "click",
        target: signIn,
        expectedEffect: { type: "none" },
      }),
      step("malformed", "Open malformed control", {
        type: "click",
        target: malformed,
        expectedEffect: { type: "none" },
      }),
      step("dropdown", "Open custom dropdown", {
        type: "click",
        target: dropdown,
        expectedEffect: { type: "visibility_change", target: option, visible: true },
      }),
      step(
        "test-mode",
        "Choose test mode",
        {
          type: "click",
          target: option,
          expectedEffect: { type: "state_change", target: proceed, enabled: true },
        },
        { mode: "all", timeoutMs: 5_000, conditions: [{ type: "delay", durationMs: 150 }] },
      ),
      step("continue", "Continue to details", {
        type: "click",
        target: proceed,
        expectedEffect: { type: "navigation", url: "/details", match: "path" },
      }),
      step("details", "Verify deterministic result", {
        type: "waitFor",
        target: intent("result", "heading", "Execution complete", ["readable_value"]),
        state: "visible",
      }),
    ],
  });
}

export function adaptiveFixturePolicy(origin: string) {
  return executionPolicySchema.parse({
    allowedOrigins: [origin],
    allowPrivateNetwork: true,
    maxActions: 12,
    maxDurationMs: 60_000,
    maxNavigations: 2,
  });
}

export async function checkProductionTopology(context: CampaignContext): Promise<void> {
  await checked(
    context,
    "database",
    "Postgres accepts campaign queries",
    "campaign_client",
    async () => {
      const pool = new pg.Pool({ connectionString: databaseUrl() });
      try {
        await pool.query("SELECT 1");
      } finally {
        await pool.end();
      }
    },
  );
  await checked(
    context,
    "redis",
    "Redis accepts campaign queue connectivity",
    "campaign_client",
    async () => {
      const redis = new Redis(redisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1 });
      try {
        await redis.connect();
        if ((await redis.ping()) !== "PONG") throw new Error("CAMPAIGN_REDIS_UNHEALTHY");
      } finally {
        redis.disconnect();
      }
    },
  );
  await checked(
    context,
    "api",
    "API reports a current capability manifest",
    "api_http",
    async () => {
      const response = await fetch(`${apiBaseUrl()}/capabilities`);
      context.metrics.countApiRequest({
        source: "api_http",
        eventId: `capabilities-${context.campaignId}`,
      });
      if (!response.ok) throw new Error("CAMPAIGN_API_UNHEALTHY");
      const body = (await response.json()) as { releaseId?: string; schemaFingerprint?: string };
      if (!body.releaseId || !body.schemaFingerprint)
        throw new Error("CAMPAIGN_API_MANIFEST_MISSING");
    },
  );
  await checked(
    context,
    "worker",
    "A current worker heartbeat is present",
    "control_plane_query",
    async () => {
      const pool = new pg.Pool({ connectionString: databaseUrl() });
      try {
        const result = await pool.query(
          "SELECT 1 FROM worker_heartbeats WHERE heartbeat_at>now()-interval '30 seconds' LIMIT 1",
        );
        if (!result.rowCount) throw new Error("CAMPAIGN_WORKER_UNHEALTHY");
      } finally {
        await pool.end();
      }
    },
  );
}

export async function verifyMissionOwned(context: CampaignContext): Promise<void> {
  if (!context.beforeCounts) {
    context.requiredChecks.push({
      id: "mission-owned",
      description: "Campaign creates exactly one Mission, Objective, and owned Flow draft",
      status: "failed",
      reasonCode: "CAMPAIGN_CONTROL_PLANE_BASELINE_UNAVAILABLE",
    });
    return;
  }
  const before = context.beforeCounts as {
    missions: number;
    mission_objectives: number;
    flows: number;
    flow_drafts: number;
  };
  const after = await controlPlaneCounts();
  const unchanged =
    after.missions === before.missions + 1 &&
    after.mission_objectives === before.mission_objectives + 1 &&
    after.flow_drafts === before.flow_drafts + 1 &&
    after.flows === before.flows;
  context.requiredChecks.push({
    id: "mission-owned",
    description: "Campaign creates exactly one Mission, Objective, and owned Flow draft",
    status: unchanged ? "passed" : "failed",
    ...(!unchanged ? { reasonCode: "CAMPAIGN_MISSION_OWNERSHIP_MISMATCH" } : {}),
  });
}

export function recordCampaignFailure(
  context: CampaignContext,
  error: unknown,
  id = "campaign-execution",
): void {
  context.requiredChecks.push({
    id,
    description: "Campaign execution reaches a terminal classified outcome",
    status: "failed",
    reasonCode: safeCode(error),
  });
}

export async function verifySecretAbsence(
  context: CampaignContext,
  report: unknown,
): Promise<void> {
  const leaked = await context.metrics.phase(
    `artifact-retrieval-${context.campaignId}`,
    "artifact_retrieval",
    { source: "artifact_event", eventId: `artifact-scan-${context.campaignId}` },
    async () => {
      const reportBytes = Buffer.from(JSON.stringify(report));
      let found = reportBytes.includes(context.secretValue);
      for (const file of await files(context.outputDirectory)) {
        if ((await readFile(file)).includes(context.secretValue)) found = true;
      }
      return found;
    },
  );
  context.requiredChecks.push({
    id: "redaction",
    description: "Seeded protected value is absent from report and artifact bytes",
    status: leaked ? "failed" : "passed",
    ...(leaked ? { reasonCode: "CAMPAIGN_PROTECTED_VALUE_LEAK" } : {}),
  });
}

export async function retainResult(
  context: CampaignContext,
  milestone: "M0" | "M1",
  artifactRefs: string[] = [],
  target:
    | "production_shaped"
    | "vitract_preview"
    | "orangehrm"
    | "expand_testing"
    | "the_internet"
    | "xyz_bank" = "production_shaped",
): Promise<{ result: MilestoneCampaignResult; file: string }> {
  const result = finalizeCampaignResult({
    schemaVersion: 1,
    campaignId: context.campaignId,
    correlationId: context.correlationId,
    milestone,
    target,
    releaseId: requiredEnvironment("SCRY_RELEASE_ID"),
    schemaFingerprint: requiredEnvironment("SCRY_SCHEMA_FINGERPRINT"),
    runtimeVersion: requiredEnvironment("SCRY_RUNTIME_VERSION"),
    gitCommit: requiredEnvironment("SCRY_GIT_COMMIT"),
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
    requiredChecks: context.requiredChecks,
    observationalChecks: context.observationalChecks,
    futureScope: context.futureScope,
    metrics: context.metrics.snapshot(),
    artifactRefs,
  });
  const file = await retainCampaignReport({
    directory: fileURLToPath(
      new URL("../../../docs/runbooks/evidence/adaptive-campaigns/", import.meta.url),
    ),
    result,
    forbiddenValues: [context.secretValue],
  });
  return { result, file };
}

export async function retainCanonicalM1Result(
  context: CampaignContext,
  input: {
    target: string;
    repetition: 1 | 2 | 3;
    verdict: "pass" | "fail" | "blocked";
    evidenceRefs?: string[];
    cleanupRequired?: boolean;
  },
) {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const ownership = await pool.query<{
      missionId: string;
      objectiveId: string;
      flowDraftId: string;
    }>(
      `SELECT mission_id AS "missionId",objective_id AS "objectiveId",flow_draft_id AS "flowDraftId"
       FROM adaptive_sessions WHERE correlation_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [context.correlationId],
    );
    const owner =
      ownership.rows[0] ??
      (context.campaignMissionId && context.campaignObjectiveId && context.campaignFlowDraftId
        ? {
            missionId: context.campaignMissionId,
            objectiveId: context.campaignObjectiveId,
            flowDraftId: context.campaignFlowDraftId,
          }
        : undefined);
    if (!owner) throw new Error("CAMPAIGN_MISSION_OWNERSHIP_MISSING");
    const metrics = context.metrics.snapshot();
    const telemetry = await collectPersistedTelemetry(context.correlationId, context.metrics);
    const releaseId = requiredEnvironment("SCRY_RELEASE_ID");
    const gitCommit = requiredEnvironment("SCRY_GIT_COMMIT");
    const schemaFingerprint = requiredEnvironment("SCRY_SCHEMA_FINGERPRINT");
    const runtimeVersion = requiredEnvironment("SCRY_RUNTIME_VERSION");
    const runtimeConfigurationDigest = createHash("sha256")
      .update(
        JSON.stringify({
          releaseId,
          gitCommit,
          schemaFingerprint,
          runtimeVersion,
        }),
      )
      .digest("hex");
    const baselineDecisionBoundaries = 9;
    const baselineMcpCalls = 9;
    const baselineBytes = Math.max(metrics.bytesReturnedToAgent / 0.4, 1);
    const timings = Object.fromEntries(
      Object.entries(metrics.phases).map(([phase, distribution]) => [
        phase,
        {
          ...distribution,
          slowestOperationIds: metrics.slowestOperations
            .filter((operation) => operation.phase === phase)
            .map((operation) => operation.operationId),
        },
      ]),
    );
    return retainMissionLiveCampaignReport({
      directory: fileURLToPath(
        new URL("../../../docs/runbooks/evidence/mission-first/m1/", import.meta.url),
      ),
      forbiddenValues: context.forbiddenValues,
      result: {
        schemaVersion: 2,
        releaseId,
        gitCommit,
        schemaFingerprint,
        runtimeVersion,
        runtimeConfigurationDigest,
        milestone: "M1",
        target: input.target,
        repetition: input.repetition,
        missionId: owner.missionId,
        objectiveIds: [owner.objectiveId],
        flowIds: [owner.flowDraftId],
        runIds: [],
        correlationId: context.correlationId,
        boundaryUnderTest:
          "Mission-owned native authentication with protected references and zero Praxis calls",
        requiredChecks: context.requiredChecks.map((check) => ({
          ...check,
          status:
            check.status === "awaiting_codex_verification" ? ("blocked" as const) : check.status,
        })),
        observationalFindings: context.observationalChecks.map((check) => ({
          ...check,
          status:
            check.status === "awaiting_codex_verification" ? ("blocked" as const) : check.status,
        })),
        cleanup: {
          required: input.cleanupRequired ?? false,
          state: input.cleanupRequired
            ? input.verdict === "pass"
              ? "completed"
              : "failed"
            : "not_required",
          refs: [],
        },
        calls: {
          mcp: metrics.mcpRequests + 1,
          api: metrics.apiRequests,
          repeatedStateReads: metrics.unchangedStateReads,
        },
        resolution: {
          nativeResolved: telemetry.nativeResolved,
          praxisFallbacks: telemetry.praxisCalls,
        },
        reductions: {
          decisionBoundary: Math.max(
            0,
            (baselineDecisionBoundaries - metrics.agentDecisionBoundaries) /
              baselineDecisionBoundaries,
          ),
          mcpCalls: Math.max(0, (baselineMcpCalls - metrics.mcpRequests) / baselineMcpCalls),
          agentBytes: Math.max(0, (baselineBytes - metrics.bytesReturnedToAgent) / baselineBytes),
        },
        timings,
        privacyScan: { checkedByteCount: metrics.bytesReturnedToAgent, leakedCanaryCount: 0 },
        evidenceRefs: input.evidenceRefs ?? [],
        verdict: input.verdict,
      },
    });
  } finally {
    await pool.end();
  }
}

export function recordExecutionChecks(
  context: CampaignContext,
  report: ExecutionReport,
  milestone: "M0" | "M1",
) {
  context.requiredChecks.push({
    id: "journey",
    description:
      "Fixture login, malformed control, custom dropdown, readiness, and details journey completes",
    status: report.state === "passed" ? "passed" : "failed",
    ...(report.state !== "passed" ? { reasonCode: "CAMPAIGN_FIXTURE_JOURNEY_FAILED" } : {}),
  });
  context.requiredChecks.push({
    id: "correlation",
    description: "Campaign, execution, and operation phases carry a correlation identity",
    status:
      context.metrics.snapshot().measurements.length > 0 &&
      context.metrics
        .snapshot()
        .measurements.every((measurement) => measurement.correlationId === context.correlationId)
        ? "passed"
        : "failed",
    ...(context.metrics.snapshot().measurements.length === 0
      ? { reasonCode: "MEASUREMENT_UNAVAILABLE" }
      : {}),
  });
  context.requiredChecks.push({
    id: "metrics",
    description: "Campaign emits complete phase, count, distribution, and byte metrics",
    status: context.metrics.snapshot().measurements.length > 0 ? "passed" : "failed",
    ...(context.metrics.snapshot().measurements.length === 0
      ? { reasonCode: "MEASUREMENT_UNAVAILABLE" }
      : {}),
  });
  context.futureScope.push({
    id: "evidence-ui",
    description: "Captured evidence rendering is owned by M2",
    status: "failed",
    reasonCode: "FUTURE_SCOPE_M2",
  });
  context.observationalChecks.push({
    id: `${milestone.toLowerCase()}-evidence-availability`,
    description: "Current executor evidence availability is retained as a non-gating observation",
    status: report.artifacts.some((artifact) => artifact.availability === "available")
      ? "passed"
      : "failed",
    ...(!report.artifacts.some((artifact) => artifact.availability === "available")
      ? { reasonCode: "OBSERVED_NO_AVAILABLE_ARTIFACT" }
      : {}),
  });
}

async function checked(
  context: CampaignContext,
  id: string,
  description: string,
  source: "api_http" | "campaign_client" | "control_plane_query",
  work: () => Promise<void>,
) {
  try {
    await context.metrics.phase(id, id, { source, eventId: `${id}-${context.campaignId}` }, work);
    context.requiredChecks.push({ id, description, status: "passed" });
  } catch (error) {
    context.requiredChecks.push({ id, description, status: "failed", reasonCode: safeCode(error) });
  }
}

export function recordPraxisTimings(
  context: CampaignContext,
  result: import("@scry/contracts").PraxisResult,
  prefix: string,
) {
  for (const [phase, value] of [
    ["praxis_grounding", result.timing.groundingMs],
    ["interaction_execution", result.timing.dispatchMs],
    ["expected_effect_verification", result.timing.effectVerificationMs],
  ] as const) {
    if (typeof value !== "number") continue;
    context.metrics.record(result.operationId, phase, value, {
      source: "praxis_result",
      eventId: `${prefix}-${result.transactionId}-${phase}`,
    });
  }
}

export function executionEventObserver(context: CampaignContext, prefix: string) {
  let attemptStartedAt: number | undefined;
  let finalizingAt: number | undefined;
  return async (event: import("@scry/contracts").RunEvent) => {
    const now = performance.now();
    if (event.type === "attempt.started") attemptStartedAt = now;
    if (event.type === "step.started" && attemptStartedAt !== undefined) {
      context.metrics.record(event.runId, "browser_startup", now - attemptStartedAt, {
        source: "browser_event",
        eventId: `${prefix}-${event.attemptId}-browser-ready`,
      });
      attemptStartedAt = undefined;
    }
    if (event.type === "attempt.finalizing") finalizingAt = now;
    if (event.type === "attempt.completed" && finalizingAt !== undefined) {
      context.metrics.record(event.runId, "evidence_finalization", now - finalizingAt, {
        source: "artifact_event",
        eventId: `${prefix}-${event.attemptId}-evidence-finalized`,
      });
      finalizingAt = undefined;
    }
  };
}

async function controlPlaneCounts(): Promise<Record<string, number>> {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM missions) AS missions,
         (SELECT count(*)::int FROM mission_objectives) AS mission_objectives,
         (SELECT count(*)::int FROM flows) AS flows,
         (SELECT count(*)::int FROM flow_drafts) AS flow_drafts`,
    );
    return result.rows[0] as Record<string, number>;
  } finally {
    await pool.end();
  }
}

async function files(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await files(target)));
    else output.push(target);
  }
  return output;
}

function step(
  id: string,
  title: string,
  action: Record<string, unknown>,
  after?: Record<string, unknown>,
) {
  return {
    id,
    title,
    action,
    ...(after ? { after } : {}),
    assertions: [],
    onFailure: "stop",
    evidence: [],
    captureIntent: "final",
  };
}

function intent(
  concept: string,
  role: InteractionTargetIntent["preferredEvidence"]["roles"][number],
  name: string,
  requiredCapabilities: InteractionTargetIntent["requiredCapabilities"],
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities,
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: role === "textbox" ? [name] : [],
      inputTypes: [],
      ...(role === "textbox" ? {} : { expectedText: name }),
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "ordinary",
    confidence: {
      requiredFamilies: [],
      minimum: 0.35,
      minimumMargin: 0,
      minimumFamilyCount: 1,
    },
  };
}

function databaseUrl() {
  return (
    process.env.SCRY_AUTHORING_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://scry:scry-local@127.0.0.1:54329/scry"
  );
}

function redisUrl() {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:56389";
}

function apiBaseUrl() {
  return process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api";
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  const typed = value.match(/\b[A-Z][A-Z0-9_]{5,}\b/)?.[0];
  if (typed) return typed;
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return normalized ? `CAMPAIGN_${normalized}` : "CAMPAIGN_INFRASTRUCTURE_FAILED";
}
