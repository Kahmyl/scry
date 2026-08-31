import { describe, expect, it, vi } from "vitest";

import { AdaptiveSessionRepository } from "../src/adaptive-sessions/repositories/adaptive-session.repository.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("external-agent owner-loss mutation fidelity", () => {
  it.each([
    {
      name: "an unresolved UNKNOWN operation",
      unknown: true,
      running: false,
      expectedMutationFact: "unknown",
    },
    {
      name: "a running operation whose mutation truth must remain untouched",
      unknown: false,
      running: true,
      expectedMutationFact: "preserved",
    },
  ])("moves $name to recovery without rewriting operation truth", async (example) => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        if (sql.includes("FROM adaptive_sessions s JOIN projects"))
          return { rowCount: 1, rows: [activeSession()] };
        if (sql.includes("COALESCE(bool_or"))
          return { rowCount: 1, rows: [{ unknown: example.unknown }] };
        if (sql.includes("state='running' LIMIT 1"))
          return { rowCount: example.running ? 1 : 0, rows: example.running ? [{}] : [] };
        return { rowCount: 1, rows: [] };
      }),
    };
    const repository = new AdaptiveSessionRepository({
      transaction: vi.fn(async (work: (value: typeof client) => unknown) => work(client)),
    } as never);

    await expect(
      repository.settleExternalOwnerLoss({
        workspaceId: null,
        sessionId,
        idempotencyKey: "owner-loss-1",
        reasonCode: "EXTERNAL_AGENT_PROCESS_LOST",
      }),
    ).resolves.toEqual({
      state: "recovery_required",
      reconciliationRequired: true,
      replayed: false,
    });

    const allSql = statements.map(({ sql }) => sql).join("\n");
    expect(allSql).not.toMatch(/UPDATE\s+(adaptive_operations|protected_operations)/);
    const eventInsert = statements.find(({ sql }) =>
      sql.includes("INSERT INTO adaptive_session_events"),
    );
    expect(eventInsert?.values).toEqual(
      expect.arrayContaining([
        "recovery_required",
        expect.stringContaining(`\"mutationOutcome\":\"${example.expectedMutationFact}\"`),
      ]),
    );
  });

  it("cancels only at a proven safe boundary without changing applied operation truth", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM adaptive_sessions s JOIN projects"))
          return { rowCount: 1, rows: [activeSession()] };
        if (sql.includes("COALESCE(bool_or")) return { rowCount: 1, rows: [{ unknown: false }] };
        if (sql.includes("state='running' LIMIT 1")) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }),
    };
    const repository = new AdaptiveSessionRepository({
      transaction: vi.fn(async (work: (value: typeof client) => unknown) => work(client)),
    } as never);

    await expect(
      repository.settleExternalOwnerLoss({
        workspaceId: null,
        sessionId,
        idempotencyKey: "owner-loss-2",
        reasonCode: "MAX_TOOL_CALLS_EXCEEDED",
      }),
    ).resolves.toMatchObject({ state: "cancelled", reconciliationRequired: false });
    const sql = statements.join("\n");
    expect(sql).not.toMatch(/UPDATE\s+adaptive_operations/);
    const retirement = statements.filter((statement) =>
      /UPDATE\s+protected_operations/.test(statement),
    );
    expect(retirement).toHaveLength(1);
    expect(retirement[0]).toContain("state IN ('reserved','planned') AND program_digest IS NULL");
    expect(retirement[0]).toContain(
      "dispatch_state='not_started' AND mutation_outcome='not_attempted'",
    );
    expect(retirement[0]).toContain("FROM unused WHERE operation.id=unused.id");
  });
});

function activeSession() {
  return {
    id: sessionId,
    projectId: "22222222-2222-4222-8222-222222222222",
    missionId: "33333333-3333-4333-8333-333333333333",
    objectiveId: "44444444-4444-4444-8444-444444444444",
    flowDraftId: "55555555-5555-4555-8555-555555555555",
    activeObjectiveId: "44444444-4444-4444-8444-444444444444",
    activeFlowDraftId: "55555555-5555-4555-8555-555555555555",
    environmentId: "66666666-6666-4666-8666-666666666666",
    correlationId: "correlation-1",
    state: "active",
    version: 1,
    objective: "Test",
    allowedOrigins: ["https://example.test"],
    decisionBoundary: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}
