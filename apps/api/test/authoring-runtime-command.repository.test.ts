import { describe, expect, it, vi } from "vitest";

import { AuthoringRuntimeCommandRepository } from "../src/authoring/index.js";

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
    repository: new AuthoringRuntimeCommandRepository(database as never),
    database,
    client,
  };
}

describe("authoring runtime command transport", () => {
  it("enqueues one idempotent command against the current live lease", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            probeSessionId: "11111111-1111-4111-8111-111111111111",
            browserLeaseId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      },
      {
        rowCount: 1,
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            state: "pending",
            replayed: false,
          },
        ],
      },
    ]);

    await expect(
      repository.enqueue({
        probeSessionId: "11111111-1111-4111-8111-111111111111",
        missionId: "44444444-4444-4444-8444-444444444444",
        agentSessionId: "55555555-5555-4555-8555-555555555555",
        type: "observe_document",
        payload: {},
        idempotencyKey: "observe-command-1",
      }),
    ).resolves.toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      state: "pending",
      replayed: false,
    });

    expect(String(client.query.mock.calls[0]![0])).toContain(
      "authoring.status='active'",
    );
    expect(String(client.query.mock.calls[0]![0])).toContain(
      "lease.state='active'",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain(
      "ON CONFLICT (probe_session_id,idempotency_key)",
    );
  });

  it("rejects an idempotency key reused for a different request", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            probeSessionId: "11111111-1111-4111-8111-111111111111",
            browserLeaseId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      },
      {
        rowCount: 0,
        rows: [],
      },
    ]);

    await expect(
      repository.enqueue({
        probeSessionId: "11111111-1111-4111-8111-111111111111",
        missionId: "44444444-4444-4444-8444-444444444444",
        agentSessionId: "55555555-5555-4555-8555-555555555555",
        type: "observe_document",
        payload: {
          includeAccessibilityTree: true,
        },
        idempotencyKey: "observe-command-1",
      }),
    ).rejects.toThrow(
      "AUTHORING_COMMAND_IDEMPOTENCY_CONFLICT",
    );

    const sql = String(client.query.mock.calls[1]![0]);

    expect(sql).toContain("request_hash");
    expect(sql).toContain(
      "authoring_runtime_commands.request_hash=EXCLUDED.request_hash",
    );
    expect(client.query.mock.calls[1]![1]?.[5]).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("claims the next pending command only for the active runtime owner", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            probeSessionId: "11111111-1111-4111-8111-111111111111",
            browserLeaseId: "22222222-2222-4222-8222-222222222222",
            type: "observe_document",
            payload: {},
            claimToken: "66666666-6666-4666-8666-666666666666",
          },
        ],
      },
    ]);

    await expect(
      repository.claimNext(
        "22222222-2222-4222-8222-222222222222",
        "worker-1",
      ),
    ).resolves.toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      claimToken: "66666666-6666-4666-8666-666666666666",
    });

    const sql = String(client.query.mock.calls[0]![0]);

    expect(sql).toContain("FOR UPDATE OF command SKIP LOCKED");
    expect(sql).toContain("lease.runtime_owner_id=$2");
    expect(sql).toContain("lease.state='active'");
    expect(sql).toContain("command.state='pending'");
  });

  it("completes a claimed command and persists one safe result atomically", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            probeSessionId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
    ]);

    await expect(
      repository.complete({
        commandId: "33333333-3333-4333-8333-333333333333",
        browserLeaseId: "22222222-2222-4222-8222-222222222222",
        workerId: "worker-1",
        claimToken: "66666666-6666-4666-8666-666666666666",
        safeResult: {
          documentEpoch: 1,
          url: "https://example.test",
        },
      }),
    ).resolves.toBe(true);

    expect(String(client.query.mock.calls[0]![0])).toContain(
      "claimed_by_runtime_owner_id=$3",
    );
    expect(String(client.query.mock.calls[0]![0])).toContain(
      "claim_token=$4",
    );
    expect(String(client.query.mock.calls[1]![0])).toContain(
      "SET state=$2",
    );
    expect(client.query.mock.calls[1]![1]).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "completed",
    ]);
    expect(String(client.query.mock.calls[2]![0])).toContain(
      "authoring_runtime_command_results",
    );
    expect(client.query.mock.calls[2]![1]).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
      "completed",
      JSON.stringify({
        documentEpoch: 1,
        url: "https://example.test",
      }),
      null,
    ]);
  });

  it("fails a claimed command with a safe error and retained claim provenance", async () => {
    const { repository, client } = harness([
      {
        rowCount: 1,
        rows: [
          {
            probeSessionId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
    ]);

    await expect(
      repository.fail({
        commandId: "33333333-3333-4333-8333-333333333333",
        browserLeaseId: "22222222-2222-4222-8222-222222222222",
        workerId: "worker-1",
        claimToken: "66666666-6666-4666-8666-666666666666",
        safeError: {
          code: "AUTHORING_COMMAND_FAILED",
        },
      }),
    ).resolves.toBe(true);

    expect(String(client.query.mock.calls[1]![0])).toContain(
      "SET state=$2",
    );
    expect(client.query.mock.calls[1]![1]).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "failed",
    ]);
    expect(String(client.query.mock.calls[2]![0])).toContain(
      "safe_error",
    );
    expect(client.query.mock.calls[2]![1]).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
      "failed",
      null,
      JSON.stringify({
        code: "AUTHORING_COMMAND_FAILED",
      }),
    ]);
  });
});
