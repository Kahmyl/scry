import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectedRunService } from "../src/runs/services/agent-directed-run.service.js";

const principal = { kind: "service", subject: "scry-service" } as const;
function fixture(
  options: { live?: boolean; replay?: string; state?: string; scoped?: boolean } = {},
) {
  const runId = randomUUID(),
    sessionId = randomUUID(),
    agentSessionId = randomUUID();
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM runs WHERE"))
      return { rowCount: 1, rows: [{ state: options.state ?? "running", agentSessionId }] };
    if (sql.includes("idempotency_key=$2"))
      return {
        rowCount: options.replay ? 1 : 0,
        rows: options.replay
          ? [{ praxisSessionId: options.replay === "same" ? sessionId : options.replay, epoch: 2 }]
          : [],
      };
    if (sql.includes("SELECT 1 FROM adaptive_sessions"))
      return { rowCount: options.scoped === false ? 0 : 1, rows: [{}] };
    if (sql.includes("SELECT session.id")) return { rowCount: options.live ? 1 : 0, rows: [] };
    return { rowCount: 1, rows: [{ epoch: 3 }] };
  });
  const service = new AgentDirectedRunService(
    { transaction: (fn: any) => fn({ query }) } as never,
    {
      requireWriteAccess: vi.fn(),
      getRun: async () => ({
        projectId: randomUUID(),
        missionId: randomUUID(),
        objectiveId: randomUUID(),
        environmentId: randomUUID(),
        executionSnapshot: { executionModel: "agent_directed_v1" },
      }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { assertAcceptingWork: vi.fn() } as never,
    {} as never,
  );
  return {
    query,
    agentSessionId,
    attach: () =>
      service.attach(principal, runId, { praxisSessionId: sessionId, idempotencyKey: "rotation" }),
  };
}
describe("canonical Run owner rotation", () => {
  it.each([
    [{ live: true }, "RUN_PRAXIS_PREVIOUS_OWNER_NOT_TERMINAL"],
    [{ replay: randomUUID() }, "RUN_PRAXIS_ATTACHMENT_IDEMPOTENCY_CONFLICT"],
    [{ state: "passed" }, "RUN_NOT_RUNNING"],
    [{ scoped: false }, "RUN_PRAXIS_SESSION_SCOPE_MISMATCH"],
  ] as const)("fails closed before detachment: %s", async (options, code) => {
    const f = fixture(options);
    await expect(f.attach()).rejects.toMatchObject({ response: { code } });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("SET detached_at"))).toBe(false);
  });
  it("admits a fresh exact agent owner only after previous closure", async () => {
    const f = fixture();
    await expect(f.attach()).resolves.toMatchObject({ epoch: 3, replayed: false });
    expect(
      f.query.mock.calls.find(([sql]) => sql.includes("SELECT 1 FROM adaptive_sessions"))?.[0],
    ).toContain("agent_session_id=$6");
  });
  it("replays the historical exact association without detaching a current owner", async () => {
    const f = fixture({ replay: "same", live: true });
    await expect(f.attach()).resolves.toMatchObject({ epoch: 2, replayed: true });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("SET detached_at"))).toBe(false);
  });
});
