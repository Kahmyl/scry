import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("publish_mission_report ownership", () => {
  it("has exactly one canonical Mission-owned registration", async () => {
    const missionIndex = await readFile(
      new URL("../src/tools/missions/index.ts", import.meta.url),
      "utf8",
    );

    const missionTool = await readFile(
      new URL("../src/tools/missions/publish-mission-report.tool.ts", import.meta.url),
      "utf8",
    );

    const runIndex = await readFile(new URL("../src/tools/runs/index.ts", import.meta.url), "utf8");

    expect(missionIndex).toContain("registerPublishMissionReportTool(server, client);");

    expect(runIndex).not.toContain("registerPublishMissionReportTool");

    expect(missionTool).toContain('"publish_mission_report"');

    expect(missionTool).toContain("publishMissionReportSchema");

    expect(missionTool).toContain("requireCurrentRelease");

    expect(missionTool).toContain("agentSessionFinalization");

    expect(missionTool).toContain("input.agentSessionId");

    expect(missionTool).toContain('"completed"');
  });
});
