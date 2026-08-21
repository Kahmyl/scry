import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Mission recording resolver continuity SQL", () => {
  it("orders the DISTINCT projection by its selected text aliases", async () => {
    const source = await readFile(
      new URL("../src/missions/mission-recording-resolver.ts", import.meta.url),
      "utf8",
    );

    const start = source.indexOf("async function resolveContinuity(");

    expect(start).toBeGreaterThanOrEqual(0);

    const scoped = source.slice(start);

    expect(scoped).toMatch(
      /SELECT DISTINCT[\s\S]*?AS "predecessorRunId"[\s\S]*?AS "successorRunId"[\s\S]*?AS "checkpointId"[\s\S]*?AS "restoredByPraxisSessionId"/,
    );

    expect(scoped).toMatch(
      /ORDER BY\s+"predecessorRunId",\s+"successorRunId",\s+"checkpointId",\s+"restoredByPraxisSessionId"/,
    );

    expect(scoped).not.toMatch(
      /ORDER BY\s+checkpoint\.run_id,\s+binding\.run_id,\s+checkpoint\.id,\s+session\.id/,
    );
  });
});
