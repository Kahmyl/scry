import { describe, expect, it, vi } from "vitest";

import { UnknownMutationAdministrationService } from "../src/runtime/services/unknown-mutation-administration.service.js";

function fixture(overrides: Partial<Record<string, string>> = {}) {
  const row = {
    protectedOperationId: "protected-operation",
    protectedState: "recovery_required",
    protectedOutcome: "unknown",
    dispatchState: "acknowledged",
    dispatchSemantics: "mutation",
    adaptiveState: "failed",
    adaptiveOutcome: "unknown",
    sessionState: "recovery_required",
    adaptiveReason: "PUBLIC_VALUE_UNAVAILABLE",
    sessionReason: "PUBLIC_VALUE_UNAVAILABLE",
    ...overrides,
  };
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT protected.id")) return { rowCount: 1, rows: [row] };
      return { rowCount: 1, rows: [{}] };
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (value: { query: typeof client.query }) => unknown) =>
      work(client),
    ),
  };
  return {
    service: new UnknownMutationAdministrationService(database as never),
    client,
  };
}

describe("unknown mutation administration", () => {
  it("atomically closes only an acknowledged post-dispatch unknown without changing truth", async () => {
    const { service, client } = fixture();
    await expect(
      service.closeHistoricalUnknown({ sessionId: "session", operationId: "operation" }),
    ).resolves.toEqual({ classification: "unknown_historical_closed", replayed: false });

    const statements = client.query.mock.calls.map(([sql]) => sql as string);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("state='abandoned'"),
        expect.stringContaining("'recovery_required','abandoned'"),
        expect.stringContaining("state='cancelled'"),
        expect.stringContaining("'session_cancelled'"),
      ]),
    );
    expect(statements.join("\n")).not.toContain("mutation_outcome='not_applied'");
    expect(statements.join("\n")).not.toContain("mutation_outcome='applied'");
    expect(statements.join("\n")).not.toContain("ready_to_dispatch");
  });

  it.each([
    ["protectedState", "preparing"],
    ["protectedOutcome", "not_applied"],
    ["dispatchState", "started"],
    ["dispatchSemantics", "read_only"],
    ["adaptiveState", "running"],
    ["adaptiveOutcome", "not_applied"],
    ["sessionState", "active"],
  ])("fails closed when %s is outside the exact administrative boundary", async (key, value) => {
    const { service, client } = fixture({ [key]: value });
    await expect(
      service.closeHistoricalUnknown({ sessionId: "session", operationId: "operation" }),
    ).rejects.toThrow("UNKNOWN_MUTATION_ADMINISTRATIVE_STATE_INVALID");
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("is idempotent only for the exact already-closed truth-preserving state", async () => {
    const { service, client } = fixture({
      protectedState: "abandoned",
      sessionState: "cancelled",
      adaptiveReason: "HISTORICAL_MUTATION_ADMINISTRATIVELY_CLOSED",
      sessionReason: "HISTORICAL_MUTATION_ADMINISTRATIVELY_CLOSED",
    });
    await expect(
      service.closeHistoricalUnknown({ sessionId: "session", operationId: "operation" }),
    ).resolves.toEqual({ classification: "unknown_historical_closed", replayed: true });
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
