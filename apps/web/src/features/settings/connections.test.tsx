// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, post, remove } from "../../infrastructure/api/client.js";
import { Connections } from "./connections.js";
import { OAuthConsent } from "./OAuthConsent.js";
import { rememberConnectionReturn, takeConnectionReturn } from "./connection-return.js";

vi.mock("../../infrastructure/api/client.js", () => ({
  api: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
}));
const connection = {
  id: "00000000-0000-4000-8000-000000000001",
  clientName: "Fictional assistant",
  workspaceName: "Studio workspace",
  createdAt: "2026-11-02T10:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
};
beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === "/mcp-tokens" ? [] : { available: true, connections: [] },
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});

describe("guided account connections", () => {
  it("explains where to add Claude and visibly confirms the all-client refresh", async () => {
    render(<Connections />);
    fireEvent.click(await screen.findByRole("radio", { name: /^Claude$/ }));
    expect(screen.getByText(/Settings → Connectors → Add custom connector/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection list" }));
    expect(await screen.findByText(/Connection list refreshed/)).toBeTruthy();
  });
  it("shows an obvious loading indicator and no success state before access is verified", async () => {
    let finish: (value: unknown) => void = () => {};
    vi.mocked(api).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<Connections />);
    expect(screen.getByRole("status").textContent).toContain("Checking connection");
    expect(screen.queryByText(/authenticated access verified/)).toBeNull();
    finish({ available: true, connections: [connection] });
    expect(await screen.findByText("Approved · waiting for client verification")).toBeTruthy();
    expect(screen.queryByText("Connected · authenticated access verified")).toBeNull();
  });
  it("offers guided setup without exposing access-token creation as the primary action", async () => {
    render(<Connections />);
    expect(await screen.findByRole("button", { name: "Copy Scry address" })).toBeTruthy();
    const advanced = screen.getByText("Advanced: manual access-token setup").closest("details")!;
    expect(advanced.open).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Cursor" }));
    const link = screen.getByRole("link", { name: /Add to Cursor/ });
    expect(link.getAttribute("href")).toMatch(/^cursor:\/\//);
    expect(link.getAttribute("href")).not.toContain("Bearer");
  });
  it("shows a verified state only from server facts and asks before disconnecting", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/mcp-tokens"
        ? []
        : { available: true, connections: [{ ...connection, lastUsedAt: "2026-11-02T10:01:00Z" }] },
    );
    render(<Connections />);
    expect(await screen.findByText("Connected · authenticated access verified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Fictional assistant" }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep connected" }),
    );
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Fictional assistant" }));
    vi.mocked(remove).mockResolvedValue({ disconnected: true });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /^Disconnect$/ }),
    );
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(`/integrations/connections/${connection.id}`),
    );
  });
  it("does not offer inactive OAuth setup or hide a connection-check failure", async () => {
    vi.mocked(api).mockResolvedValueOnce({ available: false, connections: [] });
    render(<Connections />);
    expect(await screen.findByText(/Guided sign-in is not enabled/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy Scry address" })).toBeNull();
    cleanup();
    vi.mocked(api).mockRejectedValueOnce(new Error("private internal diagnostic"));
    render(<Connections />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("couldn’t check your connections"),
    );
    expect(document.body.textContent).not.toContain("private internal diagnostic");
  });
});

const details = {
  clientName: "Fictional assistant",
  callbackOrigin: "http://127.0.0.1:49199",
  permissions: [
    "Run browser tests and read reports and evidence within your workspace permissions",
  ],
  workspaces: [{ id: connection.id, name: "Studio workspace", role: "owner" }],
};
function consent() {
  return render(
    <MemoryRouter initialEntries={["/connect/authorize/fictional-request-123"]}>
      <Routes>
        <Route path="/connect/authorize/:uid" element={<OAuthConsent />} />
      </Routes>
    </MemoryRouter>,
  );
}
describe("connection consent", () => {
  it("requires an explicit workspace choice and never treats a client-provided name as verified", async () => {
    vi.mocked(api).mockResolvedValueOnce(details);
    consent();
    expect(await screen.findByRole("button", { name: "Allow connection" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText(/name is supplied by the requesting client/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it("sends only a denial when the customer cancels", async () => {
    vi.mocked(api).mockResolvedValueOnce(details);
    vi.mocked(post).mockRejectedValueOnce(new Error("fixture rejection"));
    consent();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/integrations/authorize/fictional-request-123/decision", {
        decision: "deny",
      }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow connection" })).toHaveProperty(
      "disabled",
      true,
    );
  });
  it("shows a restart instruction for expired requests instead of a success state", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("private expired request diagnostic"));
    consent();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("start again"),
    );
    expect(screen.queryByRole("button", { name: "Allow connection" })).toBeNull();
    expect(document.body.textContent).not.toContain("private expired");
  });
});
describe("sign-in returns", () => {
  it("preserves only a short-lived internal connection path and consumes it once", () => {
    rememberConnectionReturn("/connect/authorize/fictional-request-123");
    expect(takeConnectionReturn()).toBe("/connect/authorize/fictional-request-123");
    expect(takeConnectionReturn()).toBe("/dashboard");
    rememberConnectionReturn("https://untrusted.example");
    expect(takeConnectionReturn()).toBe("/dashboard");
    sessionStorage.setItem(
      "scry-connection-return",
      JSON.stringify({
        path: "/connect/authorize/fictional-request-123",
        createdAt: Date.now() - 600001,
      }),
    );
    expect(takeConnectionReturn()).toBe("/dashboard");
  });
});
