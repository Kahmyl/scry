import { describe, expect, it } from "vitest";

import {
  referenceReplacementFixture,
  verifyStaleReferenceDidNotDispatch,
  withFixture,
} from "../src/index.js";

async function emit(
  eventUrl: string,
  event:
    | {
        type: "mutated";
      }
    | {
        type: "dispatch";
        target: "original" | "replacement";
      },
): Promise<void> {
  const response = await fetch(eventUrl, {
    method: "POST",

    headers: {
      "content-type": "application/json",
    },

    body: JSON.stringify(event),
  });

  if (response.status !== 204) {
    const body = await response.text();

    throw new Error(`fixture event returned HTTP ${response.status}: ${body}`);
  }
}

describe("Assurance browser fixtures", () => {
  it("serves the reference replacement scenario", async () => {
    await withFixture(referenceReplacementFixture, undefined, async (session) => {
      const response = await fetch(session.value.scenarioUrl);

      expect(response.status).toBe(200);

      const html = await response.text();

      expect(html).toContain('id="target"');

      expect(html).toContain("reference-replacement/event");
    });
  });

  it("qualifies no-dispatch after a proven replacement", async () => {
    await withFixture(referenceReplacementFixture, undefined, async (session) => {
      await emit(session.value.eventUrl, {
        type: "mutated",
      });

      const truth = await session.readGroundTruth();

      expect(truth).toEqual({
        mutationCount: 1,
        originalDispatches: 0,
        replacementDispatches: 0,
      });

      const observation = verifyStaleReferenceDidNotDispatch(truth);

      expect(observation.status).toBe("pass");

      expect(observation.evidence).toHaveLength(1);
    });
  });

  it("does not pass when the replacement was never established", async () => {
    await withFixture(referenceReplacementFixture, undefined, async (session) => {
      const truth = await session.readGroundTruth();

      const observation = verifyStaleReferenceDidNotDispatch(truth);

      expect(observation.status).toBe("inconclusive");

      expect(observation.reasonCode).toBe("REFERENCE_REPLACEMENT_NOT_OBSERVED");
    });
  });

  it("negative control: detects dispatch against the replacement", async () => {
    await withFixture(referenceReplacementFixture, undefined, async (session) => {
      await emit(session.value.eventUrl, {
        type: "mutated",
      });

      await emit(session.value.eventUrl, {
        type: "dispatch",
        target: "replacement",
      });

      const truth = await session.readGroundTruth();

      expect(truth.replacementDispatches).toBe(1);

      const observation = verifyStaleReferenceDidNotDispatch(truth);

      expect(observation.status).toBe("fail");

      expect(observation.reasonCode).toBe("STALE_REFERENCE_DISPATCH_OBSERVED");
    });
  });

  it("negative control: detects dispatch against the stale original", async () => {
    await withFixture(referenceReplacementFixture, undefined, async (session) => {
      await emit(session.value.eventUrl, {
        type: "mutated",
      });

      await emit(session.value.eventUrl, {
        type: "dispatch",
        target: "original",
      });

      const truth = await session.readGroundTruth();

      expect(truth.originalDispatches).toBe(1);

      const observation = verifyStaleReferenceDidNotDispatch(truth);

      expect(observation.status).toBe("fail");
    });
  });
});
