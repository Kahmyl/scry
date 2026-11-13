// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { MissionCleanup } from "./MissionCleanup.js";
import { MaskingReview, maskingIntervals } from "./MaskingReview.js";
import { ConnectionDiagnostics } from "../features/settings/connection-diagnostics.js";
const client = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("../infrastructure/api/client.js", () => client);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const item = {
  id: "fixture",
  kind: "credential",
  label: "Shared credential",
  state: "active",
  ownership: "shared_preexisting",
  cleanupStatus: "decision_required",
  allowedDecisions: ["retain"],
};
const ledger = { complete: false, items: [item], note: "Shared credentials are preserved." };
it("shows actual pending cleanup and requires confirmation for the exact retained credential", async () => {
  client.api.mockResolvedValue(ledger);
  client.post.mockResolvedValue({
    ...ledger,
    complete: true,
    items: [{ ...item, decision: "retain", cleanupStatus: "retained" }],
  });
  render(<MissionCleanup missionId="first" />);
  await screen.findByText(/Some resources still need/);
  fireEvent.click(screen.getByRole("button", { name: "Review Shared credential" }));
  expect(screen.getByLabelText("Action").querySelectorAll("option")).toHaveLength(1);
  expect(
    (screen.getByRole("button", { name: "Save cleanup decision" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save cleanup decision" }));
  await screen.findByText(/All listed items have ended/);
  expect(client.post).toHaveBeenCalledWith(
    "/missions/first/cleanup",
    expect.objectContaining({
      kind: "credential",
      itemId: "fixture",
      decision: "retain",
      reason: "shared_preexisting",
      confirmed: true,
    }),
  );
});
it("does not reuse cleanup confirmation or delayed old inventory across Mission selection", async () => {
  let resolve!: (value: any) => void;
  client.api.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  client.api.mockResolvedValue(ledger);
  const view = render(<MissionCleanup missionId="first" />);
  view.rerender(<MissionCleanup missionId="second" />);
  await screen.findByText("Shared credential");
  await act(async () => resolve({ ...ledger, items: [{ ...item, label: "Old scope" }] }));
  expect(screen.queryByText("Old scope")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review Shared credential" }));
  fireEvent.click(screen.getByRole("checkbox"));
  view.rerender(<MissionCleanup missionId="third" />);
  await screen.findByText("Shared credential");
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("retries an uncertain cleanup with the same intent key and keeps failures visible", async () => {
  client.api.mockResolvedValue(ledger);
  client.post.mockRejectedValueOnce(Error("private failure")).mockResolvedValueOnce(ledger);
  render(<MissionCleanup missionId="first" />);
  fireEvent.click(await screen.findByRole("button", { name: "Review Shared credential" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save cleanup decision" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Save cleanup decision" }));
  await waitFor(() => expect(client.post).toHaveBeenCalledTimes(2));
  expect(client.post.mock.calls[0]![1].idempotencyKey).toBe(
    client.post.mock.calls[1]![1].idempotencyKey,
  );
  expect(screen.queryByText("private failure")).toBeNull();
});
it("read-only cleanup and unavailable inventory never offer an unverified action", async () => {
  client.api.mockResolvedValue(ledger);
  const view = render(<MissionCleanup missionId="first" readOnly />);
  await screen.findByText("Shared credential");
  expect(screen.queryByRole("button", { name: "Review Shared credential" })).toBeNull();
  client.api.mockRejectedValueOnce(Error("provider secret"));
  view.rerender(<MissionCleanup missionId="second" />);
  expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  expect(screen.queryByText("Shared credential")).toBeNull();
});
const page = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
it("projects masking intervals by exact page, preserves unconfirmed tails and seeks deliberately", () => {
  const events = [
    { pageId: page, at: 1000, state: "degraded" as const, reason: "installation_pending" as const },
    { pageId: page, at: 1200, state: "degraded" as const, reason: "maintenance_timeout" as const },
    { pageId: page, at: 1500, state: "recovered" as const, reason: "refresh_confirmed" as const },
    {
      pageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      at: 1600,
      state: "degraded" as const,
      reason: "installation_failed" as const,
    },
  ];
  expect(maskingIntervals(events)).toMatchObject([
    { start: 1000, end: 1200, resolution: "reason changed" },
    { start: 1200, end: 1500, resolution: "refresh confirmed" },
    { start: 1600, resolution: "recovery not confirmed" },
  ]);
  const seek = vi.fn();
  render(<MaskingReview diagnostics={{ events, truncated: true }} onSeek={seek} />);
  expect(screen.getByText(/does not establish that information was disclosed/)).toBeTruthy();
  fireEvent.click(screen.getByText("Masking review intervals"));
  fireEvent.click(screen.getAllByRole("button", { name: "Review this interval" })[1]!);
  expect(seek).toHaveBeenCalledWith(1200);
  expect(screen.getByText(/Additional intervals were not retained/)).toBeTruthy();
});
it("connection details distinguish grant/registration facts from actual host exposure", async () => {
  client.api.mockResolvedValue({
    oauthDiscoveryConfigured: true,
    hostToolExposure: "unknown",
    connection: {
      revoked: false,
      workspaceAccess: true,
      grantAvailable: true,
      clientRegistrationAvailable: false,
    },
  });
  render(<ConnectionDiagnostics connectionId="chosen" />);
  fireEvent.click(screen.getByRole("button", { name: "Check connection details" }));
  await screen.findByText(/Client registration is expired/);
  expect(screen.getByText(/cannot verify which tools/)).toBeTruthy();
  expect(client.api).toHaveBeenCalledExactlyOnceWith(
    "/integrations/connections/chosen/diagnostics",
  );
  expect(client.post).not.toHaveBeenCalled();
});
