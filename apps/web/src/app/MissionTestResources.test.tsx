// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const receipt = (title: string) => ({
    id: title,
    title,
    receivedAt: "2026-11-01T12:00:00Z",
    content: { text: `Observation details: ${title}` },
    secrets: [],
  });
  it("retries a failed inventory read without creating a replacement resource", async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("fictional inventory interruption"))
      .mockResolvedValueOnce({
        resources: [resource],
        capabilities: { mailbox: true, webhook: true },
      });
    render(<MissionTestResources missionId="mission" readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry loading test resources" }));
    expect(await screen.findByRole("button", { name: /Invitation emails/ })).toBeTruthy();
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
      "/missions/mission/test-resources",
      "/missions/mission/test-resources",
    ]);
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("distinguishes loading from empty and retries the same closed resource without provider writes", async () => {
    const closed = { ...resource, state: "closed", address: null };
    let rejectRead!: (reason: Error) => void;
    vi.mocked(api).mockResolvedValueOnce({
      resources: [closed],
      capabilities: { mailbox: true, webhook: true },
    });
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    vi.mocked(api).mockResolvedValueOnce([
      {
        id: "receipt",
        title: "Saved invitation",
        receivedAt: "2026-11-01T12:00:00Z",
        content: { text: "Saved protected observation" },
        secrets: [],
      },
    ]);
    render(<MissionTestResources missionId="mission" readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: /Invitation emails Closed/ }));
    expect(await screen.findByText("Loading received messages…")).toBeTruthy();
    expect(
      screen.queryByText("No messages recorded yet. Check after the application sends one."),
    ).toBeNull();
    rejectRead(new Error("fictional transport interruption"));
    fireEvent.click(await screen.findByRole("button", { name: "Retry loading messages" }));
    expect(await screen.findByText("Saved invitation")).toBeTruthy();
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path === "/test-resources/resource/events"),
    ).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close mailbox" })).toBeNull();
  });
  it("does not show another resource's receipts or admit its late response", async () => {
    let finishOther!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith("/test-resources"))
        return {
          resources: [
            resource,
            { ...resource, id: "other", name: "Order callbacks", kind: "webhook" },
          ],
          capabilities: { mailbox: true, webhook: true },
        };
      if (path.includes("/other/"))
        return new Promise((resolve) => {
          finishOther = resolve;
        });
      return [receipt("Invitation saved")];
    });
    render(<MissionTestResources missionId="mission" readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: /Invitation emails/ }));
    expect(await screen.findByText("Invitation saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Order callbacks/ }));
    expect(screen.queryByText("Invitation saved")).toBeNull();
    expect(screen.getByText("Loading received messages…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Invitation emails/ }));
    expect(await screen.findByText("Invitation saved")).toBeTruthy();
    await act(async () => finishOther([receipt("Stale callback")]));
    expect(screen.queryByText("Stale callback")).toBeNull();
  });
  it("keeps a successful refresh when an earlier saved read fails late", async () => {
    let rejectSaved!: (reason: Error) => void;
    vi.mocked(api)
      .mockResolvedValueOnce({
        resources: [resource],
        capabilities: { mailbox: true, webhook: true },
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSaved = reject;
          }),
      );
    vi.mocked(post).mockResolvedValue({
      events: [receipt("Fresh observation")],
      status: "received",
    });
    render(<MissionTestResources missionId="mission" />);
    fireEvent.click(await screen.findByRole("button", { name: /Invitation emails/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check for messages" }));
    expect(await screen.findByText("Fresh observation")).toBeTruthy();
    await act(async () => rejectSaved(new Error("late fictional failure")));
    expect(screen.getByText("Fresh observation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry loading messages" })).toBeNull();
    expect(screen.queryByText("Loading received messages…")).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("calls a closed resource empty only after a successful saved read", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({
        resources: [{ ...resource, state: "closed", address: null }],
        capabilities: { mailbox: true, webhook: true },
      })
      .mockResolvedValueOnce([]);
    render(<MissionTestResources missionId="mission" readOnly />);
    fireEvent.click(await screen.findByRole("button", { name: /Invitation emails Closed/ }));
    expect(await screen.findByText("No messages were recorded for this resource.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry loading messages" })).toBeNull();
  });
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
