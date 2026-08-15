import { describe, expect, it } from "vitest";

import {
  defineFixture,
  withFixture,
} from "../src/index.js";

describe("Assurance fixtures", () => {
  it("exposes out-of-band ground truth", async () => {
    const fixture = defineFixture({
      id: "dispatch",
      title: "Dispatch fixture",

      setup: () => ({
        value: {
          origin: "https://fixture.test",
        },

        readGroundTruth: () => ({
          dispatchCount: 1,
        }),
      }),
    });

    await withFixture(
      fixture,
      undefined,
      async session => {
        expect(
          await session.readGroundTruth(),
        ).toEqual({
          dispatchCount: 1,
        });
      },
    );
  });

  it("always tears down even when qualification throws", async () => {
    const lifecycle: string[] = [];

    const fixture = defineFixture({
      id: "cleanup",
      title: "Cleanup fixture",

      setup: () => {
        lifecycle.push("setup");

        return {
          value: {},
          readGroundTruth: () => ({}),
        };
      },

      teardown: () => {
        lifecycle.push("teardown");
      },
    });

    await expect(
      withFixture(
        fixture,
        undefined,
        async () => {
          lifecycle.push("use");
          throw new Error("expected");
        },
      ),
    ).rejects.toThrow("expected");

    expect(lifecycle).toEqual([
      "setup",
      "use",
      "teardown",
    ]);
  });
});
