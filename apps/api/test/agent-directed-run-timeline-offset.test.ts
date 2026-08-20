import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("agent-directed Run timeline append offset", () => {
  const source = readFileSync(
    new URL("../src/runs/agent-directed-run.service.ts", import.meta.url),
    "utf8",
  );

  it("starts canonical timeline persistence after the current maximum", () => {
    expect(source).toMatch(
      /\(\s*SELECT\s+COALESCE\s*\(\s*max\(sequence\)\s*\+\s*1\s*,\s*0\s*\)::integer\s+FROM\s+artifact_timeline_entries\s+WHERE\s+attempt_id\s*=\s*\$1\s*\)\s+AS\s+"timelineSequenceOffset"/s,
    );
  });

  it("passes the calculated append offset into canonical report commit", () => {
    expect(source).toMatch(
      /const timelineSequenceOffset[\s\S]*?commitExecutionReport\([\s\S]*?timelineSequenceOffset/,
    );
  });
});
