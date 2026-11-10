import { describe, it, expect, vi } from "vitest";
import { runRecoveryStatus } from "../src/browser-execution/customer-reporting.js";
import { BrowserDashboardController } from "../src/browser-execution/controllers/browser-dashboard.controller.js";
import { BrowserLifecycleController } from "../src/browser-execution/controllers/browser-lifecycle.controller.js";
const user = {
  kind: "user" as const,
  subject: "u",
  userId: "u",
  workspaceId: "w",
  role: "member" as const,
  email: "u@example.test",
};
describe("supported Run recovery", () => {
  it("requires both terminal Run and browser for release, and exposes no raw action data", () => {
    expect(
      runRecoveryStatus({ id: "r", state: "failed", browserSessionState: "active" })
        .browserReleased,
    ).toBe(false);
    expect(
      runRecoveryStatus({ id: "r", state: "running", browserSessionState: "completed" })
        .browserReleased,
    ).toBe(false);
    const s = runRecoveryStatus({
      id: "r",
      state: "failed",
      browserSessionState: "completed",
      activity: [{ state: "queued", errorCode: "PRIVATE" }],
    });
    expect(s).toMatchObject({ browserReleased: false, pendingCommands: 1 });
    expect(JSON.stringify(s)).not.toContain("PRIVATE");
    expect(
      runRecoveryStatus({
        id: "r",
        state: "failed",
        browserSessionState: "completed",
        ownerReleased: true,
        evidenceSealed: true,
        pendingCommandCount: 0,
      }).browserReleased,
    ).toBe(true);
    expect(runRecoveryStatus({ id: "r", ownerGeneration: "7" }).ownerGeneration).toBe(7);
  });
  it("keeps status reads within the requesting workspace", async () => {
    const dashboard = {
      recoveryStatus: vi.fn(async () => ({
        id: "r",
        state: "failed",
        browserSessionState: "completed",
      })),
    };
    const c = new BrowserDashboardController(dashboard as never, {} as never);
    await c.getRunStatus("r", user);
    expect(dashboard.recoveryStatus).toHaveBeenCalledWith("w", "r");
  });
  it("delegates incomplete stop to the existing fenced finalizer and does not relabel a terminal success", async () => {
    vi.stubEnv("SCRY_BROWSER_ENABLED", "true");
    const lifecycle = {
      executionSessionForRun: vi.fn(async () => ({
        id: "s",
        ownerGeneration: 7,
        runState: "running",
        browserState: "active",
      })),
    };
    const commands = {
      requestStop: vi.fn(async () => ({
        stopRequested: true,
        inFlight: false,
        browserReleased: false,
      })),
    };
    const c = new BrowserLifecycleController(
      lifecycle as never,
      {} as never,
      commands as never,
      {} as never,
    );
    const finalize = vi
      .spyOn(c as any, "finalizeRunWithClosure")
      .mockResolvedValue({ replay: false });
    await c.stopRun("r", user, {
      confirmed: true,
      conclusion: "Incomplete; preserve uncertain writes",
    });
    expect(finalize).toHaveBeenCalledWith(
      "r",
      user,
      {
        ownerGeneration: 7,
        outcome: "blocked",
        conclusion: "Incomplete; preserve uncertain writes",
      },
      true,
    );
    lifecycle.executionSessionForRun.mockResolvedValueOnce({
      id: "s",
      ownerGeneration: 7,
      runState: "passed",
      browserState: "completed",
    });
    expect(await c.stopRun("r", user, { confirmed: true, conclusion: "Other" })).toEqual({
      replay: true,
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    await expect(
      c.stopRun("r", { ...user, role: "viewer" }, { confirmed: true, conclusion: "Other" }),
    ).rejects.toThrow("testing access");
    vi.unstubAllEnvs();
  });
});
