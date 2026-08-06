import { describe, expect, it, vi } from "vitest";

import { AuthoringRuntimeRepository } from "../src/authoring/index.js";

function harness(responses: Array<{ rowCount: number; rows: unknown[] }>) {
  const client = {
    query: vi.fn(
      async (_text: string, _values?: unknown[]) =>
        responses.shift() ?? { rowCount: 1, rows: [] },
    ),
  };

  const database = {
    query: vi.fn(
      async (_text: string, _values?: unknown[]) =>
        responses.shift() ?? { rowCount: 1, rows: [] },
    ),
    transaction: vi.fn(
      async (work: (value: typeof client) => Promise<unknown>) => work(client),
    ),
  };

  return {
    repository: new AuthoringRuntimeRepository(database as never),
    database,
    client,
  };
}

describe("authoring browser lease ownership", () => {
  it("claims one provisioning lease with a fenced runtime owner", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            probeSessionId: "11111111-1111-4111-8111-111111111111",
            browserLeaseId: "22222222-2222-4222-8222-222222222222",
            environmentId: "33333333-3333-4333-8333-333333333333",
            policy: {},
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            probeSessionId: "11111111-1111-4111-8111-111111111111",
            browserLeaseId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      },
    ]);

    await expect(repository.claimNext("worker-1")).resolves.toMatchObject({
      probeSessionId: "11111111-1111-4111-8111-111111111111",
      browserLeaseId: "22222222-2222-4222-8222-222222222222",
    });

    expect(String(client.query.mock.calls[0]![0])).toContain(
      "FOR UPDATE OF lease SKIP LOCKED",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain(
      "runtime_owner_id=$2",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain(
      "state='provisioning'",
    );
  });

  it("activates and heartbeats only the current runtime owner", async () => {
    const { repository, database } = harness([
      { rowCount: 1, rows: [{ id: "lease-id" }] },
      { rowCount: 1, rows: [{ id: "lease-id" }] },
    ]);

    await expect(repository.activate("lease-id", "worker-1")).resolves.toBe(true);
    await expect(repository.heartbeat("lease-id", "worker-1")).resolves.toBe(true);

    expect(String(database.query.mock.calls[0]![0])).toContain(
      "runtime_owner_id=$2",
    );
    expect(String(database.query.mock.calls[0]![0])).toContain(
      "state='active'",
    );
    expect(String(database.query.mock.calls[2]![0])).toContain(
      "heartbeat_at=now()",
    );
  });

  it("releases the lease and terminalizes the authoring session atomically", async () => {
    const { repository, client } = harness([
      { rowCount: 1, rows: [{ probeSessionId: "probe-id" }] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
    ]);

    await expect(
      repository.release("lease-id", "worker-1", "completed"),
    ).resolves.toBe(true);

    expect(String(client.query.mock.calls[0]![0])).toContain(
      "runtime_owner_id=$2",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain(
      "state='released'",
    );
    expect(String(client.query.mock.calls[2]![0])).toContain(
      "status=$2",
    );
    expect(client.query.mock.calls[2]![1]).toEqual([
      "probe-id",
      "completed",
    ]);
    expect(String(client.query.mock.calls[3]![0])).toContain("probe_events");
  });

  it("marks stale owned leases and authoring sessions as crashed", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            browserLeaseId: "lease-id",
            probeSessionId: "probe-id",
          },
        ],
      },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
    ]);

    await expect(repository.recoverStale(new Date(0))).resolves.toEqual([
      "probe-id",
    ]);

    expect(String(client.query.mock.calls[0]![0])).toContain(
      "FOR UPDATE OF lease SKIP LOCKED",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain(
      "state='crashed'",
    );
    expect(String(client.query.mock.calls[2]![0])).toContain(
      "status='crashed'",
    );
    expect(String(client.query.mock.calls[3]![0])).toContain(
      "authoring_runtime_crashed",
    );
  });
});
