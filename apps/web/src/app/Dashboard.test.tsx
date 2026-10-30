// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../infrastructure/api/index.js";
import { Dashboard } from "./Dashboard.js";

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

describe("browser baseline production dashboard", () => {
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
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          "/projects",
          "/projects/project-1/missions",
          "/projects/project-1/runs",
          "/projects/project-1/reports",
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

  it.each([
    [
      "object_unavailable",
      "Recording unavailable",
      /evidence-storage issue, not a finding about your application/,
    ],
    [
      "integrity_mismatch",
      "Recording unavailable",
      /evidence-integrity issue, not a finding about your application/,
    ],
    [
      "content_unverifiable",
      "Recording unavailable",
      /does not establish that your application is broken/,
    ],
    ["video_unavailable", "Video unavailable", /captured evidence was verified/],
    [
      "publication_unavailable",
      "Recording unavailable",
      /evidence-publication issue, not a finding about your application/,
    ],
  ] as const)(
    "explains %s as an evidence problem without implying that the application is broken",
    async (issue, title, copy) => {
      vi.mocked(api).mockImplementation(async (path) => {
        if (path === "/projects")
          return [{ id: "project-1", name: "Fixture project", description: "", createdAt: "now" }];
        if (path === "/runs/run-1")
          return {
            id: "run-1",
            flowName: "Availability journey",
            environmentName: "Isolated fixture",
            baseOrigin: "https://fixture.example",
            state: "failed",
            flowDefinition: {},
            flowPurpose: "Inspect evidence",
            authenticationCommitsUsed: 0,
            authenticationCommitLimit: 1,
            businessCommitsUsed: 0,
            businessCommitLimit: 1,
            effects: [],
            artifacts: [],
            evidence: [
              {
                id: "evidence-1",
                state: "incomplete",
                chunkCount: 1,
                totalBytes: "24",
                interruptions: 0,
                custodyMode: "admitted",
                closureIssue: issue,
              },
            ],
          };
        return [];
      });
      render(
        <MemoryRouter initialEntries={["/dashboard/runs/run-1"]}>
          <Dashboard userEmail="owner@example.test" />
        </MemoryRouter>,
      );
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByText("failed").closest(".metric")?.classList.contains("failure")).toBe(
        true,
      );
      expect(screen.getByText(copy)).toBeTruthy();
      expect(screen.queryByText(/decisions are pending/i)).toBeNull();
      expect(document.querySelector("video")).toBeNull();
    },
  );

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
        <Dashboard userEmail="owner@example.test" />
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
