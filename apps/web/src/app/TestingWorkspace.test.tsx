// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MissionCollectionDesign,
  MissionDetailDesign,
  JourneyEvidenceDesign,
  ReportCollectionDesign,
  ReportDetailDesign,
} from "./TestingWorkspace.js";
import { ReportNarrative, reportNarrative } from "./ReportNarrative.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", window.location.pathname);
});
const emptyContent = reportNarrative({});
const report = {
  id: "private-report",
  missionId: "private-mission",
  missionTitle: "Review saved orders",
  summary: "The order remained available after signing back in.",
  state: "final",
  createdAt: "2026-11-01T10:00:00Z",
};

describe("report section navigation", () => {
  function setupSections() {
    const view = render(
      <ReportDetailDesign
        report={{ ...report, originalInstruction: "Review checkout" }}
        content={{
          ...emptyContent,
          verified: ["Saved order reopened"],
          observations: [{ title: "Review layout", detail: "Spacing differs", evidence: [] }],
        }}
        onBack={() => {}}
        onMission={() => {}}
        onEvidence={() => {}}
        evidence={<video data-testid="retained-video" controls />}
        evidenceRequested={false}
      />,
    );
    return view;
  }
  it("starts with an overview and shows only the chosen section", () => {
    setupSections();
    expect(screen.getByRole("heading", { name: "Test results" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Possible issues" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Possible issues/ }));
    expect(screen.getByRole("heading", { name: "Possible issues" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Test results" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "All test results" })).toBeNull();
    expect(document.querySelectorAll('.tw-report-toc [aria-current="location"]').length).toBe(1);
    expect(screen.getByRole("link", { name: /Possible issues/ }).getAttribute("aria-current")).toBe(
      "location",
    );
    fireEvent.scroll(window);
    expect(screen.getByRole("link", { name: /Possible issues/ }).getAttribute("aria-current")).toBe(
      "location",
    );
  });
  it("keeps native section links, closes the phone menu and does not remount evidence", () => {
    setupSections();
    const video = screen.getByTestId("retained-video");
    fireEvent.click(screen.getByRole("button", { name: "On this page" }));
    fireEvent.click(screen.getByRole("link", { name: "Recordings & screenshots" }));
    expect(
      screen.getByRole("link", { name: "Recordings & screenshots" }).getAttribute("href"),
    ).toBe("#supporting-evidence");
    expect(screen.getByRole("button", { name: "On this page" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.getByTestId("retained-video")).toBe(video);
  });
  it("restores a direct section link and follows hash navigation", async () => {
    window.history.replaceState(null, "", "#observations");
    setupSections();
    expect(screen.getByRole("heading", { name: "Possible issues" })).toBeTruthy();
    window.history.replaceState(null, "", "#supporting-evidence");
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Recordings & screenshots" }).getAttribute("aria-current"),
      ).toBe("location"),
    );
    expect(screen.getByTestId("retained-video").closest("section[hidden]")).toBeNull();
  });
  it("falls back to overview for an unknown section without exposing hidden panels", async () => {
    window.history.replaceState(null, "", "#not-a-section");
    setupSections();
    expect(screen.getByRole("link", { name: "Summary" }).getAttribute("aria-current")).toBe(
      "location",
    );
    expect(screen.queryByRole("heading", { name: "Original request" })).toBeNull();
  });
});

describe("testing workspace design contracts", () => {
  it("renders customer-projected ended progress for both missions and objectives", () => {
    render(
      <MissionDetailDesign
        mission={{
          id: "private-mission",
          title: "Review checkout",
          instruction: "Review the app",
          state: "ended",
          objectives: [
            { id: "private-objective", title: "Checkout", description: "", state: "ended" },
          ],
          flows: [],
          runs: [],
        }}
        onBack={() => {}}
        journeys={null}
      />,
    );
    expect(screen.queryAllByText("Status unavailable")).toHaveLength(0);
    expect(screen.getByText("Testing work ended")).toBeTruthy();
    expect(screen.getByText("Ended")).toBeTruthy();
  });
  it("gives the mission request and objectives named, distinct reading sections", () => {
    const onBack = vi.fn(),
      onReport = vi.fn();
    render(
      <MissionDetailDesign
        mission={{
          id: "private-mission",
          title: "Review checkout",
          instruction: "Save a delivery address and reopen checkout",
          state: "running",
          objectives: [
            {
              id: "private-objective",
              title: "Delivery details persist",
              description: "Leave checkout and return",
              state: "running",
            },
          ],
          flows: [],
          runs: [],
        }}
        onBack={onBack}
        onReport={onReport}
        journeys={<p>Journey workspace</p>}
      />,
    );
    expect(screen.getByRole("region", { name: "What was requested" }).textContent).toContain(
      "Save a delivery address and reopen checkout",
    );
    expect(screen.getByRole("region", { name: "Objectives" }).textContent).toContain(
      "Delivery details persist",
    );
    fireEvent.click(screen.getByRole("button", { name: /Read test report/ }));
    fireEvent.click(screen.getByRole("button", { name: "All missions" }));
    expect(onReport).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });
  it("keeps the evidence node mounted as the selected attempt changes", () => {
    const journeys = [
      {
        id: "private-journey",
        name: "Save delivery details",
        purpose: "Confirm persistence",
        attempts: [
          { id: "private-first", progress: "Ended" },
          { id: "private-second", progress: "In progress" },
        ],
      },
    ];
    const onSelect = vi.fn();
    const evidence = <button>Current evidence source</button>;
    const view = render(
      <JourneyEvidenceDesign
        journeys={journeys}
        selectedRunId="private-first"
        onSelect={onSelect}
        evidence={evidence}
      />,
    );
    const source = screen.getByRole("button", { name: "Current evidence source" });
    fireEvent.click(screen.getByRole("button", { name: "Attempt 2 · In progress" }));
    expect(onSelect).toHaveBeenCalledWith("private-second");
    view.rerender(
      <JourneyEvidenceDesign
        journeys={journeys}
        selectedRunId="private-second"
        onSelect={onSelect}
        evidence={evidence}
      />,
    );
    expect(screen.getByRole("button", { name: "Current evidence source" })).toBe(source);
    expect(
      screen.getByRole("button", { name: "Attempt 2 · In progress" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.body.textContent).not.toMatch(/private-|passed|failed/);
  });
  it("keeps every attempt reachable in a longer mission", () => {
    const onSelect = vi.fn();
    const journeys = Array.from({ length: 12 }, (_, i) => ({
      id: `private-journey-${i}`,
      name: `Review saved details · Scenario ${i + 1}`,
      purpose: "Save and reopen the application state",
      attempts: Array.from({ length: 5 }, (_, j) => ({
        id: `private-attempt-${i}-${j}`,
        progress: "Ended",
      })),
    }));
    render(
      <JourneyEvidenceDesign
        journeys={journeys}
        selectedRunId="private-attempt-11-4"
        onSelect={onSelect}
        evidence={<p>Selected source material</p>}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Attempt \d · Ended/ })).toHaveLength(5);
    for (const journey of journeys.slice(0, -1))
      fireEvent.click(screen.getByRole("button", { name: `Show attempts for ${journey.name}` }));
    expect(screen.getAllByRole("button", { name: /Attempt \d · Ended/ })).toHaveLength(60);
    fireEvent.click(screen.getAllByRole("button", { name: "Attempt 1 · Ended" })[0]!);
    expect(onSelect).toHaveBeenCalledWith("private-attempt-0-0");
    expect(
      screen
        .getAllByRole("button", { name: "Attempt 5 · Ended" })
        .at(-1)!
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("does not invent an attempt number or substitute evidence for a missing reference", () => {
    render(
      <JourneyEvidenceDesign
        journeys={[]}
        selectedRunId="missing-private-reference"
        onSelect={() => {}}
        evidence={<p role="alert">The referenced attempt is unavailable.</p>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Evidence reference unavailable" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("referenced attempt is unavailable");
    expect(document.body.textContent).not.toMatch(/Attempt 0|missing-private-reference/);
  });
  it("preserves collapsed journeys and filter choices across ordinary polling updates", () => {
    const journeys = Array.from({ length: 8 }, (_, index) => ({
      id: `journey-${index}`,
      name: `Scenario ${index + 1}`,
      purpose: "Review saved details",
      attempts: [{ id: `attempt-${index}`, progress: "Ended" }],
    }));
    const props = {
      journeys,
      selectedRunId: "attempt-7",
      onSelect: vi.fn(),
      evidence: <p>Actual media</p>,
    };
    const view = render(<JourneyEvidenceDesign {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide attempts for Scenario 8" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter journeys" }), {
      target: { value: "Scenario 8" },
    });
    view.rerender(
      <JourneyEvidenceDesign
        {...props}
        journeys={journeys.map((j) => ({ ...j, attempts: [...j.attempts] }))}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Show attempts for Scenario 8" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByRole("button", { name: /01 Scenario 1/ })).toBeNull();
    expect(screen.getByRole("searchbox").getAttribute("value")).toBe("Scenario 8");
    expect(screen.getByText("Actual media")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing-matches" } });
    expect(screen.getByText(/No journeys match/)).toBeTruthy();
    expect(screen.getByText("Actual media")).toBeTruthy();
    view.rerender(<JourneyEvidenceDesign {...props} selectedRunId="attempt-0" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Hide attempts for Scenario 1" })).toBeTruthy();
  });
  it("shows an unattempted journey without mislabelling another journey’s media", () => {
    const journeys = [
      {
        id: "done",
        name: "Save delivery",
        purpose: "Confirm persistence",
        attempts: [{ id: "run", progress: "Ended" }],
      },
      { id: "planned", name: "Receipt preferences", purpose: "Review settings", attempts: [] },
    ];
    const props = {
      journeys,
      selectedRunId: "run",
      onSelect: vi.fn(),
      evidence: <p>Delivery media only</p>,
    };
    const view = render(<JourneyEvidenceDesign {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /02 Receipt preferences No attempts yet/ }));
    expect(screen.getByRole("heading", { name: "Receipt preferences" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No attempts yet" })).toBeTruthy();
    expect(screen.queryByText("Delivery media only")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
    view.rerender(<JourneyEvidenceDesign {...props} journeys={journeys.map((j) => ({ ...j }))} />);
    expect(screen.queryByText("Delivery media only")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /01 Save delivery 1 attempt/ }));
    expect(props.onSelect).toHaveBeenCalledWith("run");
    expect(screen.getByText("Delivery media only")).toBeTruthy();
  });
  it.each(["__proto__", "constructor", "toString", "private-engine-error"])(
    "does not expose unknown mission state %s",
    (state) => {
      render(
        <MissionDetailDesign
          mission={{
            id: "private",
            title: "Review checkout",
            instruction: "Review the app",
            state,
            objectives: [],
            flows: [],
            runs: [],
          }}
          onBack={() => {}}
          journeys={null}
        />,
      );
      expect(screen.getByText("Status unavailable")).toBeTruthy();
      expect(document.body.textContent).not.toContain(state);
    },
  );
  it("restores an explicit report reference even when it targets the same run after an empty journey was viewed", () => {
    const props = {
      journeys: [
        {
          id: "done",
          name: "Saved order",
          purpose: "Reopen",
          attempts: [{ id: "run", progress: "Ended" }],
        },
        { id: "planned", name: "Receipt preferences", purpose: "Review", attempts: [] },
      ],
      selectedRunId: "run",
      selectionRequest: { runId: "run", artifactId: "exact-artifact" },
      onSelect: vi.fn(),
      evidence: <p>Exact referenced source</p>,
    };
    const view = render(<JourneyEvidenceDesign {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /02 Receipt preferences No attempts yet/ }));
    expect(screen.queryByText("Exact referenced source")).toBeNull();
    view.rerender(
      <JourneyEvidenceDesign {...props} selectionRequest={{ ...props.selectionRequest }} />,
    );
    expect(screen.getByText("Exact referenced source")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Saved order \/ Attempt 1 of 1/ })).toBeTruthy();
  });
  it("explains a new mission without inventing work or a report", () => {
    render(
      <MissionDetailDesign
        mission={{
          id: "private",
          title: "Account preferences",
          instruction: "Review account settings",
          state: "planning",
          objectives: [],
          flows: [],
          runs: [],
        }}
        onBack={() => {}}
        journeys={<JourneyEvidenceDesign journeys={[]} onSelect={() => {}} evidence={null} />}
      />,
    );
    expect(screen.getByText("No objectives have been defined yet.")).toBeTruthy();
    expect(screen.getByText("Journeys will appear here when testing begins.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Read test report/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Attempt \d/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "View evidence" })).toBeNull();
  });
  it("keeps the brief on demand without remounting evidence", () => {
    const mission = {
      id: "private-mission",
      title: "Review checkout",
      instruction: "Save and reopen",
      state: "completed",
      objectives: [],
      flows: [
        {
          id: "private-flow",
          name: "Reopen checkout",
          purpose: "Confirm persistence",
          state: "completed",
          revision: 1,
        },
      ],
      runs: [
        {
          id: "private-attempt",
          flowId: "private-flow",
          objectiveId: "private-objective",
          state: "passed",
        },
      ],
    };
    render(
      <MissionDetailDesign
        mission={mission}
        onBack={() => {}}
        journeys={
          <JourneyEvidenceDesign
            journeys={[
              {
                id: "private-flow",
                name: "Reopen checkout",
                purpose: "Confirm persistence",
                attempts: [{ id: "private-attempt", progress: "Ended" }],
              },
            ]}
            selectedRunId="private-attempt"
            onSelect={() => {}}
            evidence={<p>Original source material</p>}
          />
        }
      />,
    );
    const brief = screen.getByText("Request & objectives").closest("details")!;
    const source = screen.getByText("Original source material");
    expect(brief.open).toBe(false);
    fireEvent.click(brief.querySelector("summary")!);
    expect(brief.open).toBe(true);
    expect(screen.getByRole("region", { name: "Objectives" })).toBeTruthy();
    fireEvent.click(brief.querySelector("summary")!);
    expect(brief.open).toBe(false);
    expect(screen.getByText("Original source material")).toBe(source);
  });
  it("does not relabel historical verification as an application concern", () => {
    render(
      <ReportNarrative
        value={{ verification: ["The order was reopened"] }}
        onEvidence={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Earlier test notes" })).toBeTruthy();
    expect(screen.getByText("The order was reopened")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Possible issues" })).toBeNull();
  });
  it("rejects inherited property names as report statuses", () => {
    for (const status of ["__proto__", "constructor", "toString", "unknown"]) {
      expect(
        reportNarrative({
          presentation: {
            checks: [{ title: "Malformed check", actual: "Untrusted status", status }],
          },
        }).checks,
      ).toEqual([]);
    }
  });
  it("keeps every exact check and observation reference reachable", () => {
    const onEvidence = vi.fn();
    const refs = [
      { runId: "first", artifactId: "a".repeat(64) },
      { runId: "second", artifactId: "b".repeat(64) },
    ];
    render(
      <ReportNarrative
        onEvidence={onEvidence}
        value={{
          presentation: {
            checks: [
              {
                title: "Saved order",
                actual: "Reopened",
                status: "matched_expectation",
                evidence: refs,
              },
            ],
            observations: [
              { title: "Narrow layout", detail: "Confirm the wrapping", evidence: refs },
            ],
          },
        }}
      />,
    );
    fireEvent.click(
      within(document.getElementById("checks")!).getByRole("button", {
        name: "View recordings & screenshots 1",
      }),
    );
    fireEvent.click(
      within(document.getElementById("checks")!).getByRole("button", {
        name: "View recordings & screenshots 2",
      }),
    );
    fireEvent.click(
      within(document.getElementById("observations")!).getByRole("button", {
        name: "View recordings & screenshots 2",
      }),
    );
    expect(onEvidence.mock.calls.map(([ref]) => ref)).toEqual([refs[0], refs[1], refs[1]]);
    expect(onEvidence.mock.calls.map(([, context]) => context.section)).toEqual([
      "checks",
      "checks",
      "observations",
    ]);
  });
  it("keeps source evidence mounted before and after an exact reference is requested", () => {
    const props = {
      report,
      content: emptyContent,
      onBack: vi.fn(),
      onMission: vi.fn(),
      onEvidence: vi.fn(),
      evidence: <button>Available recording</button>,
    };
    const view = render(<ReportDetailDesign {...props} evidenceRequested={false} />);
    const media = screen.getByRole("button", { name: "Available recording", hidden: true });
    expect(
      screen.getByRole("link", { name: "Recordings & screenshots" }).getAttribute("href"),
    ).toBe("#supporting-evidence");
    view.rerender(<ReportDetailDesign {...props} evidenceRequested />);
    expect(screen.getByRole("button", { name: "Available recording" })).toBe(media);
    expect(screen.getByText(/do not infer unrecorded coverage/)).toBeTruthy();
    expect(screen.getByText(/does not mean that every capability/)).toBeTruthy();
  });
  it("makes the report table of contents operable and preserves recording gaps", () => {
    render(
      <ReportDetailDesign
        report={{
          ...report,
          originalInstruction: "Review checkout",
          evidenceCoverage: { runs: 3, complete: 1, incomplete: 1, missing: 1, open: 0 },
        }}
        content={emptyContent}
        onBack={() => {}}
        onMission={() => {}}
        onEvidence={() => {}}
        evidence={<p>Available source material</p>}
        evidenceRequested={false}
      />,
    );
    const toggle = screen.getByRole("button", { name: "On this page" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("link", { name: "Original request" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("link", { name: "Recordings & screenshots" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Some footage is missing or incomplete",
    );
  });
  it("does not invent a report action before one exists or app verdicts from objective progress", () => {
    const mission = {
      id: "private-mission",
      title: "Review checkout",
      instruction: "Save and reopen",
      state: "running",
      objectives: [
        {
          id: "private-objective",
          title: "Saved order",
          description: "Confirm persistence",
          state: "passed",
        },
      ],
      flows: [],
      runs: [],
    };
    render(
      <MissionDetailDesign mission={mission} onBack={() => {}} journeys={<p>No journeys yet</p>} />,
    );
    expect(screen.queryByRole("button", { name: /Read test report/ })).toBeNull();
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/private-|passed|failed/);
  });
  it("bounds progress decoration for large objective counts", () => {
    const { container } = render(
      <MissionCollectionDesign
        missions={[
          {
            id: "private",
            title: "Long mission",
            originalInstruction: "Review many checks",
            state: "running",
            objectiveCount: 100_000,
            terminalObjectiveCount: 20_000,
            updatedAt: "2026-11-01T10:00:00Z",
          },
        ]}
        state="ready"
        onOpen={() => {}}
        onIntegrations={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText("20000 of 100000 objectives ended")).toBeTruthy();
    expect(container.querySelectorAll(".sp-work-track > span")).toHaveLength(1);
    expect((container.querySelector(".sp-work-track > span") as HTMLElement).style.width).toBe(
      "20%",
    );
  });
  it("searches and opens reports without leaking identifiers or fabricated results", () => {
    const onOpen = vi.fn();
    render(
      <ReportCollectionDesign
        reports={[
          report,
          {
            ...report,
            id: "private-other",
            missionTitle: "Account settings",
            summary: "Preferences reopened",
          },
        ]}
        state="ready"
        onOpen={onOpen}
        onMissions={() => {}}
        onRetry={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search reports" }), {
      target: { value: "  SAVED ORDERS  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open report: Review saved orders" }));
    expect(onOpen).toHaveBeenCalledWith("private-report");
    expect(screen.queryByRole("button", { name: /Open report: Account/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/private-|100%|passed|failed/);
  });
  it.each(["loading", "error", "ready"] as const)(
    "distinguishes the %s report collection from results",
    (state) => {
      const onRetry = vi.fn(),
        onMissions = vi.fn();
      render(
        <ReportCollectionDesign
          reports={[]}
          state={state}
          onOpen={() => {}}
          onMissions={onMissions}
          onRetry={onRetry}
        />,
      );
      expect(screen.queryByRole("searchbox")).toBeNull();
      if (state === "loading")
        expect(screen.getByRole("status").textContent).toContain("Loading reports");
      if (state === "error") {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onRetry).toHaveBeenCalledOnce();
      }
      if (state === "ready") {
        expect(screen.getByRole("heading", { name: "No reports yet" })).toBeTruthy();
        fireEvent.click(screen.getAllByRole("button", { name: /View missions/ }).at(-1)!);
        expect(onMissions).toHaveBeenCalledOnce();
      }
    },
  );
});
