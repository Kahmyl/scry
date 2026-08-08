import { readFile } from "node:fs/promises";

import type { CampaignCheck, CampaignMetricsCollector } from "@scry/campaigns";
import pg from "pg";

type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type DeployedCampaignSpec = {
  calls: ToolCall[];
  artifactIds?: string[];
  expectedMutationIdentities?: string[];
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
  milestone: "M0" | "M1";
  target: "production_shaped" | "vitract_preview";
  correlationId: string;
  metrics: CampaignMetricsCollector;
  fixtureOrigin?: string;
}): Promise<DeployedCampaignResult> {
  const spec = await readSpec(input.target);
  validateSpec(spec, input);
  const session = await initializeMcp();
  const responses: unknown[] = [];
  const checks: CampaignCheck[] = [];
  try {
    for (const [index, candidate] of spec.calls.entries()) {
      const call = interpolate(candidate, {
        CORRELATION_ID: input.correlationId,
        FIXTURE_ORIGIN: input.fixtureOrigin ?? "",
      });
      const eventId = `mcp-${input.correlationId}-${index + 1}`;
      input.metrics.countMcpRequest({ source: "mcp_http", eventId });
      const restart = spec.restart?.duringCallIndex === index ? spec.restart : undefined;
      const restartWork = restart
        ? delayedRestart(restart, input.correlationId)
        : Promise.resolve(undefined);
      let response: unknown;
      try {
        response = await input.metrics.phase(
          eventId,
          "mcp_round_trip",
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
        input.metrics.countMcpRequest({
          source: "mcp_http",
          eventId: `${eventId}-replay`,
        });
        response = await session.call(call);
      }
      await restartWork;
      rejectToolError(response);
      responses.push(response);
      input.metrics.countBytesReturned(byteLength(response), {
        source: "mcp_http",
        eventId: `${eventId}-bytes`,
      });
      const boundary = findDecisionBoundary(response);
      if (boundary) {
        input.metrics.countDecisionBoundary({
          source: "mcp_http",
          eventId: `${eventId}-boundary`,
        });
      }
    }
  } finally {
    await session.close();
  }

  await collectPersistedTelemetry(input.correlationId, input.metrics);
  const artifactIds = responseArtifactIds(responses, spec.artifactIds ?? []);
  const artifactBytes = await retrieveArtifacts(artifactIds, input);
  const forbiddenValues = await readForbiddenValues();
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
    description: "The deployed journey finalizes and retrieves a persisted artifact through the API",
    status: artifactIds.length > 0 && artifactBytes.length === artifactIds.length ? "passed" : "failed",
    ...(artifactIds.length === 0 ? { reasonCode: "MEASUREMENT_UNAVAILABLE" } : {}),
  });
  const terminalBoundary = findDecisionBoundary(responses.at(-1));
  checks.push({
    id: "deployed-journey",
    description: "The deployed MCP authoring journey reaches an objective-completed boundary",
    status: terminalBoundary === "objective_completed" ? "passed" : "failed",
    ...(terminalBoundary !== "objective_completed"
      ? { reasonCode: "CAMPAIGN_TERMINAL_BOUNDARY_MISSING" }
      : {}),
  });
  checks.push({
    id: "authoring-turn-surface",
    description: "M1 executes the grouped advance_authoring_turn MCP surface",
    status:
      input.milestone === "M0" ||
      (spec.calls.length === 1 && spec.calls[0]?.name === "advance_authoring_turn")
        ? "passed"
        : "failed",
    ...(input.milestone === "M1" &&
    (spec.calls.length !== 1 || spec.calls[0]?.name !== "advance_authoring_turn")
      ? { reasonCode: "M1_GROUPED_AUTHORING_SURFACE_NOT_EXERCISED" }
      : {}),
  });
  if (input.milestone === "M1" && input.target === "production_shaped") {
    checks.push(await verifyRestartFence(spec, input.correlationId));
  }
  return { responses, artifactBytes, requiredChecks: checks };
}

async function readSpec(target: "production_shaped" | "vitract_preview") {
  const variable =
    target === "vitract_preview"
      ? "SCRY_VITRACT_CAMPAIGN_SPEC_PATH"
      : "SCRY_CAMPAIGN_SPEC_PATH";
  const file = requiredEnvironment(variable);
  return JSON.parse(await readFile(file, "utf8")) as DeployedCampaignSpec;
}

function validateSpec(
  spec: DeployedCampaignSpec,
  input: { milestone: "M0" | "M1"; target: "production_shaped" | "vitract_preview" },
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
  if (input.target === "vitract_preview") {
    if (/protectedTransaction|capturePublicValue/i.test(bytes)) {
      throw new Error("VITRACT_CAMPAIGN_MUTATION_FORBIDDEN");
    }
    if (/create.{0,40}(application|credential|order)|generate.{0,40}credential/i.test(bytes)) {
      throw new Error("VITRACT_CAMPAIGN_SCOPE_FORBIDDEN");
    }
  }
}

async function initializeMcp() {
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

async function collectPersistedTelemetry(
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
  } finally {
    await pool.end();
  }
}

async function retrieveArtifacts(
  artifactIds: string[],
  input: { correlationId: string; metrics: CampaignMetricsCollector },
) {
  const output: Uint8Array[] = [];
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

function parseMcpResponse(body: string) {
  if (!body.trim().startsWith("data:")) return JSON.parse(body);
  const payload = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .find((line) => line && line !== "[DONE]");
  if (!payload) throw new Error("MCP_RESPONSE_EMPTY");
  return JSON.parse(payload);
}

function rejectToolError(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (record.error || (record.result as Record<string, unknown> | undefined)?.isError === true) {
    throw new Error("MCP_TOOL_CALL_FAILED");
  }
}

function findDecisionBoundary(value: unknown): string | undefined {
  const match = JSON.stringify(value).match(/"type"\s*:\s*"([a-z_]+)"/);
  return match?.[1];
}

function byteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function databaseUrl() {
  return requiredEnvironment("DATABASE_URL");
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
