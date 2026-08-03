import { describe, expect, it } from "vitest";

import {
  dashboardAuthority,
  reconcileProjectSelection,
  resolveDashboardView,
  veilPolicyIdentity,
  veilTighteningOptions,
} from "./dashboard-state.js";

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
    expect(reconcileProjectSelection([{ id: "project-1" }, { id: "project-2" }], "project-2")).toBe(
      "project-2",
    );
  });

  it("makes MCP authoritative while retaining explicit human safety controls", () => {
    expect(dashboardAuthority.authoringSurface).toBe("mcp");
    expect(dashboardAuthority.prohibitedDashboardMutations).toContain("run_rerun");
    expect(dashboardAuthority.retainedHumanControls).toContain("active_run_cancel");
    expect(dashboardAuthority.retainedHumanControls).toContain("calibration_approval");
  });

  it("offers only stricter Veil profiles", () => {
    expect(veilTighteningOptions("balanced")).toEqual(["private", "minimal_capture"]);
    expect(veilTighteningOptions("private")).toEqual(["minimal_capture"]);
    expect(veilTighteningOptions("minimal_capture")).toEqual([]);
  });

  it("renders the exact API policy digest identity", () => {
    expect(veilPolicyIdentity("a".repeat(64))).toBe("a".repeat(12));
    expect(() => veilPolicyIdentity("not-a-digest")).toThrow("VEIL_POLICY_DIGEST_INVALID");
  });
});
