import { readFile } from "node:fs/promises";

import type { CampaignCheck, CampaignMetricsCollector } from "@scry/assurance/legacy";
import pg from "pg";

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type DeployedCampaignSpec = {
  calls: ToolCall[];
  artifactIds?: string[];
  expectedMutationIdentities?: string[];
  expectedFlowCount?: number;
  restart?: {
    endpoint: string;
    duringCallIndex: number;
    delayMs: number;
    replayAfterRestart: boolean;
  };
};

export type DeployedCampaignResult = {
  responses: unknown[];
  artifactBytes: Uint8Array[];
  requiredChecks: CampaignCheck[];
};

export async function runDeployedCampaign(input: {
  milestone: "M0" | "M1" | "M2";
  target: string;
  correlationId: string;
  metrics: CampaignMetricsCollector;
  fixtureOrigin?: string;
  spec?: DeployedCampaignSpec;
  forbiddenValues?: string[];
  resolutionThresholds?: { minNativeResolved: number; maxPraxisFallbacks: number };
}): Promise<DeployedCampaignResult> {
  const spec = input.spec ?? (await readExternalSpec(input.target));
  validateSpec(spec, input);
  const session = await initializeMcp();
  const responses: unknown[] = [];
  const checks: CampaignCheck[] = [];
  let adaptiveSessionId = "";
  let cleanupSucceeded = false;
  try {
    for (const [index, candidate] of spec.calls.entries()) {
      const call = interpolate(candidate, {
        CORRELATION_ID: input.correlationId,
        FIXTURE_ORIGIN: input.fixtureOrigin ?? "",
        SESSION_ID: adaptiveSessionId,
      });
      const eventId = `mcp-${input.correlationId}-${index + 1}`;
      const classification = classifyCampaignCall(call.name);
      const sessionStart = classification.kind === "session_start";
      if (classification.countsAsAuthoring) {
        input.metrics.countMcpRequest({ source: "mcp_http", eventId });
      }
      const restart = spec.restart?.duringCallIndex === index ? spec.restart : undefined;
      const restartWork = restart
        ? delayedRestart(restart, input.correlationId)
        : Promise.resolve(undefined);
      let response: unknown;
      try {
        response = await input.metrics.phase(
          eventId,
          classification.phase,
          { source: "mcp_http", eventId: `${eventId}-duration` },
          () => session.call(call),
        );
      } catch (error) {
        if (!restart?.replayAfterRestart) throw error;
        await restartWork;
        input.metrics.countRetry("WORKER_RESTART", {
          source: "mcp_http",
          eventId: `${eventId}-restart-retry`,
        });
        if (!sessionStart)
          input.metrics.countMcpRequest({
            source: "mcp_http",
            eventId: `${eventId}-replay`,
          });
        response = await session.call(call);
      }
      await restartWork;
      rejectToolError(response);
      responses.push(response);
      if (sessionStart) {
        adaptiveSessionId = findAdaptiveSessionId(response) ?? "";
        if (!adaptiveSessionId) throw new Error("CAMPAIGN_ADAPTIVE_SESSION_ID_MISSING");
      } else {
        input.metrics.countBytesReturned(byteLength(response), {
          source: "mcp_http",
          eventId: `${eventId}-bytes`,
        });
      }
      const boundary = sessionStart ? undefined : findDecisionBoundary(response);
      if (boundary) {
        input.metrics.countDecisionBoundary({
          source: "mcp_http",
          eventId: `${eventId}-boundary`,
        });
      }
      if (input.milestone === "M2" && call.name === "advance_flow_authoring" && findTurnState(response) !== "completed") {
        throw new Error("M2_TURN_NOT_COMPLETED");
      }
      if (call.name === "close_flow_authoring") cleanupSucceeded = true;
    }
  } finally {
    if (adaptiveSessionId && !cleanupSucceeded) {
      cleanupSucceeded = await closeCampaignSession(adaptiveSessionId, input.correlationId);
    }
    await session.close();
  }

  checks.push({
    id: "adaptive-session-cleanup",
    description: "The campaign cancels its Adaptive Session and releases browser ownership",
    status: cleanupSucceeded ? "passed" : "failed",
    ...(!cleanupSucceeded ? { reasonCode: "CAMPAIGN_SESSION_CLEANUP_FAILED" } : {}),
  });

  const telemetry = await collectPersistedTelemetry(input.correlationId, input.metrics);
  if (input.milestone === "M1") {
    const threshold = input.resolutionThresholds ?? { minNativeResolved: 1, maxPraxisFallbacks: 0 };
    const resolutionPassed = telemetry.nativeResolved >= threshold.minNativeResolved &&
      telemetry.praxisCalls <= threshold.maxPraxisFallbacks;
    checks.push({
      id: "native-only-standard-controls",
      description: "Native resolution and the single admitted Praxis fallback remain within target thresholds",
      status: resolutionPassed ? "passed" : "failed",
      ...(!resolutionPassed
        ? { reasonCode: "M1_NATIVE_ONLY_CONTROL_INVARIANT_FAILED", safeDetail: telemetry }
        : {}),
    });
  }
  if (input.milestone === "M2") {
    const threshold = input.resolutionThresholds ?? { minNativeResolved: 1, maxPraxisFallbacks: 0 };
    const resolutionPassed = telemetry.nativeResolved >= threshold.minNativeResolved &&
      telemetry.praxisCalls === 0;
    checks.push({
      id: "m2-native-only",
      description: "Every M2 browser interaction resolves through the one native driver without Praxis",
      status: resolutionPassed ? "passed" : "failed",
      ...(!resolutionPassed
        ? { reasonCode: "M2_NATIVE_ONLY_INVARIANT_FAILED", safeDetail: telemetry }
        : {}),
    });
  }
  const artifactIds = responseArtifactIds(responses, spec.artifactIds ?? []);
  const artifactBytes = await retrieveArtifacts(artifactIds, input);
  const forbiddenValues = input.forbiddenValues ?? (await readForbiddenValues());
  const responseBytes = Buffer.from(JSON.stringify(responses));
  const leaked = forbiddenValues.some(
    (value) =>
      responseBytes.includes(value) || artifactBytes.some((artifact) => Buffer.from(artifact).includes(value)),
  );
  checks.push({
    id: "redaction",
    description: "Protected values are absent from MCP responses and retrieved artifacts",
    status: !leaked && forbiddenValues.length > 0 ? "passed" : "failed",
    ...(!forbiddenValues.length
      ? { reasonCode: "CAMPAIGN_FORBIDDEN_VALUE_PROBE_REQUIRED" }
      : leaked
        ? { reasonCode: "CAMPAIGN_PROTECTED_VALUE_LEAK" }
        : {}),
  });
  checks.push({
    id: "artifact-round-trip",
    description: "Every artifact emitted by the deployed journey finalizes and round-trips",
    status: artifactBytes.length === artifactIds.length ? "passed" : "failed",
    ...(artifactBytes.length !== artifactIds.length
      ? { reasonCode: "CAMPAIGN_ARTIFACT_ROUND_TRIP_INCOMPLETE" }
      : {}),
  });
  const terminalBoundary = findDecisionBoundary(responses.at(-1));
  const terminalTurnState = [...responses].reverse().map(findTurnState).find(Boolean);
  checks.push({
    id: "deployed-journey",
    description: "The deployed MCP authoring journey reaches a terminal successful turn",
    status: (input.milestone === "M2"
      ? terminalTurnState === "completed"
      : terminalBoundary === "objective_completed") ? "passed" : "failed",
    ...((input.milestone === "M2" ? terminalTurnState !== "completed" : terminalBoundary !== "objective_completed")
      ? { reasonCode: "CAMPAIGN_TERMINAL_BOUNDARY_MISSING" }
      : {}),
  });
  checks.push({
    id: "authoring-turn-surface",
    description: input.milestone === "M2"
      ? "M2 executes no more than two grouped semantic authoring turns"
      : "M1 executes one grouped advance_flow_authoring call",
    status:
      input.milestone === "M0" ||
      input.milestone === "M1" && authoringCalls(spec).length === 1 ||
      input.milestone === "M2" && authoringCalls(spec).length >= 1 && authoringCalls(spec).length <= 2
        ? "passed"
        : "failed",
    ...(input.milestone === "M1" && authoringCalls(spec).length !== 1
      ? { reasonCode: "M1_GROUPED_AUTHORING_SURFACE_NOT_EXERCISED" }
      : input.milestone === "M2" && (authoringCalls(spec).length < 1 || authoringCalls(spec).length > 2)
        ? { reasonCode: "M2_GROUPED_AUTHORING_SURFACE_NOT_EXERCISED" }
      : {}),
  });
  if (input.milestone === "M1" && input.target === "production_shaped" && spec.restart) {
    checks.push(await verifyRestartFence(spec, input.correlationId));
  }
  if (input.milestone === "M2") {
    const turns = authoringCalls(spec);
    const semanticOnly = turns.every((call) =>
      Array.isArray(call.arguments.intents) && !("operations" in call.arguments));
    const channelsPresent = turns.every((_, index) => hasIndependentChannels(responses[index + 1]));
    checks.push(
      {
        id: "m2-semantic-turn-surface",
        description: "M2 authoring calls contain semantic intents and no low-level operation payload",
        status: semanticOnly ? "passed" : "failed",
        ...(!semanticOnly ? { reasonCode: "M2_LOW_LEVEL_OPERATION_SURFACE_REMAINS" } : {}),
      },
      {
        id: "m2-independent-outcome-channels",
        description: "Every grouped turn reports functional, mutation, privacy, evidence, and quality separately",
        status: channelsPresent ? "passed" : "failed",
        ...(!channelsPresent ? { reasonCode: "M2_OUTCOME_CHANNEL_MISSING" } : {}),
      },
      {
        id: "m2-call-budget",
        description: "The complete M2 journey uses no more than four MCP calls",
        status: spec.calls.length <= 4 ? "passed" : "failed",
        ...(spec.calls.length > 4 ? { reasonCode: "M2_MCP_CALL_BUDGET_EXCEEDED" } : {}),
      },
    );
  }
  return { responses, artifactBytes, requiredChecks: checks };
}

async function closeCampaignSession(sessionId: string, correlationId: string) {
  try {
    const closed = await fetch(`${apiBaseUrl()}/mission-flow-authoring/${sessionId}/close`, {
      method: "POST",
      headers: { ...Object.fromEntries(apiHeaders()), "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `campaign-cleanup-${correlationId}`,
      }),
    });
    return closed.ok;
  } catch {
    return false;
  }
}

async function readExternalSpec(target: string) {
  if (target !== "vitract_preview") throw new Error("CORE_CAMPAIGN_GENERATED_SPEC_REQUIRED");
  if (process.env.SCRY_LIVE_ACCEPTANCE !== "true") throw new Error("SCRY_LIVE_ACCEPTANCE_REQUIRED");
  const file = requiredEnvironment("SCRY_VITRACT_CAMPAIGN_SPEC_PATH");
  return JSON.parse(await readFile(file, "utf8")) as DeployedCampaignSpec;
}

function authoringCalls(spec: DeployedCampaignSpec) {
  return spec.calls.filter((call) => call.name === "advance_flow_authoring");
}

export function classifyCampaignCall(name: string) {
  return name === "start_flow_authoring"
    ? {
        kind: "session_start" as const,
        phase: "mcp_session_start_round_trip",
        countsAsAuthoring: false,
      }
    : { kind: "authoring" as const, phase: "mcp_round_trip", countsAsAuthoring: true };
}

function validateSpec(
  spec: DeployedCampaignSpec,
  input: { milestone: "M0" | "M1" | "M2"; target: string },
) {
  if (!Array.isArray(spec.calls) || !spec.calls.length) throw new Error("CAMPAIGN_CALLS_REQUIRED");
  const bytes = JSON.stringify(spec);
  if (/"(?:password|plaintext|credentialValue|accessToken|apiKey)"\s*:/i.test(bytes)) {
    throw new Error("CAMPAIGN_PLAINTEXT_SECRET_FORBIDDEN");
  }
  for (const call of spec.calls) {
    if (!call.name || !call.arguments || typeof call.arguments !== "object") {
      throw new Error("CAMPAIGN_CALL_INVALID");
    }
  }
  if (input.milestone === "M2") {
    const permitted = new Set([
      "start_flow_authoring",
      "advance_flow_authoring",
      "close_flow_authoring",
    ]);
    if (spec.calls.some((call) => !permitted.has(call.name))) {
      throw new Error("M2_EXTERNAL_TOOL_FORBIDDEN");
    }
    if (spec.calls.filter((call) => call.name === "start_flow_authoring").length !== 1 ||
        spec.calls.filter((call) => call.name === "close_flow_authoring").length !== 1) {
      throw new Error("M2_AUTHORING_LIFECYCLE_INVALID");
    }
  }
  if (input.target === "vitract_preview") {
    if (/protectedTransaction|capturePublicValue/i.test(bytes)) {
      throw new Error("VITRACT_CAMPAIGN_MUTATION_FORBIDDEN");
    }
    const recoveryApplicationCreates = bytes.match(/"intentId":"vitract-save-application"/g)?.length ?? 0;
    const admittedRecoveryApplication = input.milestone === "M2" && recoveryApplicationCreates === 1;
    if (
      /create.{0,40}(credential|order)|generate.{0,40}credential/i.test(bytes) ||
      /create.{0,40}application/i.test(bytes) && !admittedRecoveryApplication
    ) {
      throw new Error("VITRACT_CAMPAIGN_SCOPE_FORBIDDEN");
    }
  }
}

export async function initializeMcp() {
  const endpoint = process.env.SCRY_MCP_URL ?? "http://127.0.0.1:4100/mcp";
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  const serviceToken = process.env.SCRY_SERVICE_TOKEN;
  if (serviceToken) headers.set("authorization", `Bearer ${serviceToken}`);
  let sequence = 1;
  const request = async (method: string, params?: unknown) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: sequence++, method, params }),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) headers.set("mcp-session-id", sessionId);
    if (!response.ok) throw new Error(`MCP_HTTP_${response.status}`);
    return parseMcpResponse(await response.text());
  };
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "scry-adaptive-campaign", version: "1" },
  });
  await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return {
    call: (call: ToolCall) => request("tools/call", { name: call.name, arguments: call.arguments }),
    async close() {
      if (!headers.has("mcp-session-id")) return;
      await fetch(endpoint, { method: "DELETE", headers }).catch(() => undefined);
    },
  };
}

export async function collectPersistedTelemetry(
  correlationId: string,
  metrics: CampaignMetricsCollector,
) {
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const commands = await pool.query<{
      id: string;
      queueMs: number | null;
      browserMs: number | null;
    }>(
      `SELECT command.id,
              extract(epoch FROM (command.claimed_at-command.created_at))*1000 AS "queueMs",
              extract(epoch FROM (lease.activated_at-lease.created_at))*1000 AS "browserMs"
       FROM authoring_runtime_commands command
       JOIN authoring_browser_leases lease ON lease.id=command.browser_lease_id
       WHERE command.payload->>'correlationId'=$1
       ORDER BY command.created_at`,
      [correlationId],
    );
    for (const command of commands.rows) {
      if (command.queueMs !== null) {
        metrics.record(command.id, "queue_wait", Number(command.queueMs), {
          source: "queue_event",
          eventId: `queue-${command.id}`,
        });
      }
      if (command.browserMs !== null) {
        metrics.record(command.id, "browser_startup", Number(command.browserMs), {
          source: "browser_event",
          eventId: `browser-${command.id}`,
        });
      }
    }
    if (!commands.rowCount) {
      metrics.record(correlationId, "queue_wait", 0, {
        source: "queue_event",
        eventId: `queue-not-applicable-${correlationId}`,
      });
    }
    const observations = await pool.query<{
      operationId: string;
      observationMs: number;
    }>(
      `SELECT operation.operation_id AS "operationId",
              GREATEST(0,extract(epoch FROM (min(observation.created_at)-operation.started_at))*1000)
                AS "observationMs"
       FROM adaptive_sessions session
       JOIN adaptive_operations operation ON operation.session_id=session.id
       JOIN adaptive_observations observation
         ON observation.session_id=operation.session_id
        AND observation.operation_id=operation.operation_id
       WHERE session.correlation_id=$1
       GROUP BY operation.session_id,operation.operation_id,operation.started_at
       ORDER BY operation.started_at`,
      [correlationId],
    );
    const firstObservation = observations.rows[0];
    if (firstObservation) {
      metrics.record(firstObservation.operationId, "browser_startup", firstObservation.observationMs, {
        source: "browser_event",
        eventId: `browser-${correlationId}`,
      });
      metrics.record(
        firstObservation.operationId,
        "document_observation",
        firstObservation.observationMs,
        { source: "worker_event", eventId: `observation-${correlationId}` },
      );
    }
    const operations = await pool.query<{
      sessionId: string;
      operationId: string;
      durationMs: number;
    }>(
      `SELECT session_id AS "sessionId",operation_id AS "operationId",
              extract(epoch FROM (completed_at-started_at))*1000 AS "durationMs"
       FROM execution_kernel_operations
       WHERE correlation_id=$1 AND completed_at IS NOT NULL
       ORDER BY started_at`,
      [correlationId],
    );
    for (const operation of operations.rows) {
      const phase = /observation|refresh|inspection/.test(operation.operationId)
        ? "document_observation"
        : "interaction_execution";
      metrics.record(operation.operationId, phase, Number(operation.durationMs), {
        source: "worker_event",
        eventId: `operation-${operation.sessionId}-${operation.operationId}`,
      });
    }
    const praxis = await pool.query<{
      operationId: string;
      sequence: number;
      safeFacts: Record<string, unknown>;
    }>(
      `SELECT event.operation_id AS "operationId",event.sequence,
              event.safe_facts AS "safeFacts"
       FROM execution_kernel_events event
       JOIN execution_kernel_operations operation
         ON operation.session_id=event.session_id AND operation.operation_id=event.operation_id
       WHERE operation.correlation_id=$1 AND event.phase='praxis.result'
       ORDER BY event.id`,
      [correlationId],
    );
    for (const event of praxis.rows) {
      for (const [phase, key] of [
        ["praxis_grounding", "groundingMs"],
        ["interaction_execution", "dispatchMs"],
        ["expected_effect_verification", "effectVerificationMs"],
      ] as const) {
        const value = event.safeFacts[key];
        if (typeof value !== "number") continue;
        metrics.record(event.operationId, phase, value, {
          source: "praxis_result",
          eventId: `praxis-${event.operationId}-${event.sequence}-${phase}`,
        });
      }
    }
    if (!praxis.rowCount) {
      metrics.record(correlationId, "praxis_grounding", 0, {
        source: "praxis_result",
        eventId: `praxis-not-emitted-${correlationId}`,
      });
    }
    const native = await pool.query<{ operationId: string; sequence: number; safeFacts: Record<string, unknown> }>(
      `SELECT event.operation_id AS "operationId",event.sequence,event.safe_facts AS "safeFacts"
       FROM execution_kernel_events event
       JOIN execution_kernel_operations operation
         ON operation.session_id=event.session_id AND operation.operation_id=event.operation_id
       WHERE operation.correlation_id=$1 AND event.phase='native.resolution'
       ORDER BY event.id`,
      [correlationId],
    );
    let nativeResolved = 0;
    for (const event of native.rows) {
      const duration = event.safeFacts.durationMs;
      if (event.safeFacts.status === "resolved") nativeResolved += 1;
      if (typeof duration === "number") {
        metrics.record(event.operationId, "native_resolution", duration, {
          source: "worker_event",
          eventId: `native-${event.operationId}-${event.sequence}`,
        });
      }
    }
    const effects = await pool.query<{ operationId: string; sequence: number; safeFacts: Record<string, unknown> }>(
      `SELECT event.operation_id AS "operationId",event.sequence,event.safe_facts AS "safeFacts"
       FROM execution_kernel_events event
       JOIN execution_kernel_operations operation
         ON operation.session_id=event.session_id AND operation.operation_id=event.operation_id
       WHERE operation.correlation_id=$1 AND event.phase='effect.verification'
       ORDER BY event.id`,
      [correlationId],
    );
    for (const event of effects.rows) {
      const duration = event.safeFacts.durationMs;
      if (typeof duration === "number") {
        metrics.record(event.operationId, "expected_effect_verification", duration, {
          source: "worker_event",
          eventId: `effect-${event.operationId}-${event.sequence}`,
        });
      }
    }
    return { praxisCalls: praxis.rowCount ?? 0, nativeResolved };
  } finally {
    await pool.end();
  }
}

async function retrieveArtifacts(
  artifactIds: string[],
  input: { correlationId: string; metrics: CampaignMetricsCollector },
) {
  const output: Uint8Array[] = [];
  if (!artifactIds.length) {
    input.metrics.record(input.correlationId, "evidence_finalization", 0, {
      source: "artifact_event",
      eventId: `evidence-not-requested-${input.correlationId}`,
    });
    input.metrics.record(input.correlationId, "artifact_retrieval", 0, {
      source: "artifact_event",
      eventId: `artifact-not-requested-${input.correlationId}`,
    });
  }
  for (const [index, artifactId] of artifactIds.entries()) {
    const eventId = `artifact-${input.correlationId}-${index + 1}`;
    await input.metrics.phase(
      artifactId,
      "evidence_finalization",
      { source: "artifact_event", eventId: `${eventId}-metadata` },
      async () => {
        const response = await fetch(
          `${apiBaseUrl()}/artifacts/${encodeURIComponent(artifactId)}/metadata`,
          { headers: apiHeaders() },
        );
        input.metrics.countApiRequest({ source: "api_http", eventId: `${eventId}-metadata-http` });
        if (!response.ok) throw new Error(`ARTIFACT_METADATA_HTTP_${response.status}`);
        const metadata = (await response.json()) as { availability?: string };
        if (metadata.availability !== "available") {
          throw new Error("ARTIFACT_NOT_FINALIZED");
        }
      },
    );
    output.push(
      await input.metrics.phase(
        artifactId,
        "artifact_retrieval",
        { source: "artifact_event", eventId },
        async () => {
          const response = await fetch(`${apiBaseUrl()}/artifacts/${encodeURIComponent(artifactId)}`, {
            headers: apiHeaders(),
          });
          input.metrics.countApiRequest({ source: "api_http", eventId: `${eventId}-content-http` });
          if (!response.ok) throw new Error(`ARTIFACT_HTTP_${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        },
      ),
    );
  }
  return output;
}

function responseArtifactIds(responses: unknown[], declared: string[]): string[] {
  const discovered = new Set<string>();
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string" && key && /artifactId$/i.test(key)) {
      discovered.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, childKey);
    }
  };
  for (const response of responses) visit(response);
  for (const artifactId of declared) {
    if (!discovered.has(artifactId)) throw new Error("CAMPAIGN_ARTIFACT_NOT_BOUND_TO_RESPONSE");
  }
  return [...discovered];
}

function apiHeaders() {
  const headers = new Headers();
  if (process.env.SCRY_SERVICE_TOKEN) {
    headers.set("authorization", `Bearer ${process.env.SCRY_SERVICE_TOKEN}`);
  }
  return headers;
}

async function verifyRestartFence(spec: DeployedCampaignSpec, correlationId: string) {
  if (!spec.restart) {
    return {
      id: "restart-idempotency",
      description: "A real worker restart preserves mutation fencing without duplicate dispatch",
      status: "failed" as const,
      reasonCode: "MEASUREMENT_UNAVAILABLE",
    };
  }
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const mutations = await pool.query<{ operationId: string; state: string }>(
      `SELECT DISTINCT mutation.operation_id AS "operationId",mutation.state
       FROM execution_kernel_mutations mutation
       JOIN execution_kernel_operations operation ON operation.session_id=mutation.session_id
       WHERE operation.correlation_id=$1`,
      [correlationId],
    );
    const expected = new Set(spec.expectedMutationIdentities ?? []);
    const actual = new Set(mutations.rows.map((row) => row.operationId));
    const exact =
      expected.size > 0 &&
      expected.size === actual.size &&
      [...expected].every((identity) => actual.has(identity));
    return {
      id: "restart-idempotency",
      description: "A real worker restart preserves mutation fencing without duplicate dispatch",
      status: exact ? ("passed" as const) : ("failed" as const),
      ...(!exact ? { reasonCode: "WORKER_RESTART_FENCE_NOT_PROVEN" } : {}),
    };
  } finally {
    await pool.end();
  }
}

async function delayedRestart(
  restart: NonNullable<DeployedCampaignSpec["restart"]>,
  correlationId: string,
) {
  await new Promise((resolve) => setTimeout(resolve, restart.delayMs));
  const response = await fetch(restart.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ correlationId }),
  });
  if (!response.ok) throw new Error(`WORKER_RESTART_HTTP_${response.status}`);
}

function interpolate<T>(value: T, replacements: Record<string, string>): T {
  const source = JSON.stringify(value);
  return JSON.parse(
    Object.entries(replacements).reduce(
      (current, [name, replacement]) => current.replaceAll(`\${${name}}`, replacement),
      source,
    ),
  ) as T;
}

export function parseMcpResponse(body: string) {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!dataLines.length) return JSON.parse(body);
  const payload = dataLines.find((line) => line && line !== "[DONE]");
  if (!payload) throw new Error("MCP_RESPONSE_EMPTY");
  return JSON.parse(payload);
}

export function rejectToolError(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (record.error || (record.result as Record<string, unknown> | undefined)?.isError === true) {
    const safeCode = JSON.stringify(value).match(/\b[A-Z][A-Z0-9_]{5,}\b/)?.[0];
    throw new Error(safeCode ?? "MCP_TOOL_CALL_FAILED");
  }
}

export function findDecisionBoundary(value: unknown): string | undefined {
  const visit = (candidate: unknown): string | undefined => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const found = visit(entry);
        if (found) return found;
      }
      return undefined;
    }
    if (!candidate || typeof candidate !== "object") return undefined;
    const record = candidate as Record<string, unknown>;
    if (record.decisionBoundary && typeof record.decisionBoundary === "object") {
      const type = (record.decisionBoundary as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

export function findTurnState(value: unknown): string | undefined {
  return findNested(value, (record) => {
    if (record.turn && typeof record.turn === "object") {
      const state = (record.turn as Record<string, unknown>).state;
      if (typeof state === "string") return state;
    }
    return undefined;
  });
}

function hasIndependentChannels(value: unknown) {
  return findNested(value, (record) => {
    if (!record.channels || typeof record.channels !== "object") return undefined;
    const channels = record.channels as Record<string, unknown>;
    return ["functional", "mutation", "privacy", "evidence", "quality"].every((key) => key in channels)
      ? "present"
      : undefined;
  }) === "present";
}

function findNested(
  value: unknown,
  select: (record: Record<string, unknown>) => string | undefined,
): string | undefined {
  if (typeof value === "string") {
    try { return findNested(JSON.parse(value), select); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNested(entry, select);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const selected = select(record);
  if (selected) return selected;
  for (const child of Object.values(record)) {
    const found = findNested(child, select);
    if (found) return found;
  }
  return undefined;
}

export function findAdaptiveSessionId(value: unknown): string | undefined {
  const visit = (candidate: unknown): string | undefined => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const found = visit(entry);
        if (found) return found;
      }
      return undefined;
    }
    if (!candidate || typeof candidate !== "object") return undefined;
    const record = candidate as Record<string, unknown>;
    if (
      record.session &&
      typeof record.session === "object" &&
      typeof (record.session as Record<string, unknown>).id === "string"
    ) {
      return (record.session as Record<string, unknown>).id as string;
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

function byteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function databaseUrl() {
  return (
    process.env.SCRY_AUTHORING_TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://scry:scry-local@127.0.0.1:54329/scry"
  );
}

function apiBaseUrl() {
  return process.env.SCRY_API_BASE_URL ?? "http://127.0.0.1:4000/api";
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function readForbiddenValues() {
  const file = requiredEnvironment("SCRY_CAMPAIGN_FORBIDDEN_VALUES_PATH");
  return (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}
