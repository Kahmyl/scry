import { describe, expect, it } from "vitest";

import { waitForHealthyObservationRuntime } from "../src/workers/observation-runtime-readiness.js";

describe("worker observation-runtime startup readiness", () => {
  it("recovers from a transient unhealthy attestation without requiring process restart", async () => {
    let now = 0;
    let attempts = 0;
    const sleeps: number[] = [];

    const result = await waitForHealthyObservationRuntime(
      async () => {
        attempts += 1;

        return {
          healthy: attempts >= 2,
          attempt: attempts,
        };
      },
      {
        timeoutMs: 45_000,
        retryIntervalMs: 1_000,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );

    expect(result).toEqual({
      healthy: true,
      attempt: 2,
    });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("stays fail closed when the bounded startup retry window is exhausted", async () => {
    let now = 0;
    let attempts = 0;

    const result = await waitForHealthyObservationRuntime(
      async () => {
        attempts += 1;

        return {
          healthy: false,
          attempt: attempts,
        };
      },
      {
        timeoutMs: 2_000,
        retryIntervalMs: 1_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(result).toEqual({
      healthy: false,
      attempt: 3,
    });
    expect(attempts).toBe(3);
  });

  it("does not convert verifier exceptions into retryable unhealthy attestations", async () => {
    let attempts = 0;

    await expect(
      waitForHealthyObservationRuntime(
        async () => {
          attempts += 1;
          throw new Error("browser verifier failed");
        },
        {
          timeoutMs: 45_000,
          retryIntervalMs: 1_000,
        },
      ),
    ).rejects.toThrow("browser verifier failed");

    expect(attempts).toBe(1);
  });
});
