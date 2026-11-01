// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSelectBrowserApis } from "../../test/select-dom.js";
import { MissionTestResources } from "./MissionTestResources.js";
import { api, post } from "../infrastructure/api/client.js";
vi.mock("../infrastructure/api/client.js", () => ({ api: vi.fn(), post: vi.fn() }));
beforeEach(mockSelectBrowserApis);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const resource = {
  id: "resource",
  kind: "mailbox",
  name: "Invitation emails",
  state: "ready",
  address: "fictional@mail.example",
  idempotencyKey: "stable-key",
  expiresInSeconds: 3600,
};
describe("mission test observations", () => {
  it("defaults to disposable mail and requires an explicit saved password for existing mail", async () => {
    vi.mocked(api).mockResolvedValue({
      resources: [],
      capabilities: { mailbox: true, webhook: true },
      credentials: [
        { id: "password-reference", displayName: "My Mail.tm password", state: "active" },
      ],
    });
    vi.mocked(post).mockResolvedValue({ ...resource, ownership: "customer" });
    render(<MissionTestResources missionId="mission" />);
    fireEvent.click(await screen.findByRole("button", { name: "Test mailbox" }));
    const source = screen.getByRole("combobox", { name: "Mailbox source" });
    expect(source.textContent).toContain("Create a disposable mailbox");
    fireEvent.keyDown(source, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Use my Mail.tm mailbox" }));
    expect(screen.queryByDisplayValue("My Mail.tm password")).toBeNull();
    fireEvent.change(screen.getByLabelText("Mail.tm email address"), {
      target: { value: "existing@mail.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect mailbox" }));
    expect(post).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Saved mailbox password" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "My Mail.tm password" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect mailbox" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/missions/mission/test-resources/connect-mailbox",
        expect.objectContaining({
          address: "existing@mail.example",
          passwordCredentialId: "password-reference",
        }),
      ),
    );
    expect(JSON.stringify(vi.mocked(post).mock.calls[0])).not.toContain('"password":');
    expect(await screen.findByRole("button", { name: "Disconnect mailbox" })).toBeTruthy();
  });
  it("does not publish an old Mission's allocation result after switching Missions", async () => {
    vi.mocked(api).mockResolvedValue({
      resources: [],
      capabilities: { mailbox: true, webhook: true },
    });
    let finish!: (value: unknown) => void;
    vi.mocked(post).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<MissionTestResources missionId="first" />);
    fireEvent.click(await screen.findByRole("button", { name: "Test mailbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    view.rerender(<MissionTestResources missionId="second" />);
    await screen.findByText("No email or webhook observations yet.");
    finish({ ...resource, name: "Old mission allocation" });
    await waitFor(() => expect(screen.queryByText("Old mission allocation")).toBeNull());
  });
  it("shows provider attribution and a meaningful empty state", async () => {
    vi.mocked(api).mockResolvedValue({
      resources: [],
      capabilities: { mailbox: true, webhook: true },
    });
    render(<MissionTestResources missionId="mission" />);
    expect(await screen.findByText("No email or webhook observations yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Mail.tm" }).getAttribute("href")).toBe(
      "https://mail.tm",
    );
    expect(screen.getByRole("button", { name: "Test mailbox" })).toBeTruthy();
  });
  it("shows received content as inert text and normal waiting without an application verdict", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith("/events")
        ? [
            {
              id: "event",
              title: "Welcome",
              receivedAt: "2026-11-01T12:00:00Z",
              content: { text: "<script>window.injected=true</script>" },
              secrets: [],
            },
          ]
        : { resources: [resource], capabilities: { mailbox: true, webhook: true } },
    );
    vi.mocked(post).mockResolvedValue({ events: [], status: "waiting", retryAfterSeconds: 30 });
    const view = render(<MissionTestResources missionId="mission" />);
    fireEvent.click(await screen.findByRole("button", { name: /Invitation emails/ }));
    expect(await screen.findByText("<script>window.injected=true</script>")).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for messages" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Check again in about 30 seconds"),
    );
    expect(view.container.textContent).not.toMatch(/application failed|test failed|TEST_PROVIDER/);
  });
});
