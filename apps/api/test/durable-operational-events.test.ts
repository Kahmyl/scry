import { buildOperationalEvent } from "@scry/observability";
import { describe, expect, it, vi } from "vitest";

import { OperationalEventStore } from "../src/infrastructure/operational-event-store.js";
import { OperationalEventsController } from "../src/infrastructure/operational-events.controller.js";

describe("durable operational event plane", () => {
  it("persists the canonical sanitized causal chain", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const database = {
      query: vi.fn(async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }),
    };
    const store = new OperationalEventStore(database as never);
    const canary = "must-not-enter-operational-storage";
    const event = buildOperationalEvent({
      component: "runtime",
      releaseId: "release-1",
      schemaFingerprint: "schema-1",
      now: () => new Date("2026-08-23T10:00:00.000Z"),
      input: {
        name: "protected_operation.reconciliation_required",
        classification: "reconciliation_unknown",
        reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
        outcome: "reconciliation_required",
        causality: {
          projectId: "project-1",
          missionId: "mission-1",
          runId: "run-1",
          praxisSessionId: "praxis-1",
          protectedOperationId: "protected-1",
          correlationId: "correlation-1",
        },
        details: { mutationOutcome: "unknown", protectedValue: canary },
      },
    });

    await store.write(event);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("INSERT INTO operational_events");
    expect(JSON.stringify(queries[0]!.values)).not.toContain(canary);
    expect(JSON.stringify(queries[0]!.values)).toContain("[REDACTED]");
    expect(queries[0]!.values).toEqual(
      expect.arrayContaining([
        "project-1",
        "mission-1",
        "run-1",
        "praxis-1",
        "protected-1",
        "correlation-1",
      ]),
    );
  });

  it("isolates user queries to the owning workspace and returns causal joins", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({
      rows: [storedRow()],
      rowCount: 1,
    }));
    const database = {
      query,
    };
    const store = new OperationalEventStore(database as never);

    const page = await store.query(
      { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "project-1" },
      { limit: 50, correlationId: "correlation-1" },
    );

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("SELECT id::text FROM projects WHERE workspace_id=");
    expect(sql).toContain("project_id=");
    expect(sql).toContain("correlation_id=");
    expect(values).toEqual(
      expect.arrayContaining([
        "11111111-1111-4111-8111-111111111111",
        "project-1",
        "correlation-1",
      ]),
    );
    expect(page.items[0]?.causality).toMatchObject({
      missionId: "mission-1",
      runId: "run-1",
      praxisSessionId: "praxis-1",
      protectedOperationId: "protected-1",
      correlationId: "correlation-1",
    });
  });

  it("uses a bounded advisory-locked retention batch", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }),
    };
    const database = {
      transaction: vi.fn(async (work: (connection: never) => Promise<unknown>) =>
        work(client as never),
      ),
    };
    const store = new OperationalEventStore(database as never);

    const result = await store.prune({
      retentionDays: 30,
      batchSize: 25,
      now: new Date("2026-08-23T10:00:00.000Z"),
    });

    expect(result).toEqual({
      acquired: true,
      deleted: 2,
      cutoff: "2026-07-24T10:00:00.000Z",
    });
    expect(client.query.mock.calls[0]![0]).toContain("pg_try_advisory_xact_lock");
    expect(client.query.mock.calls[1]![0]).toContain("FOR UPDATE SKIP LOCKED LIMIT $2");
    expect(client.query.mock.calls[1]![1]).toEqual(["2026-07-24T10:00:00.000Z", 25]);
  });

  it("projects deterministic alert states without rewriting durable truth", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("GROUP BY classification"))
          return { rows: [{ classification: "infrastructure", count: "2" }] };
        if (sql.includes("FROM ("))
          return {
            rows: [
              {
                type: "worker_execution_failure",
                count: "2",
                firstAt: new Date("2026-08-23T09:00:00.000Z"),
                lastAt: new Date("2026-08-23T09:30:00.000Z"),
              },
            ],
          };
        return {
          rows: [
            {
              count: "1",
              firstAt: new Date("2026-08-23T08:00:00.000Z"),
              lastAt: new Date("2026-08-23T08:00:00.000Z"),
            },
          ],
        };
      }),
    };
    const store = new OperationalEventStore(database as never);

    const summary = await store.summary(
      { workspaceId: "11111111-1111-4111-8111-111111111111" },
      {
        windowHours: 24,
        now: new Date("2026-08-23T10:00:00.000Z"),
        reconciliationThresholdMs: 60_000,
      },
    );

    expect(summary.totalEvents).toBe(2);
    expect(summary.alerts.map((alert) => alert.type)).toEqual(
      expect.arrayContaining([
        "worker_execution_failure",
        "unknown_protected_operation",
        "reconciliation_latency",
      ]),
    );
    expect(
      summary.alerts.find((alert) => alert.type === "unknown_protected_operation"),
    ).toMatchObject({
      severity: "critical",
      safeAction: expect.stringContaining("reconcile"),
    });
  });

  it("requires service ingestion and owner/admin reads", async () => {
    const events = { ingest: vi.fn(async () => undefined) };
    const store = { query: vi.fn(), summary: vi.fn() };
    const controller = new OperationalEventsController(events as never, store as never);
    const event = buildOperationalEvent({
      component: "mcp",
      input: {
        name: "mcp.request_rejected",
        classification: "validation",
        reasonCode: "MCP_REQUEST_INVALID",
        outcome: "refused",
      },
    });
    const member = {
      kind: "user" as const,
      subject: "user-1",
      userId: "user-1",
      email: "member@example.test",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      role: "member" as const,
    };

    await expect(controller.ingest(member, event)).rejects.toThrow(
      "Operational event ingestion requires service authentication",
    );
    expect(() => controller.query(member, { limit: 50 })).toThrow(
      "Operational diagnostics require an owner or admin",
    );
    await expect(
      controller.ingest({ kind: "service", subject: "scry-service" }, event),
    ).resolves.toEqual({ accepted: true });
    expect(events.ingest).toHaveBeenCalledWith(event);
  });
});

function storedRow() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    schemaVersion: 1,
    occurredAt: new Date("2026-08-23T10:00:00.000Z"),
    ingestedAt: new Date("2026-08-23T10:00:01.000Z"),
    name: "protected_operation.reconciliation_required",
    component: "runtime",
    classification: "reconciliation_unknown",
    reasonCode: "MUTATION_RECONCILIATION_REQUIRED",
    outcome: "reconciliation_required",
    critical: true,
    releaseId: "release-1",
    schemaFingerprint: "schema-1",
    durationMs: 12,
    transitionFrom: "dispatching",
    transitionTo: "reconciling",
    projectId: "project-1",
    workspaceId: null,
    missionId: "mission-1",
    objectiveId: "objective-1",
    agentSessionId: "agent-1",
    mcpSessionId: "mcp-1",
    runId: "run-1",
    attemptId: "attempt-1",
    praxisSessionId: "praxis-1",
    operationId: "operation-1",
    protectedOperationId: "protected-1",
    correlationId: "correlation-1",
    browserContextId: "browser-1",
    documentAuthorityId: "document-1",
    details: { mutationOutcome: "unknown" },
  };
}
