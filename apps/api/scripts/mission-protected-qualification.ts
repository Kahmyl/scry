import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { MissionAuthoringIntent } from "@scry/contracts";
import pg from "pg";

import { closeCampaignContext, createCampaignContext } from "./adaptive-campaign-support.js";
import {
  findAdaptiveSessionId,
  initializeMcp,
  rejectToolError,
} from "./deployed-adaptive-campaign.js";
import { provisionM2Campaign } from "./mission-live-m2-support.js";

type Scenario = "readonlyInput" | "textOutput" | "interruptedAcquisition";
type SafeTurn = {
  turnId: string;
  state: "completed" | "decision_required" | "pending";
  completed: Array<{
    generatedReferences?: Array<{
      reference: string;
      classification: "public" | "protected";
      credentialId?: string;
      valueId?: string;
      scope: "project" | "run";
    }>;
  }>;
  timings?: Record<string, number>;
  decisionBoundary?: { type?: string; reasonCode?: string } | null;
};

const context = await createCampaignContext();
const mcp = await initializeMcp();
const openSessions = new Set<string>();
const callLatencies: Array<{ scenario: Scenario; call: string; durationMs: number }> = [];
let pool: pg.Pool | undefined;

try {
  const provisioned = await provisionM2Campaign(context, {
    target: "protected-qualification",
    mission: "Controlled protected-output qualification",
    origin: context.fixture.origin,
    ...(process.env.SCRY_CAMPAIGN_WORKSPACE_ID
      ? { workspaceId: process.env.SCRY_CAMPAIGN_WORKSPACE_ID }
      : {}),
    maxActions: 12,
    maxDurationMs: 60_000,
    maxNavigations: 4,
    flows: [
      qualificationFlow("readonlyInput", "readonly input acquisition"),
      qualificationFlow("textOutput", "text output acquisition"),
      qualificationFlow("interruptedAcquisition", "interrupted acquisition"),
    ],
  });
  pool = new pg.Pool({ connectionString: databaseUrl() });

  const results = [];
  for (const scenario of ["readonlyInput", "textOutput", "interruptedAcquisition"] as const) {
    results.push(await runScenario(scenario, provisioned.ownership));
  }

  const snapshot = context.fixture.snapshot();
  const dispatches = snapshot.protectedDispatches;
  assert(dispatches.readonlyInput === 1, "QUALIFICATION_READONLY_DISPATCH_COUNT_INVALID");
  assert(dispatches.textOutput === 1, "QUALIFICATION_TEXT_DISPATCH_COUNT_INVALID");
  assert(
    dispatches.interruptedAcquisition === 1,
    "QUALIFICATION_INTERRUPTED_DISPATCH_COUNT_INVALID",
  );

  const serialized = JSON.stringify(results);
  assert(!serialized.includes(context.secretValue), "QUALIFICATION_PROTECTED_VALUE_LEAK");
  assert(
    !/(selector|xpath|runtimeId|fingerprint|browserHandle|outerHTML|innerHTML|clipboard)/i.test(
      serialized,
    ),
    "QUALIFICATION_FORBIDDEN_IMPLEMENTATION_FIELD",
  );

  await pool.query(
    `UPDATE project_credentials SET security_status='revoked',updated_at=now()
       WHERE project_id=$1 AND origin_protected_operation_id IS NOT NULL AND security_status='active'`,
    [provisioned.ownership.projectId],
  );

  process.stdout.write(`${JSON.stringify({
    outcome: "CONTROLLED_PROTECTED_QUALIFICATION_PASSED",
    projectId: provisioned.ownership.projectId,
    environmentId: provisioned.ownership.environmentId,
    campaigns: results,
    dispatches,
    latency: summarizeLatency(callLatencies),
    cleanup: {
      completedSessionsClosed: true,
      interruptedRecoveryRetained: true,
      generatedCredentialsRevoked: true,
    },
    privacy: { protectedPlaintextObserved: false, forbiddenImplementationFieldsObserved: false },
  })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    outcome: "CONTROLLED_PROTECTED_QUALIFICATION_FAILED",
    reasonCode: safeCode(error),
    dispatches: context.fixture.snapshot().protectedDispatches,
    latency: summarizeLatency(callLatencies),
  })}\n`);
  process.exitCode = 1;
} finally {
  for (const sessionId of openSessions) await closeSession(sessionId).catch(() => undefined);
  await mcp.close();
  await pool?.end();
  await closeCampaignContext(context);
}

async function runScenario(
  scenario: Scenario,
  ownership: Awaited<ReturnType<typeof provisionM2Campaign>>["ownership"],
) {
  const flow = ownership.flows[scenario]!;
  const path = scenario === "readonlyInput"
    ? "/protected/readonly-input"
    : scenario === "textOutput"
      ? "/protected/text-output"
      : "/protected/interrupted-acquisition";
  const pageUrl = `${context.fixture.origin}${path}`;
  const started = await call(scenario, "start", {
    name: "start_flow_authoring",
    arguments: {
      projectId: ownership.projectId,
      environmentId: ownership.environmentId,
      missionId: ownership.missionId,
      agentSessionId: ownership.agentSessionId,
      objectiveId: flow.objectiveId,
      flowDraftId: flow.flowDraftId,
      objective: `Qualify ${scenario} protected acquisition`,
      allowedOrigins: [context.fixture.origin],
      correlationId: randomUUID(),
      initialProtectedReferenceIds: [],
      turnBudgets: { maxOperations: 2, maxDurationMs: 15_000 },
      idempotencyKey: `protected-qualification-start-${scenario}-${context.campaignId}`,
    },
  });
  const sessionId = findAdaptiveSessionId(started);
  assert(sessionId, "QUALIFICATION_SESSION_ID_MISSING");
  openSessions.add(sessionId);

  const visitIntentId = `visit-${scenario}`;
  const visited = await call(scenario, "navigate", {
    name: "advance_flow_authoring",
    arguments: {
      sessionId,
      kind: "intents",
      intents: [navigateIntent(visitIntentId, flow.objectiveId, flow.flowDraftId, pageUrl)],
      budgets: { maxOperations: 1, maxDurationMs: 10_000 },
      idempotencyKey: `protected-qualification-navigate-${scenario}-${context.campaignId}`,
    },
  });
  assert(findTurn(visited).state === "completed", "QUALIFICATION_NAVIGATION_FAILED");

  const preparationIntentIds = [visitIntentId];
  if (scenario !== "interruptedAcquisition") {
    const fillIntentId = `prepare-name-${scenario}`;
    const selectIntentId = `prepare-environment-${scenario}`;
    const prepared = await call(scenario, "prepare", {
      name: "advance_flow_authoring",
      arguments: {
        sessionId,
        kind: "intents",
        intents: [
          preparationFillIntent(fillIntentId, flow.objectiveId, flow.flowDraftId),
          preparationSelectIntent(selectIntentId, flow.objectiveId, flow.flowDraftId),
        ],
        budgets: { maxOperations: 2, maxDurationMs: 15_000 },
        idempotencyKey: `protected-qualification-prepare-${scenario}-${context.campaignId}`,
      },
    });
    assert(findTurn(prepared).state === "completed", "QUALIFICATION_PREPARATION_FAILED");
    preparationIntentIds.push(fillIntentId, selectIntentId);
  }

  const acquisition = await call(scenario, "acquire", {
    name: "advance_flow_authoring",
    arguments: {
      sessionId,
      kind: "intents",
      intents: [acquisitionIntent({
        scenario,
        preparationIntentIds,
        objectiveId: flow.objectiveId,
        flowDraftId: flow.flowDraftId,
        authorizationId: flow.authorizationId!,
      })],
      budgets: { maxOperations: 1, maxDurationMs: 15_000 },
      idempotencyKey: `protected-qualification-acquire-${scenario}-${context.campaignId}`,
    },
  });
  let turn = findTurn(acquisition);
  assert(turn.state === "pending", "QUALIFICATION_FIRST_RESPONSE_NOT_PENDING");
  const initialTurnId = turn.turnId;
  let polls = 0;
  while (turn.state === "pending" && polls < 40) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    polls += 1;
    const continued = await call(scenario, "continue", {
      name: "advance_flow_authoring",
      arguments: {
        sessionId,
        kind: "continue",
        turnId: initialTurnId,
        budgets: { maxOperations: 1, maxDurationMs: 15_000 },
        idempotencyKey: `protected-qualification-continue-${scenario}-${polls}-${context.campaignId}`,
      },
    });
    turn = findTurn(continued);
  }
  assert(turn.state !== "pending", "QUALIFICATION_CONTINUATION_TIMEOUT");

  const operation = await operationProof(sessionId);
  if (scenario === "interruptedAcquisition") {
    assert(turn.state === "decision_required", "QUALIFICATION_INTERRUPTION_NOT_RECOVERABLE");
    assert(operation.dispatchState === "acknowledged", "QUALIFICATION_INTERRUPTION_NOT_DISPATCHED");
    assert(operation.persistenceState !== "committed", "QUALIFICATION_INTERRUPTION_PERSISTED_OUTPUT");
    assert(operation.persistedReferenceCount === 0, "QUALIFICATION_INTERRUPTION_REFERENCE_LEAK");
  } else {
    assert(turn.state === "completed", "QUALIFICATION_ACQUISITION_NOT_COMPLETED");
    assert(operation.state === "completed", "QUALIFICATION_OPERATION_NOT_COMPLETED");
    assert(operation.dispatchState === "acknowledged", "QUALIFICATION_MUTATION_NOT_ACKNOWLEDGED");
    assert(operation.persistenceState === "committed", "QUALIFICATION_OUTPUTS_NOT_COMMITTED");
    assert(operation.persistedReferenceCount === 2, "QUALIFICATION_OUTPUT_SET_INCOMPLETE");
    const references = turn.completed.flatMap((entry) => entry.generatedReferences ?? []);
    assert(references.length === 2, "QUALIFICATION_OPAQUE_REFERENCES_MISSING");
    assert(references.every((reference) => reference.credentialId || reference.valueId), "QUALIFICATION_REFERENCE_NOT_OPAQUE");

    const continuity = await call(scenario, "post_protected_observation", {
      name: "advance_flow_authoring",
      arguments: {
        sessionId,
        kind: "intents",
        intents: [postProtectedObservationIntent(
          `post-protected-${scenario}`,
          flow.objectiveId,
          flow.flowDraftId,
        )],
        budgets: { maxOperations: 1, maxDurationMs: 10_000 },
        idempotencyKey: `protected-qualification-post-protected-${scenario}-${context.campaignId}`,
      },
    });
    assert(findTurn(continuity).state === "completed", "QUALIFICATION_RETAINED_SESSION_AUTHORITY_LOST");
  }

  if (scenario !== "interruptedAcquisition") {
    await closeSession(sessionId);
    openSessions.delete(sessionId);
  }
  return {
    scenario,
    state: turn.state,
    polls,
    boundary: turn.decisionBoundary ?? null,
    operation,
    timings: turn.timings ?? {},
  };
}

function postProtectedObservationIntent(
  intentId: string,
  objectiveId: string,
  flowDraftId: string,
): MissionAuthoringIntent {
  return {
    intentId,
    objectiveId,
    flowDraftId,
    action: {
      kind: "wait_for",
      target: {
        concept: "post-acquisition continuity",
        role: "link",
        name: "Post-acquisition continuity",
        exact: true,
      },
      state: "visible",
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

function qualificationFlow(key: Scenario, label: string) {
  return {
    key,
    objective: `Qualify ${label}`,
    flow: `Controlled ${label}`,
    purpose: "acceptance" as const,
    authorizeMutation: true,
    authorizationKind: "protected_mutation" as const,
  };
}

function navigateIntent(
  intentId: string,
  objectiveId: string,
  flowDraftId: string,
  url: string,
): MissionAuthoringIntent {
  return {
    intentId,
    objectiveId,
    flowDraftId,
    action: { kind: "navigate", url },
    expectedEffect: { kind: "navigation", url, match: "exact" },
    constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

function acquisitionIntent(input: {
  scenario: Scenario;
  preparationIntentIds: string[];
  objectiveId: string;
  flowDraftId: string;
  authorizationId: string;
}): MissionAuthoringIntent {
  const textOutput = input.scenario === "textOutput";
  const timeoutMs = input.scenario === "interruptedAcquisition" ? 600 : 5_000;
  return {
    intentId: `acquire-${input.scenario}`,
    objectiveId: input.objectiveId,
    flowDraftId: input.flowDraftId,
    action: {
      kind: "acquire_protected_outputs",
      preparationIntentIds: input.preparationIntentIds,
      mutation: {
        kind: "one_time",
        target: {
          concept: "generate controlled credential",
          role: "button",
          name: "Generate credential",
          exact: true,
        },
      },
      outputs: [
        {
          reference: `clientId${input.scenario}`,
          classification: "public",
          target: {
            concept: "generated client id",
            role: textOutput ? "text" : "textbox",
            name: "Client ID",
            exact: true,
          },
          storageName: `Controlled ${input.scenario} client ID`,
        },
        {
          reference: `clientSecret${input.scenario}`,
          classification: "protected",
          target: {
            concept: "generated client secret",
            role: textOutput ? "text" : "textbox",
            name: "Client secret",
            exact: true,
          },
          storageName: `Controlled ${input.scenario} client secret`,
        },
      ],
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "protected_mutation", authorizationId: input.authorizationId },
    protectedInputReferences: [],
  };
}

function preparationFillIntent(
  intentId: string,
  objectiveId: string,
  flowDraftId: string,
): MissionAuthoringIntent {
  return {
    intentId, objectiveId, flowDraftId,
    action: {
      kind: "fill",
      target: { concept: "credential name", role: "textbox", name: "Credential name", exact: true },
      publicValue: "Controlled qualification",
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

function preparationSelectIntent(
  intentId: string,
  objectiveId: string,
  flowDraftId: string,
): MissionAuthoringIntent {
  return {
    intentId, objectiveId, flowDraftId,
    action: {
      kind: "select",
      target: { concept: "credential environment", role: "combobox", name: "Environment", exact: true },
      value: "test",
    },
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 5_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

async function call(scenario: Scenario, name: string, tool: { name: string; arguments: Record<string, unknown> }) {
  const startedAt = performance.now();
  const response = await mcp.call(tool);
  callLatencies.push({ scenario, call: name, durationMs: Math.round(performance.now() - startedAt) });
  try {
    rejectToolError(response);
  } catch {
    throw new Error(toolFailureCode(response));
  }
  return response;
}

async function closeSession(sessionId: string) {
  const response = await mcp.call({
    name: "close_flow_authoring",
    arguments: {
      sessionId,
      idempotencyKey: `protected-qualification-close-${sessionId}`,
    },
  });
  rejectToolError(response);
}

async function operationProof(sessionId: string) {
  const result = await pool!.query<{
    state: string;
    dispatchState: string;
    mutationOutcome: string;
    acquisitionState: string;
    persistenceState: string;
    persistedReferenceCount: number;
    transitionCount: number;
    failureCode: string | null;
  }>(
    `SELECT operation.state,operation.dispatch_state AS "dispatchState",
            operation.mutation_outcome AS "mutationOutcome",
            operation.acquisition_state AS "acquisitionState",
            operation.persistence_state AS "persistenceState",
            (SELECT count(*) FROM jsonb_object_keys(operation.persisted_references))::int
              AS "persistedReferenceCount",
            count(transition.id)::int AS "transitionCount",operation.failure_code AS "failureCode"
       FROM protected_operations operation
       LEFT JOIN protected_operation_transitions transition
         ON transition.protected_operation_id=operation.id
      WHERE operation.authoring_session_id=$1
      GROUP BY operation.id`,
    [sessionId],
  );
  assert(result.rowCount === 1, "QUALIFICATION_OPERATION_PROOF_MISSING");
  return result.rows[0]!;
}

function findTurn(value: unknown): SafeTurn {
  const found = findNested(value, (record) =>
    typeof record.turnId === "string" &&
    (record.state === "completed" || record.state === "pending" || record.state === "decision_required")
      ? record as unknown as SafeTurn
      : undefined,
  );
  assert(found, "QUALIFICATION_TURN_RESPONSE_MISSING");
  return found;
}

function findNested<T>(value: unknown, select: (record: Record<string, unknown>) => T | undefined): T | undefined {
  if (typeof value === "string") {
    try { return findNested(JSON.parse(value), select); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNested(entry, select);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const selected = select(record);
  if (selected !== undefined) return selected;
  for (const child of Object.values(record)) {
    const found = findNested(child, select);
    if (found !== undefined) return found;
  }
  return undefined;
}

function summarizeLatency(entries: typeof callLatencies) {
  const durations = entries.map((entry) => entry.durationMs).sort((left, right) => left - right);
  return {
    calls: entries,
    totalMs: durations.reduce((sum, duration) => sum + duration, 0),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.at(-1) ?? 0,
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)]!;
}

function databaseUrl() {
  return process.env.SCRY_AUTHORING_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://scry:scry-local@127.0.0.1:54329/scry";
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function safeCode(error: unknown) {
  const value = error instanceof Error ? error.message : "CONTROLLED_PROTECTED_QUALIFICATION_FAILED";
  return /^[A-Z0-9_:-]+$/.test(value) ? value.slice(0, 160) : "CONTROLLED_PROTECTED_QUALIFICATION_FAILED";
}

function toolFailureCode(value: unknown) {
  const serialized = JSON.stringify(value);
  const explicit = serialized.match(/\b[A-Z][A-Z0-9_]{5,}\b/)?.[0];
  if (explicit) return explicit;
  const text = findNested(value, (record) =>
    typeof record.text === "string" ? record.text : undefined,
  );
  const slug = text
    ?.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "ID")
    .replace(/https?:\/\/\S+/gi, "URL")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return slug ? `MCP_TOOL_${slug}` : "MCP_TOOL_CALL_FAILED";
}
