import { describe, it, expect, vi } from "vitest";
import {
  customerReport,
  customerRun,
  customerMission,
  runRecoveryStatus,
} from "../src/browser-execution/customer-reporting.js";
import { BrowserDashboardController } from "../src/browser-execution/controllers/browser-dashboard.controller.js";
import type { Principal } from "../src/auth/auth.types.js";

const presentation = {
  subject: "application",
  scope: ["Save and reopen a note"],
  checks: [
    {
      title: "Saved note",
      expected: "Revised note after reopening",
      actual: "The revised note was visible",
      status: "matched_expectation",
      evidence: [],
    },
    { title: "Sharing", actual: "Not reached in this test", status: "not_tested", evidence: [] },
  ],
  observations: [],
  limitations: ["Only one browser was tested"],
};
const report = {
  id: "report",
  missionId: "mission",
  projectId: "project",
  missionTitle: "Notes",
  summary: "Revised note saved and reopened",
  state: "final",
  evidenceDigest: "private-chain",
  safeReport: {
    presentation,
    executionFailure: "PRIVATE_FAILURE",
    operatorLog: { errorCode: "PRIVATE_CODE" },
  },
};
const user = (
  role: "owner" | "admin" | "member" | "viewer",
  credentialKind: "user" | "mcp" = "user",
): Principal => ({
  kind: "user",
  credentialKind,
  subject: "customer",
  userId: "customer",
  email: "customer@example.test",
  workspaceId: "customer-workspace",
  role,
});
const service: Principal = { kind: "service", credentialKind: "service", subject: "scry-service" };

describe("customer application reporting boundary", () => {
  it("derives release guidance from actual release facts without promoting an attempt to an application verdict", () => {
    const facts = {
      id: "run",
      state: "failed",
      browserSessionState: "completed",
      ownerReleased: true,
      evidenceSealed: true,
      pendingCommandCount: 0,
    };
    expect(runRecoveryStatus(facts)).toMatchObject({
      browserReleased: true,
      interaction: {
        state: "release_confirmed",
        applicationConclusion: "not_determined",
        next: { actor: "none" },
      },
    });
    expect(runRecoveryStatus({ ...facts, ownerReleased: false })).toMatchObject({
      browserReleased: false,
      interaction: { state: "release_pending", next: { tool: "get_run_status" } },
    });
    expect(runRecoveryStatus({ ...facts, pendingCommandCount: 1 }).browserReleased).toBe(false);
  });
  it("keeps actual app checks including untested scope but strips unrelated diagnostics", () => {
    const result = customerReport(report);
    expect(result.summary).toBe(report.summary);
    expect(result.safeReport).toMatchObject({
      presentation: { subject: "application", checks: presentation.checks },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_|private-chain|operatorLog|executionFailure/,
    );
  });
  it.each([
    { summary: "PRIVATE_LEGACY_FAILURE", safeReport: { legacy: "PRIVATE_LOG" } },
    {
      summary: "PRIVATE_UNCLASSIFIED_SUMMARY",
      safeReport: { presentation: { verified: ["PRIVATE_TOOL_ERROR"], observations: [] } },
    },
    {
      summary: "PRIVATE_INVALID_SUMMARY",
      safeReport: {
        presentation: {
          ...presentation,
          checks: [{ title: "Tool", actual: "PRIVATE_TOOL", status: "passed" }],
        },
      },
    },
  ])(
    "never promotes historical or malformed technical reports to application results",
    (legacy) => {
      const result = customerReport({ ...report, ...legacy });
      expect(result.summary).toMatch(/earlier report/);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private-chain/);
      expect(JSON.stringify(result)).toMatch(/do not infer test results/);
    },
  );
  it("keeps attempt history and missing evidence honest without exposing execution verdicts", () => {
    const raw = {
      id: "run",
      flowName: "Save note",
      state: "failed",
      conclusion: "PRIVATE_HELPER",
      outcomeClassification: "environment_failure",
      activity: [{ errorCode: "PRIVATE_ERROR" }],
      evidence: [
        {
          id: "e",
          state: "complete",
          closureIssue: "integrity_mismatch",
          chainHead: "PRIVATE_CHAIN",
        },
      ],
    };
    const result = customerRun(raw);
    expect(result.state).toBe("ended");
    expect(result.evidence).toEqual([{ id: "e", state: "unavailable" }]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|environment_failure|integrity_mismatch/);
    const mission = customerMission({
      id: "m",
      state: "failed",
      objectives: [{ id: "o", title: "Save note", state: "failed", conclusion: "PRIVATE_FAILURE" }],
      flows: [],
      runs: [{ ...raw, flowId: "flow" }],
    });
    expect(mission.runs).toEqual([{ id: "run", flowId: "flow", state: "ended" }]);
    expect(mission.state).toBe("ended");
    expect(customerRun({ state: "PRIVATE_UNKNOWN_STATE" }).state).toBe("pending");
    expect(JSON.stringify(mission)).not.toMatch(/PRIVATE_|environment_failure/);
  });
  it("separates operator originals from customer projections and preserves workspace filtering", async () => {
    const dashboard = {
      getReport: vi.fn(async () => report),
      listReports: vi.fn(async () => [report]),
      getRun: vi.fn(async () => ({
        id: "r",
        state: "failed",
        activity: [{ errorCode: "PRIVATE_FAILURE" }],
      })),
    };
    const lifecycle = {
      observeMission: vi.fn(async () => ({ id: "m", runs: [], flows: [], objectives: [] })),
    };
    const controller = new BrowserDashboardController(dashboard as never, lifecycle as never);
    expect(JSON.stringify(await controller.getReport("report", user("owner")))).not.toContain(
      "PRIVATE_",
    );
    expect(dashboard.getReport).toHaveBeenLastCalledWith("customer-workspace", "report");
    expect(JSON.stringify(await controller.listReports("project", user("viewer")))).not.toContain(
      "PRIVATE_",
    );
    await controller.getCustomerMission("mission", user("member"));
    expect(lifecycle.observeMission).toHaveBeenCalledWith("customer-workspace", "mission");
    expect(JSON.stringify(await controller.getRun("r", user("owner", "mcp")))).not.toContain(
      "PRIVATE_",
    );
    expect(await controller.getOperatorReport("report", service)).toEqual(report);
    expect(dashboard.getReport).toHaveBeenLastCalledWith(undefined, "report");
    expect(JSON.stringify(await controller.getOperatorRun("r", service))).toContain(
      "PRIVATE_FAILURE",
    );
  });
  it.each(["owner", "admin", "member", "viewer"] as const)(
    "serves only the customer report projection to workspace-scoped MCP %s readers",
    async (role) => {
      const dashboard = {
        getReport: vi.fn(async () => report),
        listReports: vi.fn(async () => [report]),
      };
      const controller = new BrowserDashboardController(dashboard as never, {} as never);
      const principal = user(role, "mcp");
      expect(await controller.getReport("report", principal)).toEqual(customerReport(report));
      expect(dashboard.getReport).toHaveBeenCalledWith("customer-workspace", "report");
      expect(await controller.listReports("project", principal)).toEqual([customerReport(report)]);
      expect(dashboard.listReports).toHaveBeenCalledWith("customer-workspace", "project");
      expect(JSON.stringify(await controller.getReport("report", principal))).not.toMatch(
        /PRIVATE_|private-chain/,
      );
    },
  );
  it.each(["owner", "admin", "member", "viewer"] as const)(
    "denies customer %s access to operator endpoints with both credential kinds",
    (role) => {
      const dashboard = { getReport: vi.fn(), getRun: vi.fn() };
      const controller = new BrowserDashboardController(dashboard as never, {} as never);
      for (const kind of ["user", "mcp"] as const) {
        expect(() => controller.getOperatorReport("r", user(role, kind))).toThrow(
          "Operator access required",
        );
        expect(() => controller.getOperatorRun("r", user(role, kind))).toThrow(
          "Operator access required",
        );
      }
      expect(dashboard.getReport).not.toHaveBeenCalled();
      expect(dashboard.getRun).not.toHaveBeenCalled();
    },
  );
});
