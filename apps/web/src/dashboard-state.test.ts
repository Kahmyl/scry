import { describe, expect, it } from "vitest";

import { reconcileProjectSelection, resolveDashboardView } from "./dashboard-state.js";

describe("dashboard state", () => {
  it("keeps the dashboard separate from Missions", () => {
    expect(resolveDashboardView("/dashboard")).toBe("overview");
    expect(resolveDashboardView("/dashboard/missions")).toBe("missions");
    expect(resolveDashboardView("/dashboard/missions/mission-1")).toBe("missions");
    expect(resolveDashboardView("/dashboard/missions/mission-1/flows")).toBe("missions");
    expect(resolveDashboardView("/dashboard/flows")).toBe("missions");
  });

  it("clears a stale project selection when the workspace is empty", () => {
    expect(reconcileProjectSelection([], "deleted-project")).toBe("");
  });

  it("selects an available project when the stored selection is stale", () => {
    expect(reconcileProjectSelection([{ id: "project-1" }], "deleted-project")).toBe("project-1");
  });

  it("preserves a valid project selection", () => {
    expect(reconcileProjectSelection([{ id: "project-1" }, { id: "project-2" }], "project-2")).toBe("project-2");
  });
});
