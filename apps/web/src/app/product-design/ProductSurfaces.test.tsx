// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OverviewSurface,
  RunCollectionSurface,
  RunDetailSurface,
  AccountSurface,
  MissionCollectionSurface,
  workLabel,
} from "./ProductSurfaces.js";
afterEach(cleanup);
const mission = {
  id: "private-mission",
  title: "Saved orders",
  originalInstruction: "Reopen checkout",
  state: "running",
  objectiveCount: 2,
  terminalObjectiveCount: 1,
  updatedAt: "2026-11-01T10:00:00Z",
};
const run = {
  id: "private-run",
  flowName: "Save delivery details",
  environmentName: "Test store",
  state: "running",
  artifactCount: 3,
  completeEvidenceStreams: 1,
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T11:00:00Z",
  baseOrigin: "https://store.example.test",
  flowPurpose: "Confirm persistence",
};
describe("Product surfaces with real view models", () => {
  it.each([
    ["completed", "Completed", "complete"],
    ["running", "In progress", "active"],
    ["failed", "Ended", "ended"],
    ["cancelled", "Cancelled", "ended"],
    ["blocked", "On hold", "attention"],
    ["awaiting_user", "Needs your input", "attention"],
    ["planning", "Planning", "planned"],
    ["__proto__", "Status unavailable", "unknown"],
  ])(
    "gives mission %s a labelled decorative status icon, not an application verdict",
    (state, label, tone) => {
      render(
        <MissionCollectionSurface
          missions={[{ ...mission, state: state! }]}
          state="ready"
          onOpen={() => {}}
          onRetry={() => {}}
          onIntegrations={() => {}}
        />,
      );
      const status = screen.getByText(label!).closest(".sp-work-state")!;
      expect(status.classList.contains(`sp-status-${tone}`)).toBe(true);
      expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(status.querySelector("svg")?.classList.contains("sp-status-icon")).toBe(true);
      expect(document.body.textContent).not.toMatch(/passed|failed|__proto__|100%/);
    },
  );
  it.each([
    ["passed", "Ended"],
    ["failed", "Ended"],
    ["infrastructure_error", "Ended"],
    ["running", "In progress"],
    ["__proto__", "Status unavailable"],
    ["private-runtime-state", "Status unavailable"],
  ])("maps %s to safe work progress", (state, label) => {
    expect(workLabel(state!)).toBe(label);
  });
  it("uses supplied counts and opens the original mission and attempt", () => {
    const onMission = vi.fn(),
      onRun = vi.fn(),
      onReports = vi.fn();
    render(
      <OverviewSurface
        missions={[mission]}
        runs={[run, { ...run, id: "second", state: "failed" }]}
        reportCount={2}
        onMission={onMission}
        onRun={onRun}
        onReports={onReports}
        onMissions={() => {}}
        onRuns={() => {}}
        onIntegrations={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "1 Active attempts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "2 Reports" }));
    fireEvent.click(screen.getByRole("button", { name: "Open mission: Saved orders" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Save delivery details/ })[0]!);
    expect(onMission).toHaveBeenCalledWith("private-mission");
    expect(onRun).toHaveBeenCalledWith("private-run");
    expect(onReports).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/private-|passed|failed|100%/);
  });
  it("searches attempt names and environments while keeping IDs out of the visible page", () => {
    const onOpen = vi.fn();
    render(
      <RunCollectionSurface
        runs={[
          run,
          {
            ...run,
            id: "second",
            flowName: "Review notifications",
            environmentName: "Account site",
          },
        ]}
        state="ready"
        onOpen={onOpen}
        onRetry={() => {}}
        onMissions={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  TEST STORE  " } });
    expect(screen.queryByRole("button", { name: /Review notifications/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save delivery details/ }));
    expect(onOpen).toHaveBeenCalledWith("private-run");
    expect(document.body.textContent).not.toContain("private-run");
  });
  it("retains the actual evidence node through polling changes and preserves recording limitations", () => {
    const props = {
      run,
      onBack: vi.fn(),
      recordingNotes: ["Only part of the attempt was recorded."],
      evidence: <video data-testid="original-media" controls />,
    };
    const view = render(<RunDetailSurface {...props} />);
    expect(screen.getByRole("heading", { name: run.flowName, level: 1 })).toBeTruthy();
    expect(document.querySelector(".sp-heading-mark")?.getAttribute("aria-hidden")).toBe("true");
    const media = screen.getByTestId("original-media");
    view.rerender(<RunDetailSurface {...props} run={{ ...run, state: "passed" }} />);
    expect(screen.getByTestId("original-media")).toBe(media);
    expect(screen.getByText("Only part of the attempt was recorded.")).toBeTruthy();
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open mission" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/private-run|passed|failed/);
  });
  it("does not invent account management actions", () => {
    render(<AccountSurface email="tester@example.test" />);
    expect(screen.getByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
    expect(document.querySelector(".sp-heading-mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("tester@example.test")).toBeTruthy();
    expect(screen.getByText(/configured identity provider/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
