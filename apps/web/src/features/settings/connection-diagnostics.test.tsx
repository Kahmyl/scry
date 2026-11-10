// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../infrastructure/api/client.js";
import { ConnectionDiagnostics } from "./connection-diagnostics.js";
vi.mock("../../infrastructure/api/client.js", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  ["renewed", "Account access renewed."],
  ["retry_recovered", "An interrupted renewal was recovered."],
  ["replay_refused", "An older renewal credential was reused; reconnect Scry in your assistant."],
  ["disconnected", "This connection was disconnected."],
  ["private unrecognized detail", "Renewal status unavailable."],
  ["constructor", "Renewal status unavailable."],
])("shows finite safe connection events: %s", async (outcome, label) => {
  vi.mocked(api).mockResolvedValueOnce({
    oauthDiscoveryConfigured: true,
    hostToolExposure: "unknown",
    connection: {
      revoked: false,
      workspaceAccess: true,
      grantAvailable: true,
      clientRegistrationAvailable: true,
      lastRenewalEvent: { outcome, at: "2026-11-10T18:00:00Z" },
    },
  });
  render(<ConnectionDiagnostics connectionId="fictional-connection" />);
  fireEvent.click(screen.getByRole("button", { name: "Check connection details" }));
  expect(await screen.findByText(label, { exact: false })).toBeTruthy();
  expect(screen.getByText(/cannot verify which tools your assistant loaded/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("private unrecognized detail");
});
