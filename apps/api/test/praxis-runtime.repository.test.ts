import { describe, expect, it, vi } from "vitest";

import { PraxisRuntimeRepository } from "../src/praxis/repositories/praxis-runtime.repository.js";

describe("PraxisRuntimeRepository", () => {
  it("claims queued requests with a worker fence", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: "request-1", status: "queued", payload: {} }],
        })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [],
        }),
    };

    const db = {
      transaction: vi.fn(async (fn: (c: typeof client) => unknown) =>
        fn(client),
      ),
    };

    const repository = new PraxisRuntimeRepository(db as never);

    const result = await repository.claim(
      "request-1",
      "worker-1",
      "claim-1",
    );

    expect(result).toMatchObject({
      id: "request-1",
      workerId: "worker-1",
      claimToken: "claim-1",
    });

    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it("returns inspection state", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            id: "request-1",
            status: "completed",
            result: { resolution: "resolved" },
          },
        ],
      })),
    };

    const repository = new PraxisRuntimeRepository(db as never);

    await expect(repository.get("request-1")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("asserts browser lease ownership", async () => {
    const db = {
      query: vi.fn(async () => ({
        rowCount: 1,
      })),
    };

    const repository = new PraxisRuntimeRepository(db as never);

    await expect(
      repository.assertOwnedBrowserLease(
        "lease-1",
        "probe-1",
        "worker-1",
      ),
    ).resolves.toBe(true);
  });
});
