import { describe, expect, it, vi } from "vitest";

import { OperationalEvents } from "../src/infrastructure/operational-events.js";
import { OperationalEventsController } from "../src/infrastructure/operational-events.controller.js";
import { LegacyExternalAgentLifecycleController } from "../src/runs/controllers/external-agent-lifecycle.controller.js";
import { ExternalAgentLifecycleService } from "../src/runs/services/external-agent-lifecycle.service.js";

const ids = {
  external: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  project: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  mission: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  objective: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  agent: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  praxis: "11111111-1111-4111-8111-111111111111",
  run: "22222222-2222-4222-8222-222222222222",
  attempt: "33333333-3333-4333-8333-333333333333",
};

describe("external-agent lifecycle ownership", () => {
  it("settles Run, Praxis, Mission, and agent session when a harness limit ends ownership", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (
        sql.includes("FROM agent_sessions session") &&
        sql.includes("ORDER BY session.started_at")
      )
        return {
          rowCount: 1,
          rows: [
            {
              agentSessionId: ids.agent,
              missionId: ids.mission,
              projectId: ids.project,
              status: "active",
            },
          ],
        };
      if (sql.includes("FROM adaptive_sessions adaptive"))
        return { rowCount: 1, rows: [{ id: ids.praxis }] };
      return { rowCount: 0, rows: [] };
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM runs run"))
          return {
            rowCount: 1,
            rows: [
              {
                runId: ids.run,
                attemptId: ids.attempt,
                missionId: ids.mission,
                objectiveId: ids.objective,
                agentSessionId: ids.agent,
                projectId: ids.project,
              },
            ],
          };
        if (sql.includes("UPDATE agent_sessions session SET"))
          return {
            rowCount: 1,
            rows: [{ agentSessionId: ids.agent, missionId: ids.mission }],
          };
        return { rowCount: 1, rows: [] };
      }),
    };
    const database = {
      query,
      transaction: vi.fn(async (work: (value: typeof client) => unknown) => work(client)),
    };
    const praxis = {
      settleExternalOwnerLoss: vi.fn(async () => ({
        state: "cancelled",
        reconciliationRequired: false,
        replayed: false,
      })),
    };
    const events = { emit: vi.fn(async () => undefined) };
    const service = new ExternalAgentLifecycleService(
      database as never,
      praxis as never,
      events as never,
    );

    const result = await service.terminate(
      { kind: "service", subject: "scry-service" },
      ids.external,
      { reasonCode: "MAX_TOOL_CALLS_EXCEEDED" },
    );

    expect(result).toMatchObject({
      settled: true,
      replayed: false,
      sessions: [ids.agent],
      runs: [ids.run],
      reasonCode: "MAX_TOOL_CALLS_EXCEEDED",
    });
    expect(praxis.settleExternalOwnerLoss).toHaveBeenCalledWith(
      expect.anything(),
      ids.praxis,
      "MAX_TOOL_CALLS_EXCEEDED",
      expect.stringContaining(ids.external),
    );
    expect(statements.join("\n")).toContain("state='infrastructure_error'");
    expect(statements.join("\n")).toContain("mission_objectives SET status='blocked'");
    expect(statements.join("\n")).toContain("status='interrupted'");
    expect(statements.join("\n")).toContain("resume_pointer");
    expect(events.emit).toHaveBeenCalledWith(
      "runtime",
      expect.objectContaining({
        name: "external_agent.lifecycle_settled",
        reasonCode: "MAX_TOOL_CALLS_EXCEEDED",
        causality: expect.objectContaining({
          projectId: ids.project,
          missionId: ids.mission,
          objectiveId: ids.objective,
          agentSessionId: ids.agent,
          runId: ids.run,
          correlationId: ids.external,
        }),
      }),
    );
  });

  it("persists the runtime-owner event and retrieves it through the project dashboard query", async () => {
    const retained: Array<Record<string, any>> = [];
    const store = {
      write: vi.fn(async (event: Record<string, any>) => retained.push(event)),
      query: vi.fn(async (_scope: unknown, input: Record<string, unknown>) => ({
        items: retained.filter(
          (event) =>
            event.causality?.projectId === input.projectId &&
            event.causality?.correlationId === input.correlationId,
        ),
        nextCursor: null,
      })),
    };
    const events = new OperationalEvents(store as never);
    const database = lifecycleDatabase();
    const service = new ExternalAgentLifecycleService(
      database as never,
      {
        settleExternalOwnerLoss: vi.fn(async () => ({
          state: "cancelled",
          reconciliationRequired: false,
          replayed: false,
        })),
      } as never,
      events,
    );

    await service.terminate({ kind: "service", subject: "scry-service" }, ids.external, {
      reasonCode: "MAX_TOOL_CALLS_EXCEEDED",
    });
    const controller = new OperationalEventsController(events, store as never);
    const page = await controller.query(
      {
        kind: "user",
        subject: "owner-1",
        userId: "owner-1",
        email: "owner@example.test",
        workspaceId: "44444444-4444-4444-8444-444444444444",
        role: "owner",
      },
      { limit: 50, projectId: ids.project, correlationId: ids.external },
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      name: "external_agent.lifecycle_settled",
      causality: {
        projectId: ids.project,
        missionId: ids.mission,
        objectiveId: ids.objective,
        agentSessionId: ids.agent,
        runId: ids.run,
        correlationId: ids.external,
      },
    });
    expect(store.query).toHaveBeenCalledWith(
      { workspaceId: "44444444-4444-4444-8444-444444444444", projectId: ids.project },
      { limit: 50, projectId: ids.project, correlationId: ids.external },
    );
  });

  it("uses the same canonical settlement for abrupt lease expiry", async () => {
    const database = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ externalRunId: ids.external }],
      })),
    };
    const service = new ExternalAgentLifecycleService(database as never, {} as never, {} as never);
    const terminate = vi.spyOn(service, "terminate").mockResolvedValue({ settled: true } as never);

    await expect(service.recoverExpiredLeases()).resolves.toEqual([ids.external]);
    expect(terminate).toHaveBeenCalledWith(
      { kind: "service", subject: "scry-service" },
      ids.external,
      { reasonCode: "EXTERNAL_AGENT_LEASE_EXPIRED" },
    );
  });

  it("replays a terminal correlated session without emitting a false transition", async () => {
    const database = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [
          {
            agentSessionId: ids.agent,
            missionId: ids.mission,
            projectId: ids.project,
            status: "completed",
          },
        ],
      })),
      transaction: vi.fn(),
    };
    const events = { emit: vi.fn() };
    const service = new ExternalAgentLifecycleService(
      database as never,
      {} as never,
      events as never,
    );

    await expect(
      service.terminate({ kind: "service", subject: "scry-service" }, ids.external, {
        reasonCode: "EXTERNAL_AGENT_HARNESS_COMPLETED",
      }),
    ).resolves.toMatchObject({ settled: true, replayed: true, owned: true });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("run.state='infrastructure_error'"),
      [ids.external, null],
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("service-authenticates one-time factual adoption of a legacy active session", async () => {
    const database = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ externalRunId: null, status: "active", provider: "codex", model: null }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };
    const service = new ExternalAgentLifecycleService(database as never, {} as never, {} as never);
    const terminate = vi.spyOn(service, "terminate").mockResolvedValue({ settled: true } as never);
    const controller = new LegacyExternalAgentLifecycleController(service);
    const input = {
      externalRunId: ids.external,
      experimentId: ids.external,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasonCode: "MAX_TOOL_CALLS_EXCEEDED" as const,
    };

    expect(() =>
      controller.terminate(
        ids.agent,
        {
          kind: "user",
          subject: "user-1",
          userId: "user-1",
          email: "owner@example.test",
          workspaceId: "44444444-4444-4444-8444-444444444444",
          role: "owner",
        },
        input,
      ),
    ).toThrow("Legacy lifecycle settlement requires service authentication");

    await expect(
      controller.terminate(ids.agent, { kind: "service", subject: "scry-service" }, input),
    ).resolves.toEqual({ settled: true });
    expect(database.query.mock.calls[1]?.[0]).toContain("external_run_id=$2");
    expect(database.query.mock.calls[1]?.[1]).toEqual([
      ids.agent,
      ids.external,
      "deepseek",
      "deepseek-v4-flash",
      ids.external,
    ]);
    expect(terminate).toHaveBeenCalledWith(
      { kind: "service", subject: "scry-service" },
      ids.external,
      { reasonCode: "MAX_TOOL_CALLS_EXCEEDED" },
    );
  });
});

function lifecycleDatabase() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("ORDER BY session.started_at"))
      return {
        rowCount: 1,
        rows: [
          {
            agentSessionId: ids.agent,
            missionId: ids.mission,
            projectId: ids.project,
            status: "active",
          },
        ],
      };
    if (sql.includes("FROM adaptive_sessions adaptive")) return { rowCount: 0, rows: [] };
    return { rowCount: 0, rows: [] };
  });
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM runs run"))
        return {
          rowCount: 1,
          rows: [
            {
              runId: ids.run,
              attemptId: ids.attempt,
              missionId: ids.mission,
              objectiveId: ids.objective,
              agentSessionId: ids.agent,
              projectId: ids.project,
            },
          ],
        };
      if (sql.includes("UPDATE agent_sessions session SET"))
        return {
          rowCount: 1,
          rows: [{ agentSessionId: ids.agent, missionId: ids.mission }],
        };
      return { rowCount: 1, rows: [] };
    }),
  };
  return {
    query,
    transaction: vi.fn(async (work: (value: typeof client) => unknown) => work(client)),
  };
}
