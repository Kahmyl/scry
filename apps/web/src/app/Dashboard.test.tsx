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
  window.history.replaceState(null, "", window.location.pathname);
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
  it("shows a spinner and activity placeholders while the report evidence library loads", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects") return [{ id: "project", name: "Project" }];
      if (path === "/reports/pending-report")
        return {
          id: "pending-report",
          missionId: "pending-mission",
          missionTitle: "Review checkout",
          state: "final",
          summary: "Review the recorded tests.",
        };
      if (path === "/dashboard/missions/pending-mission") return await new Promise(() => {});
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/reports/pending-report"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("link", { name: "Recordings & screenshots" }));
    const label = await screen.findByText("Loading evidence library…");
    const loader = label.closest(".ev-loading")!;
    expect(loader.querySelector(".ev-loading-spinner")).toBeTruthy();
    expect(loader.querySelectorAll(".ev-loading-cards > div")).toHaveLength(4);
    expect(loader.querySelector('[role="status"]')).toBeTruthy();
  });
  it("keeps mission search scoped to its project when switching projects", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects")
        return [
          { id: "first", name: "First project" },
          { id: "second", name: "Second project" },
        ];
      if (path === "/projects/first/missions" || path === "/projects/second/missions")
        return [
          {
            id: path.includes("first") ? "first-mission" : "second-mission",
            title: path.includes("first") ? "Checkout" : "Preferences",
            originalInstruction: "Review the application",
            state: "running",
            objectiveCount: 1,
            terminalObjectiveCount: 0,
            updatedAt: "2026-11-01T11:30:00Z",
          },
        ];
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/missions"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Open mission: Checkout/ });
    fireEvent.change(screen.getByLabelText("Search missions"), { target: { value: "checkout" } });
    fireEvent.click(screen.getByRole("button", { name: "First project" }));
    fireEvent.click(screen.getByRole("option", { name: /Second project/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Missions$/ }));
    expect(await screen.findByRole("button", { name: /Open mission: Preferences/ })).toBeTruthy();
    expect(screen.getByLabelText("Search missions")).toHaveProperty("value", "");
    expect(screen.queryByRole("button", { name: /Open mission: Checkout/ })).toBeNull();
  });
  it("retries the project missions read and opens the selected mission", async () => {
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects") return [{ id: "project", name: "Project" }];
      if (path === "/projects/project/missions") {
        if (++reads === 1) throw new Error("PRIVATE_DATABASE_DETAIL");
        return [
          {
            id: "mission",
            title: "Review checkout",
            originalInstruction: "Check saved orders",
            state: "running",
            objectiveCount: 2,
            terminalObjectiveCount: 1,
            updatedAt: "2026-11-01T11:30:00Z",
          },
        ];
      }
      if (path === "/dashboard/missions/mission")
        return {
          id: "mission",
          projectId: "project",
          title: "Review checkout",
          instruction: "Check saved orders",
          state: "running",
          objectives: [],
          flows: [],
          runs: [],
        };
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/missions"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("button", { name: /Review checkout/ }));
    expect(await screen.findByRole("heading", { name: "Review checkout" })).toBeTruthy();
    expect(reads).toBe(2);
    expect(screen.queryByText("PRIVATE_DATABASE_DETAIL")).toBeNull();
  });
  it("does not turn execution failures or raw report data into customer findings", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects") return [{ id: "project", name: "Project" }];
      if (path === "/reports/app-report")
        return {
          id: "app-report",
          missionId: "app-mission",
          missionTitle: "Design editing",
          state: "final",
          summary: "The revised design was saved and reopened",
          safeReport: {
            executionFailure: "PRIVATE_WORKER_ERROR",
            presentation: {
              verified: ["Visible saved text"],
              observations: [],
              limitations: ["Sharing was not tested"],
            },
          },
        };
      if (path === "/missions/app-mission" || path === "/dashboard/missions/app-mission")
        return {
          id: "app-mission",
          flows: [{ id: "flow", name: "Edit the card" }],
          runs: [
            {
              id: "attempt",
              flowId: "flow",
              state: "failed",
              outcomeClassification: "environment_failure",
              conclusion: "PRIVATE_CUSTODIAN_ERROR",
            },
          ],
        };
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/reports/app-report"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Visible saved text")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Browse by test activity", hidden: true }),
    ).toBeTruthy();
    expect(screen.queryByText(/PRIVATE_WORKER_ERROR|PRIVATE_CUSTODIAN_ERROR/)).toBeNull();
    expect(screen.queryByText(/Technical details and original report data/)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Recordings & screenshots" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit the card/ }));
    expect(await screen.findByText("Media for attempt")).toBeTruthy();
    expect(screen.queryByText(/PRIVATE_WORKER_ERROR|PRIVATE_CUSTODIAN_ERROR/)).toBeNull();
  });
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
        path === "/dashboard/missions/first"
          ? "first"
          : path === "/dashboard/missions/second"
            ? "second"
            : undefined;
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
    fireEvent.click(await screen.findByRole("link", { name: /Possible issues/ }));
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    expect(await screen.findByText("Media for first-attempt")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Open the second report" }));
    // A different report starts at its library, never the preceding report's artifact.
    fireEvent.click(await screen.findByRole("link", { name: "Recordings & screenshots" }));
    expect(await screen.findByRole("heading", { name: "Browse by test activity" })).toBeTruthy();
    expect(screen.queryByText("Media for first-attempt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Review.*1 attempt to review/ }));
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
        if (path === "/dashboard/missions/resource")
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
      if (path === "/dashboard/missions/mission-one")
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
    await screen.findByRole("link", { name: /Possible issues/ });
    expect(screen.queryByLabelText("Selected attempt evidence")).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: /Possible issues/ }));
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    const evidence = await screen.findByLabelText("Selected attempt evidence");
    expect(document.activeElement).toBe(evidence);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      behavior: "auto",
    });
    expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts.at(-1)).toBe(
      screen.getByLabelText("Selected journey evidence"),
    );
    const context = screen.getByRole("complementary", { name: "Evidence finding context" });
    expect(context.closest("[data-evidence-stage]")).toBe(
      screen.getByLabelText("Selected journey evidence"),
    );
    expect(context.textContent).toContain("Saved project");
    expect(screen.getByRole("button", { name: "Back to possible issue" })).toBeTruthy();
  });
  it("keeps the finding return path available when mission evidence cannot load", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects") return [{ id: "project", name: "Project" }];
      if (path === "/reports/report-one")
        return {
          id: "report-one",
          missionId: "mission-one",
          missionTitle: "Checkout",
          state: "final",
          summary: "Checkout needs review.",
          safeReport: {
            presentation: {
              observations: [
                {
                  title: "Address validation",
                  detail: "The address could not be validated.",
                  evidence: [{ runId: "attempt-one", artifactId: "a".repeat(64) }],
                },
              ],
            },
          },
        };
      if (path === "/dashboard/missions/mission-one") throw new Error("Evidence unavailable");
      return [];
    });
    render(
      <MemoryRouter initialEntries={["/dashboard/reports/report-one"]}>
        <Dashboard userEmail="owner@example.test" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("link", { name: /Possible issues/ }));
    // Let the native anchor navigation finish before the next user action.
    await waitFor(() => expect(window.location.hash).toBe("#observations"));
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    await screen.findByText("Evidence unavailable");
    const back = await screen.findByRole("button", { name: "Back to possible issue" });
    expect(back.closest("aside")?.textContent).toContain("Address validation");
    fireEvent.click(screen.getByRole("button", { name: "Back to possible issue" }));
    expect(screen.getByRole("heading", { name: "Address validation" })).toBeTruthy();
  });
  it("groups named journeys and retains every attempt without exposing execution conclusions", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/projects")
        return [{ id: "project-1", name: "Project", description: "", createdAt: "now" }];
      if (path === "/dashboard/missions/mission-one")
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
    expect(
      await screen.findByRole("button", { name: /01 Save the document 2 attempts/ }),
    ).toBeTruthy();
    expect(screen.queryByText("First attempt was refused before input.")).toBeNull();
    expect(screen.queryByText("The saved document was reopened.")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Attempt \d · Ended/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show attempts for Save the document" }));
    expect(screen.getAllByRole("button", { name: /Attempt \d · Ended/ })).toHaveLength(3);
    expect(screen.getAllByLabelText("Attempt media test seam")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Attempt 1 · Ended" })[0]!);
    expect(screen.getByText("Media for trial")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Read test report/ })).toBeTruthy();
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
      /Do not infer an application result from missing evidence/,
    ],
    [
      "integrity_mismatch",
      "Recording unavailable",
      /Do not infer an application result from missing evidence/,
    ],
    [
      "content_unverifiable",
      "Recording unavailable",
      /Do not infer an application result from missing evidence/,
    ],
    [
      "video_unavailable",
      "Recording unavailable",
      /Do not infer an application result from missing evidence/,
    ],
    [
      "publication_unavailable",
      "Recording unavailable",
      /Do not infer an application result from missing evidence/,
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
      expect(screen.getByText("Ended")).toBeTruthy();
      expect(screen.queryByText("failed")).toBeNull();
      expect(screen.queryByText(issue)).toBeNull();
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
