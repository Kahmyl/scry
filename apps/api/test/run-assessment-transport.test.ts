import { afterEach, expect, it, vi } from "vitest";
import { BrowserDashboardRepository } from "../src/browser-execution/repositories/browser-dashboard.repository.js";
import { runRecoveryStatus } from "../src/browser-execution/customer-reporting.js";
import type { Database } from "../src/infrastructure/database.js";

const released = {
  id: "selected-run",
  missionId: "selected-mission",
  state: "failed",
  browserSessionState: "failed",
  pendingCommandCount: 0,
  ownerReleased: true,
  evidenceSealed: true,
  ownerGeneration: 1,
};
const withheld = {
  state: "withheld",
  reason: "native_capture_final_assessment_missing",
  warning: "automatic_redaction_best_effort",
};
function fixture(rows: unknown[] = [released]) {
  const query = vi.fn(async () => ({ rows }));
  const boundedTransaction = vi.fn(async (work: any) => work({ query }));
  const repo = new BrowserDashboardRepository({ boundedTransaction } as unknown as Database);
  const inventory = vi.spyOn(repo as any, "nativePublication");
  return { repo, query, boundedTransaction, inventory };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("carries the same canonical assessment in status and media without changing release truth", async () => {
  const { repo, inventory, query } = fixture();
  inventory.mockResolvedValue({ media: [], recordingAssessment: withheld });
  vi.spyOn(repo, "getRun").mockResolvedValue({ ...released, flowName: "Fictional journey" } as any);
  const row = await repo.recoveryStatus("workspace", "selected-run");
  const status = runRecoveryStatus(row);
  const media = await repo.listMedia("workspace", "selected-run");
  expect(status).toMatchObject({
    browserReleased: true,
    recordingAssessment: withheld,
    interaction: { state: "release_confirmed_recording_withheld" },
  });
  expect(media.recordingAssessment).toEqual(status.recordingAssessment);
  expect(media.items).toEqual([]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("p.workspace_id=$2"), [
    "selected-run",
    "workspace",
  ]);
  expect(inventory).toHaveBeenCalledTimes(2); // one per existing caller, no extra endpoint
});

it("keeps legacy status unchanged when no prospective recording assessment exists", async () => {
  const { repo, inventory } = fixture();
  inventory.mockResolvedValue(undefined);
  const status = runRecoveryStatus(await repo.recoveryStatus("workspace", "selected-run"));
  expect(status.browserReleased).toBe(true);
  expect(status).not.toHaveProperty("recordingAssessment");
  expect(status).not.toHaveProperty("recordingAssessmentAvailability");
  expect(status.interaction.state).toBe("release_confirmed");
});

it("preserves release on an optional authenticated-inventory read failure without echoing its error", async () => {
  const { repo, inventory } = fixture();
  inventory.mockRejectedValue(Error("PRIVATE_PROVIDER_VALUE /private/evidence/path"));
  const status = runRecoveryStatus(await repo.recoveryStatus("workspace", "selected-run"));
  expect(status).toMatchObject({
    browserReleased: true,
    recordingAssessmentAvailability: "unavailable",
    interaction: {
      state: "release_confirmed_recording_unavailable",
      next: { action: "continue_with_returned_context" },
    },
  });
  expect(status).not.toHaveProperty("recordingAssessment");
  expect(JSON.stringify(status)).not.toMatch(/PRIVATE_PROVIDER_VALUE|private\/evidence/);
});

it("bounds optional assessment work by the original status deadline and discards late results", async () => {
  vi.useFakeTimers();
  const { repo, inventory, boundedTransaction } = fixture();
  let complete: (v: unknown) => void = () => {};
  inventory.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const pending = repo.recoveryStatus("workspace", "selected-run");
  await vi.advanceTimersByTimeAsync(3001);
  const row = await pending;
  expect(row).toMatchObject({ ...released, recordingAssessmentAvailability: "unavailable" });
  expect(boundedTransaction).toHaveBeenCalledWith(expect.any(Function), 3000);
  expect(inventory.mock.calls[0]![2]).toBeGreaterThan(0);
  expect(inventory.mock.calls[0]![2]).toBeLessThanOrEqual(3000);
  complete({ media: [], recordingAssessment: withheld });
  await Promise.resolve();
  expect(row).not.toHaveProperty("recordingAssessment");
  expect(runRecoveryStatus(row).browserReleased).toBe(true);
});

it("does not inspect an inventory before the scoped Run authorization succeeds", async () => {
  const { repo, inventory, query } = fixture([]);
  await expect(repo.recoveryStatus("foreign-workspace", "selected-run")).rejects.toThrow(
    "SCRY_BROWSER_RUN_NOT_FOUND",
  );
  expect(query).toHaveBeenCalledWith(expect.any(String), ["selected-run", "foreign-workspace"]);
  expect(inventory).not.toHaveBeenCalled();
});

it("discloses only finite assessment fields from internal rows", () => {
  const raw = "PRIVATE_UNTRUSTED_RECORDING_VALUE";
  const status = runRecoveryStatus({ ...released, recordingAssessment: { ...withheld, raw } });
  expect(status.recordingAssessment).toEqual(withheld);
  expect(JSON.stringify(status)).not.toContain(raw);
  const unknown = runRecoveryStatus({
    ...released,
    recordingAssessment: { ...withheld, reason: raw },
  });
  expect(unknown.browserReleased).toBe(true);
  expect(unknown).not.toHaveProperty("recordingAssessment");
  expect(unknown.recordingAssessmentAvailability).toBe("unavailable");
  expect(JSON.stringify(unknown)).not.toContain(raw);
});
