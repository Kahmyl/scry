import { describe, expect, it, vi } from "vitest";

import { ScryRepository } from "../src/access/index.js";

describe("Run current Praxis observation", () => {
  it("loads the authoritative current binding separately from immutable execution provenance", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const currentPraxisSessionId = "22222222-2222-4222-8222-222222222222";
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
      rowCount: 1,
      rows: [
        {
          id: runId,
          executionSnapshot: {
            praxisSessionId: "33333333-3333-4333-8333-333333333333",
          },
          currentPraxisSession: {
            id: currentPraxisSessionId,
            epoch: 2,
            state: "active",
          },
        },
      ],
    }));

    const run = await new ScryRepository({ query } as never).getRun(
      { kind: "service", subject: "scry-service" },
      runId,
    );

    expect(query.mock.calls[0]?.[0]).toContain("run_praxis_sessions");
    expect(query.mock.calls[0]?.[0]).toContain('AS "currentPraxisSession"');
    expect(run).toMatchObject({
      executionSnapshot: { praxisSessionId: "33333333-3333-4333-8333-333333333333" },
      currentPraxisSession: { id: currentPraxisSessionId, epoch: 2, state: "active" },
    });
  });
});
