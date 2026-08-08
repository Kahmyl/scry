import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  CampaignMetricsCollector,
  finalizeCampaignResult,
  retainCampaignReport,
  startAdaptiveFixture,
  type CampaignCheck,
  type MilestoneCampaignResult,
} from "@scry/campaigns";
import {
  currentPlanSchema,
  executionPolicySchema,
  type InteractionTargetIntent,
} from "@scry/contracts";
import type { ExecutionReport } from "@scry/executor";
import { Redis } from "ioredis";
import pg from "pg";

export const CAMPAIGN_SECRET_REFERENCE = "11111111-1111-4111-8111-111111111111";

export type CampaignContext = {
  campaignId: string;
  correlationId: string;
  startedAt: string;
  fixture: Awaited<ReturnType<typeof startAdaptiveFixture>>;
  outputDirectory: string;
  metrics: CampaignMetricsCollector;
  secretValue: string;
  beforeCounts?: Record<string, number>;
  requiredChecks: CampaignCheck[];
  observationalChecks: CampaignCheck[];
  futureScope: CampaignCheck[];
};

export async function createCampaignContext(): Promise<CampaignContext> {
  const campaignId = randomUUID();
  const correlationId = randomUUID();
  let fixture: Awaited<ReturnType<typeof startAdaptiveFixture>>;
  let fixtureFailure: unknown;
  try {
    fixture = await startAdaptiveFixture();
  } catch (error) {
    fixtureFailure = error;
    fixture = {
      origin: "http://127.0.0.1:1",
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
    secretValue: `campaign-canary-${randomUUID()}`,
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
  await context.fixture.close();
  await rm(context.outputDirectory, { recursive: true, force: true });
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
        target: intent("result", "heading", "Execution complete", []),
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

export async function verifyMissionless(context: CampaignContext): Promise<void> {
  if (!context.beforeCounts) {
    context.requiredChecks.push({
      id: "missionless",
      description: "Campaign creates no Mission, Objective, Flow, or Flow draft records",
      status: "failed",
      reasonCode: "CAMPAIGN_CONTROL_PLANE_BASELINE_UNAVAILABLE",
    });
    return;
  }
  const before = context.beforeCounts;
  const after = await controlPlaneCounts();
  const unchanged = ["missions", "mission_objectives", "flows", "flow_drafts"].every(
    (table) => after[table] === before[table],
  );
  context.requiredChecks.push({
    id: "missionless",
    description: "Campaign creates no Mission, Objective, Flow, or Flow draft records",
    status: unchanged ? "passed" : "failed",
    ...(!unchanged ? { reasonCode: "CAMPAIGN_CONTROL_PLANE_RECORD_CREATED" } : {}),
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
  target: "production_shaped" | "vitract_preview" = "production_shaped",
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
      placeholders: [],
      inputTypes: [],
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
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? value : "CAMPAIGN_INFRASTRUCTURE_FAILED";
}
