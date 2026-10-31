// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../infrastructure/api/index.js";
import { Dashboard } from "./Dashboard.js";
vi.mock("./RunEvidence.js", () => ({
  RunEvidence: ({ runId }: { runId: string }) => (
    <section aria-label="Attempt media test seam">Media for {runId}</section>
  ),
}));

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
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
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
  it("does not carry a selected artifact into another report", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects") return [{ id: "project", name: "Project" }];
      const report =
        path === "/reports/first" ? "first" : path === "/reports/second" ? "second" : undefined;
      if (report)
        return {
          id: report,
          projectId: "project",
          missionId: report,
          missionTitle: report,
          state: "final",
          summary: "Review the correct attempt",
          evidenceDigest: "digest",
          safeReport: {
            presentation: {
              observations: [
                {
                  title: "Saved state",
                  detail: "Inspect evidence",
                  evidence: [{ runId: `${report}-attempt`, artifactId: "a".repeat(64) }],
                },
              ],
            },
          },
        };
      const mission =
        path === "/missions/first" ? "first" : path === "/missions/second" ? "second" : undefined;
      if (mission)
        return {
          id: mission,
          projectId: "project",
          flows: [{ id: "flow", name: "Review" }],
          runs: [{ id: `${mission}-attempt`, flowId: "flow", state: "passed" }],
        };
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/reports/first"]}>
        <Link to="/dashboard/reports/second">Open the second report</Link>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review supporting evidence" }));
    expect(await screen.findByText("Media for first-attempt")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Open the second report" }));
    expect(await screen.findByText("Media for second-attempt")).toBeTruthy();
    expect(screen.queryByText(/does not belong to an available attempt/)).toBeNull();
  });
  it.each(["missions", "runs", "reports"])(
    "uses the owning project for a direct %s link, not the persisted unrelated selection",
    async (kind) => {
      localStorage.setItem("scry:project", "unrelated-project");
      vi.mocked(api).mockImplementation(async (path) => {
        if (path === "/projects")
          return [
            { id: "unrelated-project", name: "Unrelated project" },
            { id: "owning-project", name: "Owning project" },
          ];
        if (path === "/missions/resource")
          return {
            id: "resource",
            projectId: "owning-project",
            title: "Actual mission",
            instruction: "Check the app",
            state: "completed",
            objectives: [],
            flows: [],
            runs: [],
          };
        if (path === "/runs/resource")
          return {
            id: "resource",
            projectId: "owning-project",
            flowName: "Actual journey",
            state: "passed",
            runtimeAdapter: "playwright_mcp",
            evidence: [],
            effects: [],
            artifacts: [],
          };
        if (path === "/reports/resource")
          return {
            id: "resource",
            projectId: "owning-project",
            missionId: "resource",
            missionTitle: "Actual mission",
            state: "final",
            summary: "Verified scoped journey",
            evidenceDigest: "digest",
          };
        return [];
      });
      render(
        <MemoryRouter initialEntries={[`/dashboard/${kind}/resource`]}>
          <Dashboard userEmail="owner@example.test" />
        </MemoryRouter>,
      );
      await waitFor(() => expect(localStorage.getItem("scry:project")).toBe("owning-project"));
      expect(screen.getAllByText("Owning project").length).toBeGreaterThan(0);
    },
  );
  it("moves report readers to the exact evidence destination without scrolling the initial page", async () => {
    const ref = { runId: "attempt-one", artifactId: "a".repeat(64) };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects") return [{ id: "project-1", name: "Project" }];
      if (path === "/reports/report-one")
        return {
          id: "report-one",
          missionId: "mission-one",
          missionTitle: "Reviewed mission",
          summary: "Saved and inspected",
          state: "final",
          evidenceDigest: "private-digest",
          safeReport: {
            presentation: {
              observations: [
                { title: "Saved project", detail: "Inspect the saved state", evidence: [ref] },
              ],
            },
          },
        };
      if (path === "/missions/mission-one")
        return {
          id: "mission-one",
          flows: [{ id: "flow-one", name: "Save the project" }],
          runs: [
            {
              id: "attempt-one",
              flowId: "flow-one",
              state: "passed",
              conclusion: "Saved and reopened",
            },
          ],
        };
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/reports/report-one"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    const evidence = await screen.findByLabelText("Selected attempt evidence");
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review supporting evidence" }));
    expect(document.activeElement).toBe(evidence);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "auto",
    });
  });
  it("groups named journeys and retains every attempt conclusion while mounting one evidence gallery", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects")
        return [{ id: "project-1", name: "Project", description: "", createdAt: "now" }];
      if (path === "/missions/mission-one")
        return {
          id: "mission-one",
          title: "A useful mission",
          instruction: "Test the project",
          state: "completed",
          revision: 1,
          finalReportId: "report-one",
          objectives: [],
          flows: [
            {
              id: "flow-one",
              name: "Save the document",
              purpose: "Verify persistence",
              state: "active",
              revision: 1,
            },
            {
              id: "flow-two",
              name: "Review access",
              purpose: "Check account controls",
              state: "active",
              revision: 1,
            },
          ],
          runs: [
            {
              id: "trial",
              flowId: "flow-one",
              state: "failed",
              conclusion: "First attempt was refused before input.",
            },
            {
              id: "followup",
              flowId: "flow-one",
              state: "passed",
              conclusion: "The saved document was reopened.",
            },
            {
              id: "access",
              flowId: "flow-two",
              state: "passed",
              conclusion: "Account controls inspected.",
            },
          ],
        };
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/missions/mission-one"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Save the document" })).toBeTruthy();
    expect(screen.getByText("First attempt was refused before input.")).toBeTruthy();
    expect(screen.getByText("The saved document was reopened.")).toBeTruthy();
    expect(screen.getAllByLabelText("Attempt media test seam")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Attempt 1 · failed" }));
    expect(screen.getByText("Media for trial")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View test report" })).toBeTruthy();
  });
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
