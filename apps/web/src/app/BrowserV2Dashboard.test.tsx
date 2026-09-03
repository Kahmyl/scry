// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../infrastructure/api/index.js";
import { BrowserV2Dashboard } from "./BrowserV2Dashboard.js";

vi.mock("../infrastructure/api/index.js", async (load) => ({
  ...(await load<typeof import("../infrastructure/api/index.js")>()),
  api: vi.fn(),
}));

const browserStorage = new Map<string, string>();
const browserLocalStorage = {
  get length() {
    return browserStorage.size;
  },
  clear: () => browserStorage.clear(),
  getItem: (key: string) => browserStorage.get(key) ?? null,
  key: (index: number) => [...browserStorage.keys()][index] ?? null,
  removeItem: (key: string) => browserStorage.delete(key),
  setItem: (key: string, value: string) => browserStorage.set(key, value),
} satisfies Storage;

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: browserLocalStorage,
  });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("browser v2 production dashboard", () => {
  it("loads only the active project, Mission, Run, and report read models", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects")
        return [
          { id: "project-1", name: "Production baseline", description: "", createdAt: "now" },
        ];
      return [];
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <BrowserV2Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          "/projects",
          "/v2/projects/project-1/missions",
          "/v2/projects/project-1/runs",
          "/v2/projects/project-1/reports",
        ]),
      ),
    );
    expect(screen.queryByText("Operations")).toBeNull();
    expect(screen.queryByText(/unresolved/i)).toBeNull();
    expect(screen.queryByText(/execution baseline/i)).toBeNull();
    expect(screen.queryByText(/authoritative durable state/i)).toBeNull();
    const integrations = screen.getByRole("button", { name: "Integrations" });
    const projectSettings = screen.getByRole("button", { name: "Project settings" });
    expect(projectSettings.parentElement).toBe(integrations.parentElement);
    expect(projectSettings.parentElement?.classList.contains("sidebar-bottom")).toBe(true);
    expect(
      integrations.compareDocumentPosition(projectSettings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens and closes the mobile navigation drawer without changing the navigation set", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects")
        return [
          { id: "project-1", name: "Production baseline", description: "", createdAt: "now" },
        ];
      return [];
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <BrowserV2Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Dashboard navigation" })).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close navigation");
    expect(screen.queryByText("Operations")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Missions" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
});
