// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, post, remove } from "../../infrastructure/api/client.js";
import { AdvancedIntegrations as Integrations } from "./integrations.js";

vi.mock("../../infrastructure/api/client.js", () => ({
  api: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
}));
const token = {
  id: "private-token-id",
  name: "Testing client",
  tokenPrefix: "visible-prefix",
  createdAt: "2026-11-01T10:00:00Z",
};
beforeEach(() => {
  vi.mocked(api).mockResolvedValue([token]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("connection setup presentation", () => {
  it("shows only safe token metadata and does not claim the connection was verified", async () => {
    render(<Integrations />);
    expect(await screen.findByText("Testing client")).toBeTruthy();
    expect(screen.getByText("visible-prefix")).toBeTruthy();
    expect(screen.getByText(/has not verified its connection/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/private-token-id|Remote endpoint ready/);
  });
  it("does not offer token creation for the unavailable Claude Desktop connection", async () => {
    render(<Integrations />);
    await screen.findByText("Testing client");
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Claude / Desktop" }));
    expect(screen.getByText("Claude / Desktop needs guided sign-in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create access token" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByLabelText("Claude setup method")).getByRole("button", {
        name: "Claude Code CLI",
      }),
    );
    expect(screen.getByRole("button", { name: "Create access token" })).toBeTruthy();
  });
  it("keeps creation errors recoverable without fabricating a token", async () => {
    vi.mocked(post).mockRejectedValue(new Error("Fixture request declined"));
    render(<Integrations />);
    fireEvent.click(screen.getByRole("button", { name: "Create access token" }));
    expect(await screen.findByText("Fixture request declined")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create access token" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByText("Copy this token now")).toBeNull();
  });
  it("retains confirmation before revoking access", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(remove).mockResolvedValue({ ...token, revokedAt: "2026-11-01T11:00:00Z" });
    render(<Integrations />);
    const revoke = await screen.findByRole("button", { name: "Revoke Testing client" });
    fireEvent.click(revoke);
    expect(remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(revoke);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("/mcp-tokens/private-token-id"));
    expect(await screen.findByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke Testing client" })).toBeNull();
  });
});
