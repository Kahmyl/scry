import { Inject, Injectable } from "@nestjs/common";
import {
  operationalEventPageSchema,
  operationalSummarySchema,
  parseOperationalEvent,
  type OperationalAlert,
  type OperationalEvent,
  type OperationalEventPage,
  type OperationalEventQuery,
  type OperationalSummary,
  type StoredOperationalEvent,
} from "@scry/observability";
import type { QueryResultRow } from "pg";

import { Database } from "./database.js";

export type OperationalReadScope = Readonly<{
  workspaceId?: string;
  projectId?: string;
}>;

type StoredEventRow = QueryResultRow & {
  id: string;
  schemaVersion: number;
  occurredAt: Date | string;
  ingestedAt: Date | string;
  name: OperationalEvent["name"];
  component: OperationalEvent["component"];
  classification: OperationalEvent["classification"];
  reasonCode: string;
  outcome: OperationalEvent["outcome"];
  critical: boolean;
  releaseId: string;
  schemaFingerprint: string;
  durationMs: number | null;
  transitionFrom: string | null;
  transitionTo: string | null;
  projectId: string | null;
  workspaceId: string | null;
  missionId: string | null;
  objectiveId: string | null;
  agentSessionId: string | null;
  mcpSessionId: string | null;
  runId: string | null;
  attemptId: string | null;
  praxisSessionId: string | null;
  operationId: string | null;
  protectedOperationId: string | null;
  correlationId: string | null;
  browserContextId: string | null;
  documentAuthorityId: string | null;
  details: Record<string, unknown>;
};

const storedEventColumns = `
  id,schema_version AS "schemaVersion",occurred_at AS "occurredAt",ingested_at AS "ingestedAt",
  event_name AS name,component,classification,reason_code AS "reasonCode",outcome,critical,
  release_id AS "releaseId",schema_fingerprint AS "schemaFingerprint",duration_ms AS "durationMs",
  transition_from AS "transitionFrom",transition_to AS "transitionTo",project_id AS "projectId",
  workspace_id AS "workspaceId",mission_id AS "missionId",objective_id AS "objectiveId",
  agent_session_id AS "agentSessionId",mcp_session_id AS "mcpSessionId",run_id AS "runId",
  attempt_id AS "attemptId",praxis_session_id AS "praxisSessionId",operation_id AS "operationId",
  protected_operation_id AS "protectedOperationId",correlation_id AS "correlationId",
  browser_context_id AS "browserContextId",document_authority_id AS "documentAuthorityId",details`;

@Injectable()
export class OperationalEventStore {
  constructor(@Inject(Database) private readonly database: Database) {}

  async write(value: OperationalEvent): Promise<void> {
    const event = parseOperationalEvent(value);
    const causality = event.causality;
    await this.database.query(
      `INSERT INTO operational_events(
         schema_version,occurred_at,event_name,component,classification,reason_code,outcome,critical,
         release_id,schema_fingerprint,duration_ms,transition_from,transition_to,project_id,workspace_id,
         mission_id,objective_id,agent_session_id,mcp_session_id,run_id,attempt_id,praxis_session_id,
         operation_id,protected_operation_id,correlation_id,browser_context_id,document_authority_id,details
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
         $25,$26,$27,$28::jsonb
       )`,
      [
        event.schemaVersion,
        event.occurredAt,
        event.name,
        event.component,
        event.classification,
        event.reasonCode,
        event.outcome,
        event.critical,
        event.releaseId,
        event.schemaFingerprint,
        event.durationMs ?? null,
        event.transition?.from ?? null,
        event.transition?.to ?? null,
        causality.projectId ?? null,
        causality.workspaceId ?? null,
        causality.missionId ?? null,
        causality.objectiveId ?? null,
        causality.agentSessionId ?? null,
        causality.mcpSessionId ?? null,
        causality.runId ?? null,
        causality.attemptId ?? null,
        causality.praxisSessionId ?? null,
        causality.operationId ?? null,
        causality.protectedOperationId ?? null,
        causality.correlationId ?? null,
        causality.browserContextId ?? null,
        causality.documentAuthorityId ?? null,
        JSON.stringify(event.details ?? {}),
      ],
    );
  }

  async query(
    scope: OperationalReadScope,
    input: OperationalEventQuery,
  ): Promise<OperationalEventPage> {
    const parameters: unknown[] = [];
    const predicates = scopedPredicates(scope, parameters);
    addEventFilters(input, predicates, parameters);
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    if (cursor) {
      parameters.push(cursor.occurredAt, cursor.id);
      predicates.push(
        `(occurred_at,id) < ($${parameters.length - 1}::timestamptz,$${parameters.length}::uuid)`,
      );
    }
    parameters.push(input.limit + 1);
    const result = await this.database.query<StoredEventRow>(
      `SELECT ${storedEventColumns}
         FROM operational_events
        ${where(predicates)}
        ORDER BY occurred_at DESC,id DESC
        LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const items = result.rows.slice(0, input.limit).map(projectStoredEvent);
    const last = hasMore ? items.at(-1) : undefined;
    return operationalEventPageSchema.parse({
      items,
      ...(last ? { nextCursor: encodeCursor(last.occurredAt, last.id) } : {}),
    });
  }

  async summary(
    scope: OperationalReadScope,
    options: { windowHours: number; now?: Date; reconciliationThresholdMs?: number },
  ): Promise<OperationalSummary> {
    const now = options.now ?? new Date();
    const windowStartedAt = new Date(now.getTime() - options.windowHours * 60 * 60 * 1_000);
    const parameters: unknown[] = [];
    const predicates = scopedPredicates(scope, parameters);
    parameters.push(windowStartedAt.toISOString());
    predicates.push(`occurred_at >= $${parameters.length}::timestamptz`);
    const counts = await this.database.query<
      QueryResultRow & { classification: OperationalEvent["classification"]; count: string }
    >(
      `SELECT classification,count(*)::text AS count
         FROM operational_events ${where(predicates)} GROUP BY classification`,
      parameters,
    );

    const recentAlertFacts = await this.database.query<
      QueryResultRow & {
        type: OperationalAlert["type"];
        count: string;
        firstAt: Date;
        lastAt: Date;
      }
    >(
      `SELECT type,count(*)::text AS count,min(occurred_at) AS "firstAt",max(occurred_at) AS "lastAt"
         FROM (
           SELECT occurred_at,
             CASE
               WHEN event_name='worker.execution_failed' THEN 'worker_execution_failure'
               WHEN event_name='report.finalization_failed' OR reason_code ~ 'REPORT_(BLOCKED|FINALIZATION)' THEN 'report_blocker'
               WHEN reason_code ~ '(RELEASE|SCHEMA|MIGRATION).*(MISMATCH|REFUSED|INCOMPATIBLE)' THEN 'release_compatibility_refusal'
               WHEN (event_name IN ('persistence.write_failed','report.finalization_failed')
                     AND reason_code ~ '(EVIDENCE|ARTIFACT|REPORT|FINALIZATION)') THEN 'evidence_finalization_failure'
             END AS type
           FROM operational_events ${where(predicates)}
         ) facts WHERE type IS NOT NULL GROUP BY type`,
      parameters,
    );

    const unknownParameters: unknown[] = [];
    const unknownPredicates = protectedOperationScopePredicates(scope, unknownParameters);
    unknownPredicates.push("mutation_outcome='unknown'");
    const unknown = await this.database.query<
      QueryResultRow & { count: string; firstAt: Date | null; lastAt: Date | null }
    >(
      `SELECT count(*)::text AS count,min(updated_at) AS "firstAt",max(updated_at) AS "lastAt"
         FROM protected_operations ${where(unknownPredicates)}`,
      unknownParameters,
    );

    const alerts: OperationalAlert[] = recentAlertFacts.rows.map((fact) => ({
      type: fact.type,
      severity: fact.type === "release_compatibility_refusal" ? "critical" : "warning",
      count: Number(fact.count),
      firstOccurredAt: iso(fact.firstAt),
      lastOccurredAt: iso(fact.lastAt),
      safeAction: safeAlertAction(fact.type),
    }));
    const unresolved = unknown.rows[0];
    if (unresolved && Number(unresolved.count) > 0) {
      alerts.push({
        type: "unknown_protected_operation",
        severity: "critical",
        count: Number(unresolved.count),
        ...(unresolved.firstAt ? { firstOccurredAt: iso(unresolved.firstAt) } : {}),
        ...(unresolved.lastAt ? { lastOccurredAt: iso(unresolved.lastAt) } : {}),
        safeAction: safeAlertAction("unknown_protected_operation"),
      });
      const oldest = unresolved.firstAt ? new Date(unresolved.firstAt).getTime() : now.getTime();
      if (now.getTime() - oldest >= (options.reconciliationThresholdMs ?? 5 * 60 * 1_000)) {
        alerts.push({
          type: "reconciliation_latency",
          severity: "critical",
          count: Number(unresolved.count),
          ...(unresolved.firstAt ? { firstOccurredAt: iso(unresolved.firstAt) } : {}),
          ...(unresolved.lastAt ? { lastOccurredAt: iso(unresolved.lastAt) } : {}),
          safeAction: safeAlertAction("reconciliation_latency"),
        });
      }
    }

    const byClassification = Object.fromEntries(
      counts.rows.map((row) => [row.classification, Number(row.count)]),
    );
    return operationalSummarySchema.parse({
      generatedAt: now.toISOString(),
      windowStartedAt: windowStartedAt.toISOString(),
      totalEvents: Object.values(byClassification).reduce((sum, count) => sum + count, 0),
      byClassification,
      alerts: alerts.sort((left, right) =>
        left.severity === right.severity
          ? left.type.localeCompare(right.type)
          : left.severity === "critical"
            ? -1
            : 1,
      ),
    });
  }

  async prune(options: { retentionDays: number; batchSize?: number; now?: Date }) {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 1_000, 5_000));
    const cutoff = new Date(
      (options.now ?? new Date()).getTime() - options.retentionDays * 24 * 60 * 60 * 1_000,
    );
    return this.database.transaction(async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext('scry-operational-events-retention')) AS acquired",
      );
      if (!lock.rows[0]?.acquired)
        return { acquired: false, deleted: 0, cutoff: cutoff.toISOString() };
      const deleted = await client.query(
        `DELETE FROM operational_events WHERE id IN (
           SELECT id FROM operational_events WHERE occurred_at < $1
           ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT $2
         )`,
        [cutoff.toISOString(), batchSize],
      );
      return {
        acquired: true,
        deleted: deleted.rowCount ?? 0,
        cutoff: cutoff.toISOString(),
      };
    });
  }
}

function scopedPredicates(scope: OperationalReadScope, parameters: unknown[]) {
  const predicates: string[] = [];
  if (scope.workspaceId) {
    parameters.push(scope.workspaceId);
    predicates.push(
      `(workspace_id=$${parameters.length} OR project_id IN (
        SELECT id::text FROM projects WHERE workspace_id=$${parameters.length}::uuid
      ))`,
    );
  }
  if (scope.projectId) {
    parameters.push(scope.projectId);
    predicates.push(`project_id=$${parameters.length}`);
  }
  return predicates;
}

function protectedOperationScopePredicates(scope: OperationalReadScope, parameters: unknown[]) {
  const predicates: string[] = [];
  if (scope.workspaceId) {
    parameters.push(scope.workspaceId);
    predicates.push(
      `project_id IN (SELECT id FROM projects WHERE workspace_id=$${parameters.length}::uuid)`,
    );
  }
  if (scope.projectId) {
    parameters.push(scope.projectId);
    predicates.push(`project_id=$${parameters.length}::uuid`);
  }
  return predicates;
}

function addEventFilters(
  input: OperationalEventQuery,
  predicates: string[],
  parameters: unknown[],
) {
  const filters: Array<[keyof OperationalEventQuery, string, string?]> = [
    ["occurredAfter", "occurred_at", "timestamptz"],
    ["occurredBefore", "occurred_at", "timestamptz"],
    ["eventName", "event_name"],
    ["component", "component"],
    ["classification", "classification"],
    ["reasonCode", "reason_code"],
    ["projectId", "project_id"],
    ["missionId", "mission_id"],
    ["runId", "run_id"],
    ["praxisSessionId", "praxis_session_id"],
    ["protectedOperationId", "protected_operation_id"],
    ["correlationId", "correlation_id"],
  ];
  for (const [key, column, cast] of filters) {
    const value = input[key];
    if (value === undefined || key === "limit" || key === "cursor") continue;
    parameters.push(value);
    const operator = key === "occurredAfter" ? ">=" : key === "occurredBefore" ? "<=" : "=";
    predicates.push(`${column}${operator}$${parameters.length}${cast ? `::${cast}` : ""}`);
  }
}

function projectStoredEvent(row: StoredEventRow): StoredOperationalEvent {
  const causality = Object.fromEntries(
    [
      "projectId",
      "workspaceId",
      "missionId",
      "objectiveId",
      "agentSessionId",
      "mcpSessionId",
      "runId",
      "attemptId",
      "praxisSessionId",
      "operationId",
      "protectedOperationId",
      "correlationId",
      "browserContextId",
      "documentAuthorityId",
    ].flatMap((key) =>
      row[key as keyof StoredEventRow] ? [[key, row[key as keyof StoredEventRow]]] : [],
    ),
  );
  return {
    id: row.id,
    schemaVersion: 1,
    occurredAt: iso(row.occurredAt),
    ingestedAt: iso(row.ingestedAt),
    name: row.name,
    component: row.component,
    classification: row.classification,
    reasonCode: row.reasonCode,
    outcome: row.outcome,
    critical: true,
    releaseId: row.releaseId,
    schemaFingerprint: row.schemaFingerprint,
    causality,
    ...(row.durationMs === null ? {} : { durationMs: Number(row.durationMs) }),
    ...(row.transitionFrom && row.transitionTo
      ? { transition: { from: row.transitionFrom, to: row.transitionTo } }
      : {}),
    ...(Object.keys(row.details).length ? { details: row.details } : {}),
  };
}

function where(predicates: readonly string[]) {
  return predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
}

function encodeCursor(occurredAt: string, id: string) {
  return Buffer.from(JSON.stringify({ occurredAt, id }), "utf8").toString("base64url");
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      occurredAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.occurredAt)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    )
      throw new Error("invalid");
    return { occurredAt: parsed.occurredAt, id: parsed.id };
  } catch {
    throw new Error("OPERATIONAL_EVENT_CURSOR_INVALID");
  }
}

function safeAlertAction(type: OperationalAlert["type"]) {
  const actions: Record<OperationalAlert["type"], string> = {
    unknown_protected_operation:
      "Inspect the protected operation receipt and reconcile before any redispatch.",
    reconciliation_latency:
      "Inspect reconciliation observations and preserve unknown mutation truth.",
    worker_execution_failure:
      "Follow the correlation chain, then inspect worker health and the owning durable state.",
    report_blocker:
      "Inspect Mission readiness and the selected evidence/report finalization facts.",
    release_compatibility_refusal:
      "Verify release and schema fingerprints before restarting the affected component.",
    evidence_finalization_failure:
      "Inspect artifact availability and persistence facts; do not fabricate missing evidence.",
  };
  return actions[type];
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
