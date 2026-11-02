// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportCheckBrowser, reportExcerpt } from "./ReportReview.js";
import { ReportDetailDesign } from "./TestingWorkspace.js";
import type { ReportContent } from "./testing-design-types.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", window.location.pathname);
});
const content: ReportContent = {
  scope: ["Checkout"],
  verified: [],
  limitations: ["Payments were not completed."],
  checks: Array.from({ length: 37 }, (_, index) => ({
    title: index === 36 ? "Saved card is unavailable" : `Check ${index + 1}`,
    expected: `Expected state ${index + 1}`,
    actual: `Observed state ${index + 1}`,
    label: index === 36 ? "Different from expected" : "As expected",
    evidence: [{ runId: `run-${index}`, artifactId: String(index % 10).repeat(64) }],
  })),
  observations: [
    { title: "Review spacing", detail: "Spacing needs product judgement.", evidence: [] },
  ],
};
const report = {
  id: "report",
  missionId: "mission",
  missionTitle: "Checkout review",
  summary: "Review of checkout",
  state: "final",
  createdAt: "2026-11-02",
};

describe("bounded report review", () => {
  it("organizes results by customer questions and retains the recorded reasons", () => {
    const input = {
      ...content,
      checks: [
        {
          ...content.checks[0]!,
          title: "Saved address",
          actual: "The address remained saved.",
          label: "As expected",
        },
        {
          ...content.checks[1]!,
          title: "Card setup",
          actual: "The secure card fields never loaded.",
          label: "Different from expected",
        },
        {
          ...content.checks[2]!,
          title: "Email receipt",
          actual: "The test inbox was unavailable; delivery could not be confirmed.",
          label: "Could not verify",
        },
        {
          ...content.checks[3]!,
          title: "Safari checkout",
          actual: "Safari was excluded from the requested test.",
          label: "Not tested",
        },
      ],
    };
    const original = JSON.stringify(input);
    render(
      <ReportDetailDesign
        report={report}
        content={input}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={<p>Original recordings</p>}
        evidenceRequested={false}
      />,
    );
    const links = within(screen.getByRole("navigation", { name: "Report sections" })).getAllByRole(
      "link",
    );
    expect(links.map((link) => link.textContent)).toEqual([
      "Summary",
      "Worked as expected1",
      "Didn’t work as expected1",
      "Couldn’t confirm1",
      "Not tested1",
      "Recordings & screenshots",
      "Possible issues1",
      "Testing coverage & gaps",
    ]);
    for (const [label, title, explanation] of [
      ["Worked as expected", "Saved address", "The address remained saved."],
      ["Didn’t work as expected", "Card setup", "The secure card fields never loaded."],
      [
        "Couldn’t confirm",
        "Email receipt",
        "The test inbox was unavailable; delivery could not be confirmed.",
      ],
      ["Not tested", "Safari checkout", "Safari was excluded from the requested test."],
    ] as const) {
      fireEvent.click(screen.getByRole("link", { name: new RegExp(`^${label}`) }));
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
      expect(screen.getByText(explanation!, { selector: "dd" })).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("1–1 of 1 test");
    }
    expect(JSON.stringify(input)).toBe(original);
  });
  it("restores outcome deep links and keeps the older all-results link usable", async () => {
    window.history.replaceState(null, "", "#checks-different");
    render(
      <ReportDetailDesign
        report={report}
        content={content}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Saved card is unavailable" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Didn’t work as expected/ }).getAttribute("aria-current"),
    ).toBe("location");
    window.history.replaceState(null, "", "#checks");
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "All test results" })).toBeTruthy(),
    );
    expect(screen.getByRole("status").textContent).toBe("1–8 of 37 tests");
  });
  it("does not carry a previous report's check query into another report", () => {
    const props = {
      content,
      onBack: vi.fn(),
      onMission: vi.fn(),
      onEvidence: vi.fn(),
      evidence: null,
      evidenceRequested: false,
    };
    const view = render(<ReportDetailDesign {...props} report={report} />);
    fireEvent.click(screen.getByRole("button", { name: /Saved card is unavailable/ }));
    expect(screen.getByRole("searchbox", { name: "Search test results" })).toHaveProperty(
      "value",
      "Saved card is unavailable",
    );
    view.rerender(<ReportDetailDesign {...props} report={{ ...report, id: "another-report" }} />);
    fireEvent.click(screen.getByRole("link", { name: /Worked as expected/ }));
    expect(screen.getByRole("searchbox", { name: "Search test results" })).toHaveProperty(
      "value",
      "",
    );
    expect(
      screen.getByRole("button", { name: "Worked as expected 36" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("surfaces a difference at the end of a long report without scrolling through successful checks", () => {
    const onEvidence = vi.fn();
    render(
      <ReportDetailDesign
        report={report}
        content={content}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={onEvidence}
        evidence={<p>Original media</p>}
        evidenceRequested={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Test results" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Check 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Saved card is unavailable/ }));
    expect(screen.getByRole("heading", { name: "Saved card is unavailable" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Check 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    expect(onEvidence).toHaveBeenCalledWith(content.checks[36]!.evidence[0]);
    expect(screen.getByRole("heading", { name: "Recordings & screenshots" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Recordings & screenshots" }).getAttribute("aria-current"),
    ).toBe("location");
  });
  it("bounds 37 checks to eight rows and keeps the final check and its exact evidence reachable", () => {
    const onEvidence = vi.fn();
    render(<ReportCheckBrowser content={content} onEvidence={onEvidence} />);
    expect(document.querySelectorAll(".rr-check")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Previous tests" }).hasAttribute("disabled")).toBe(
      true,
    );
    for (let page = 0; page < 4; page++)
      fireEvent.click(screen.getByRole("button", { name: "Next tests" }));
    expect(screen.getByRole("status").textContent).toBe("33–37 of 37 tests");
    expect(screen.getByRole("button", { name: "Next tests" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search test results" }), {
      target: { value: "  observed STATE 37  " },
    });
    expect(screen.getByRole("status").textContent).toBe("1–1 of 1 test");
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    expect(onEvidence).toHaveBeenCalledWith(
      content.checks[36]!.evidence[0],
      expect.objectContaining({ title: content.checks[36]!.title, section: "checks" }),
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent phrase" } });
    expect(screen.getByRole("status").textContent).toContain("No tests match");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(document.querySelectorAll(".rr-check")).toHaveLength(8);
  });
  it("does not treat not-tested or inconclusive checks as verified success", () => {
    const partial = {
      ...content,
      checks: [
        { ...content.checks[0]!, label: "Not tested" },
        { ...content.checks[1]!, label: "Needs confirmation" },
      ],
    };
    render(
      <ReportDetailDesign
        report={report}
        content={partial}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    expect(screen.getByRole("button", { name: "0 Worked as expected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 Not tested" })).toBeTruthy();
    expect(screen.getByText(/No tests were recorded as not working/)).toBeTruthy();
    expect(document.querySelector(".rr-coverage-limits")?.textContent).toContain(
      "Payments were not completed.",
    );
    expect(document.body.textContent).not.toMatch(/100%|all checks passed/i);
  });
  it("shows bounded recorded limitations beside scoped counts without changing report facts", () => {
    const limits = Array.from(
      { length: 11 },
      (_, i) => `Limit ${i + 1}: ${"Recorded boundary. ".repeat(30)}`,
    );
    const input = { ...content, limitations: limits };
    const original = JSON.stringify(input);
    render(
      <ReportDetailDesign
        report={report}
        content={input}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    expect(screen.getByText(/37 recorded tests/)).toBeTruthy();
    const panel = screen.getByRole("region", { name: "Testing limits" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    expect(within(panel).getAllByRole("listitem")[0]!.textContent!.length).toBeLessThanOrEqual(241);
    expect(screen.getByText(/first 4 of 11/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Read all 11 limits" }));
    expect(screen.getByText(limits[10]!.trim())).toBeTruthy();
    expect(JSON.stringify(input)).toBe(original);
  });
  it("keeps an absent limits statement honest even when all recorded checks match", () => {
    render(
      <ReportDetailDesign
        report={report}
        content={{ ...content, limitations: [], checks: [content.checks[0]!] }}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    expect(screen.getByText(/No limitations were recorded/)).toBeTruthy();
    expect(screen.getByText(/not unique issues or how much of the app/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/100%|all scenarios passed/i);
  });
  it("previews collapsed results and allows related comparisons to stay open together", () => {
    render(<ReportCheckBrowser content={content} onEvidence={vi.fn()} />);
    const rows = document.querySelectorAll(".rr-check");
    expect(rows[1]!.querySelector(".rr-check-preview")?.textContent).toBe("Observed state 2");
    expect(rows[0]!.hasAttribute("name")).toBe(false);
    expect(rows[1]!.hasAttribute("name")).toBe(false);
    fireEvent.click(rows[1]!.querySelector("summary")!);
    expect(rows[0]!.hasAttribute("open")).toBe(true);
    expect(rows[1]!.hasAttribute("open")).toBe(true);
  });
  it("returns from exact evidence to the same check, filter, page and keyboard position", async () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const onEvidence = vi.fn();
    render(
      <ReportDetailDesign
        report={report}
        content={content}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={onEvidence}
        evidence={<video data-testid="source-node" />}
        evidenceRequested={false}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: /Worked as expected/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next tests" }));
    const row = document.querySelector(".rr-check")!;
    const summary = row.querySelector("summary")!;
    const video = screen.getByTestId("source-node");
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "View recordings & screenshots" }),
    );
    expect(onEvidence).toHaveBeenCalledWith(content.checks[8]!.evidence[0]);
    expect(
      screen.getByRole("complementary", { name: "Evidence finding context" }).textContent,
    ).toContain("Check 9");
    fireEvent.click(screen.getByRole("button", { name: "Back to test result" }));
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(screen.getByRole("status").textContent).toBe("9–16 of 36 tests");
    expect(screen.getByTestId("source-node")).toBe(video);
    expect(scroll).toHaveBeenCalled();
  });
  it("retains an observation's context and drops it when a different report is opened", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const props = {
      content: {
        ...content,
        observations: [
          {
            title: "Spacing",
            detail: "Confirm spacing",
            evidence: [content.checks[0]!.evidence[0]!],
          },
        ],
      },
      onBack: vi.fn(),
      onMission: vi.fn(),
      onEvidence: vi.fn(),
      evidence: <p>Source</p>,
      evidenceRequested: false,
    };
    const view = render(<ReportDetailDesign {...props} report={report} />);
    fireEvent.click(screen.getByRole("link", { name: /Possible issues/ }));
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    expect(
      screen.getByRole("complementary", { name: "Evidence finding context" }).textContent,
    ).toContain("Spacing");
    fireEvent.click(screen.getByRole("button", { name: "Back to possible issue" }));
    await waitFor(() =>
      expect(document.activeElement?.closest("details")?.textContent).toContain("Spacing"),
    );
    view.rerender(<ReportDetailDesign {...props} report={{ ...report, id: "other" }} />);
    fireEvent.click(screen.getByRole("link", { name: "Recordings & screenshots" }));
    expect(screen.queryByRole("complementary", { name: "Evidence finding context" })).toBeNull();
  });
  it("keeps complete summary conclusions and expands only the remaining authored sentences", () => {
    const lead = "Access recovered. Saved preferences persisted. Card setup still fails.";
    const rest =
      "Only error responses were observed for some operations. Lab progression was excluded.";
    const summary = `${lead} ${rest}`;
    expect(reportExcerpt("  One   short line  ")).toBe("One short line");
    expect(reportExcerpt("Checkout could not be completed.", 30)).toBe("Checkout could not be…");
    render(
      <ReportDetailDesign
        report={{ ...report, summary }}
        content={content}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    expect(document.querySelector(".tw-report-summary")?.textContent).toBe(lead);
    expect(screen.getByText("More report detail")).toBeTruthy();
    expect(document.querySelector(".rr-full-summary p")?.textContent).toBe(rest);
    expect(
      `${document.querySelector(".tw-report-summary")?.textContent} ${document.querySelector(".rr-full-summary p")?.textContent}`,
    ).toBe(summary);
  });
  it("does not cut off the conclusion of a long single-sentence summary or limit", () => {
    const sentence = `After checking ${"a recorded step, ".repeat(35)}checkout still fails.`;
    render(
      <ReportDetailDesign
        report={{ ...report, summary: sentence }}
        content={{ ...content, limitations: [sentence] }}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    expect(document.querySelector(".tw-report-summary")?.textContent).toBe(sentence);
    expect(
      screen.getByRole("region", { name: "Testing limits" }).querySelector("li")?.textContent,
    ).toBe(sentence);
    expect(document.querySelector(".rr-full-summary")).toBeNull();
  });
  it("bounds observations and leaves historical verification reachable", () => {
    const many = {
      ...content,
      verified: ["Historical saved state"],
      observations: Array.from({ length: 19 }, (_, index) => ({
        title: `Observation ${index + 1}`,
        detail: `Detail ${index + 1}`,
        evidence: [],
      })),
    };
    render(
      <ReportDetailDesign
        report={report}
        content={many}
        onBack={vi.fn()}
        onMission={vi.fn()}
        onEvidence={vi.fn()}
        evidence={null}
        evidenceRequested={false}
      />,
    );
    fireEvent.click(screen.getByRole("link", { name: /Possible issues/ }));
    expect(document.querySelectorAll(".rr-observation")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Next possible issues" }));
    fireEvent.click(screen.getByRole("button", { name: "Next possible issues" }));
    expect(screen.getByRole("heading", { name: "Observation 19" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Earlier test notes" }));
    expect(screen.getByText("Historical saved state").closest("section[hidden]")).toBeNull();
  });
});
