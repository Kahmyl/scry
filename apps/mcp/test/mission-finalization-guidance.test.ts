import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Mission finalization guidance", () => {
  it("makes runtime closure and agent-session ordering explicit", async () => {
    const publish = await readFile(
      new URL("../src/tools/missions/publish-mission-report.tool.ts", import.meta.url),
      "utf8",
    );

    const closePraxis = await readFile(
      new URL("../src/tools/adaptive-sessions/close-praxis-session.tool.ts", import.meta.url),
      "utf8",
    );

    const endAgent = await readFile(
      new URL("../src/tools/missions/end-agent-session.tool.ts", import.meta.url),
      "utf8",
    );

    expect(publish).toContain(
      "A completed Praxis operation or turn does not itself close the Praxis session",
    );

    expect(publish).toContain("MISSION_RUNTIME_CLOSE_REQUIRED");

    expect(publish).toContain("close_praxis_session before publishing");

    expect(publish).toContain(
      "end_agent_session is the final lifecycle write after the report succeeds",
    );

    expect(closePraxis).toContain("close the session before publish_mission_report");

    expect(endAgent).toContain("publish that report before ending the current agent session");
  });
});
