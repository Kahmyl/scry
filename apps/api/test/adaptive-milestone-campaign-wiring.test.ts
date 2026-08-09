import { describe, expect, it } from "vitest";

import { milestoneCommands } from "../scripts/adaptive-milestone-checks.js";

describe("adaptive milestone campaign wiring", () => {
  it.each(["M2", "M3", "M4", "M5"] as const)(
    "%s has concrete, uniquely identified required commands",
    (milestone) => {
      const commands = milestoneCommands(milestone);
      expect(commands.length).toBeGreaterThan(2);
      expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
      expect(commands.every((command) => command.command === "pnpm")).toBe(true);
      expect(commands.every((command) => command.args.length > 0)).toBe(true);
    },
  );

  it("keeps database-backed M3 and M4 checks mandatory", () => {
    expect(milestoneCommands("M3").find((command) => command.id === "m3-durable-repository"))
      .toMatchObject({ requiredEnvironment: ["SCRY_AUTHORING_TEST_DATABASE_URL"] });
    expect(
      milestoneCommands("M4").find((command) => command.id === "m4-certification-publication"),
    ).toMatchObject({ requiredEnvironment: ["SCRY_AUTHORING_TEST_DATABASE_URL"] });
  });

  it("keeps the strict corpus gate unconditional for M5", () => {
    expect(milestoneCommands("M5").find((command) => command.id === "m5-authoring-release"))
      .toMatchObject({
        requiredEnvironment: ["SCRY_AUTHORING_TEST_DATABASE_URL", "SCRY_VITRACT_PREVIEW_E2E"],
      });
  });
});
