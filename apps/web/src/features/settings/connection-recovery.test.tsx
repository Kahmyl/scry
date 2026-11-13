// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../infrastructure/api/client.js";
import { ConnectionDiagnostics } from "./connection-diagnostics.js";

vi.mock("../../infrastructure/api/client.js", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const current = {
  oauthDiscoveryConfigured: true,
  hostToolExposure: "unknown",
  connection: {
    revoked: false,
    workspaceAccess: true,
    grantAvailable: true,
    clientRegistrationAvailable: true,
  },
};
async function inspect(value: unknown) {
  vi.mocked(api).mockResolvedValueOnce(value);
  render(<ConnectionDiagnostics connectionId="fictional-connection" />);
  fireEvent.click(screen.getByRole("button", { name: "Check connection details" }));
}

it("keeps healthy authorization and offers conditional, surface-specific tool recovery", async () => {
  await inspect(current);
  expect(await screen.findByText(/Your Scry permission is current/)).toBeTruthy();
  expect(screen.getByText(/cannot tell which tools your assistant has loaded/)).toBeTruthy();
  fireEvent.click(screen.getByText("Missing tools in your assistant?"));
  fireEvent.click(screen.getByText("Codex Desktop plugin"));
  expect(screen.getByText(/Settings → Plugins/)).toBeTruthy();
  expect(screen.getByText(/turn the whole Scry plugin off and back on/)).toBeTruthy();
  expect(screen.getByText("Custom MCP connection")).toBeTruthy();
  expect(screen.getByText(/Do not reconnect or reinstall while sign-in is working/)).toBeTruthy();
  // Inspecting recovery is not a consent/revocation/configuration action.
  expect(api).toHaveBeenCalledTimes(1);
});

it("sends removed workspace access to the workspace owner instead of a reload loop", async () => {
  await inspect({ ...current, connection: { ...current.connection, workspaceAccess: false } });
  expect(await screen.findByText(/Ask the workspace owner to restore access/)).toBeTruthy();
  expect(screen.queryByText("Missing tools in your assistant?")).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});

it.each([
  { ...current.connection, revoked: true },
  { ...current.connection, grantAvailable: false },
  { ...current.connection, clientRegistrationAvailable: false },
])(
  "gives a normal connection handoff only for unusable authorization facts",
  async (connection) => {
    await inspect({ ...current, connection });
    expect(await screen.findByText(/Connect Scry again through your assistant/)).toBeTruthy();
    expect(screen.queryByText("Missing tools in your assistant?")).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  },
);

it("keeps a Scry service problem off the customer's credential-repair path", async () => {
  await inspect({ ...current, oauthDiscoveryConfigured: false });
  expect(
    await screen.findByText(/Scry's account connection service is not configured/),
  ).toBeTruthy();
  expect(screen.getByRole("link", { name: "Contact Scry support" }).getAttribute("href")).toBe(
    "https://scry.giize.com/support",
  );
  expect(screen.queryByText("Missing tools in your assistant?")).toBeNull();
});

it("unknown facts stay unknown and failed checks retain an actionable retry without private errors", async () => {
  vi.mocked(api).mockRejectedValueOnce(Error("private provider response"));
  render(<ConnectionDiagnostics connectionId="fictional-connection" />);
  fireEvent.click(screen.getByRole("button", { name: "Check connection details" }));
  expect(await screen.findByText(/Your authorization was not changed/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("private provider response");
  vi.mocked(api).mockResolvedValueOnce({ oauthDiscoveryConfigured: true });
  fireEvent.click(screen.getByRole("button", { name: "Check connection details" }));
  expect(await screen.findByText(/could not establish this connection's access/)).toBeTruthy();
  expect(screen.queryByText("Missing tools in your assistant?")).toBeNull();
});
