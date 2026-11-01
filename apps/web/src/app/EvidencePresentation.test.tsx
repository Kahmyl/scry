// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidence } from "./RunEvidence.js";
import { ReportNarrative, reportNarrative } from "./ReportNarrative.js";
import { api, apiBlob } from "../infrastructure/api/client.js";
import { mockSelectBrowserApis } from "../../test/select-dom.js";
vi.mock("../infrastructure/api/client.js", () => ({ api: vi.fn(), apiBlob: vi.fn() }));
const media = [
  {
    index: 0,
    artifactId: "a".repeat(64),
    kind: "video",
    title: "Save and reopen the project",
    description: "Native timing, including the save wait.",
    timestamp: 1000,
    coverage: "complete",
  },
  {
    index: 1,
    artifactId: "b".repeat(64),
    kind: "screenshot",
    title: "Project after reopening",
    timestamp: 2000,
  },
];
beforeEach(() => {
  mockSelectBrowserApis();
  vi.mocked(api).mockResolvedValue({
    items: media,
    warning: "Best effort masking; review before sharing.",
  });
  vi.mocked(apiBlob).mockResolvedValue(new Blob(["fictional media"]));
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:fictional-evidence"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("human-readable evidence and report presentation", () => {
  it("reports application checks without treating execution status as a test verdict", () => {
    render(
      <ReportNarrative
        onEvidence={() => {}}
        value={{
          presentation: {
            subject: "application",
            scope: ["Save and reopen a design"],
            checks: [
              {
                title: "Revised text persists",
                expected: "Readable revised text after reopening",
                actual: "All three revised lines remained visible",
                status: "matched_expectation",
                evidence: [],
              },
              {
                title: "Safari layout",
                actual: "This browser was not included",
                status: "not_tested",
                evidence: [],
              },
              {
                title: "Welcome layout",
                expected: "One line",
                actual: "The message wrapped",
                status: "different_from_expectation",
                evidence: [],
              },
              {
                title: "Email delivery",
                actual: "Delivery was not independently confirmed",
                status: "inconclusive",
                evidence: [],
              },
            ],
            observations: [
              {
                title: "Pasted text initially invisible",
                detail: "The text layer existed but its glyphs were absent",
                evidence: [],
              },
            ],
            limitations: ["Only Chromium was tested"],
          },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Application checks" })).toBeTruthy();
    expect(screen.getByText("All three revised lines remained visible")).toBeTruthy();
    expect(screen.getByText("As expected")).toBeTruthy();
    expect(screen.getByText("Not tested")).toBeTruthy();
    expect(screen.getByText("Different from expected")).toBeTruthy();
    expect(screen.getByText("Needs confirmation")).toBeTruthy();
    expect(screen.queryByText(/recovered interaction problems/)).toBeNull();
    expect(screen.queryByText(/passed|failed/)).toBeNull();
  });
  it("defaults to original timing without autoplay and releases replaced media", async () => {
    const view = render(<RunEvidence runId="run-one" />);
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe("blob:fictional-evidence"),
    );
    const video = document.querySelector("video")!;
    expect(video.autoplay).toBe(false);
    expect(video.playbackRate).toBe(1);
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "0.5" } });
    expect(video.playbackRate).toBe(0.5);
    expect(screen.getByText("Native timing, including the save wait.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Project after reopening/ }));
    expect(await screen.findByAltText("Project after reopening")).toBeTruthy();
    const fullSize = screen.getByRole("link", { name: "Open full-size screenshot" });
    expect(fullSize.getAttribute("href")).toBe("blob:fictional-evidence");
    expect(fullSize.getAttribute("rel")).toBe("noopener noreferrer");
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it("opens exactly the referenced artifact and never substitutes another when it is missing", async () => {
    const view = render(<RunEvidence runId="run-one" initialArtifactId={"f".repeat(64)} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("not a substitute"),
    );
    expect(apiBlob).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Choose evidence" }), {
      key: "ArrowDown",
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Project after reopening · Screenshot" }),
    );
    expect(await screen.findByAltText("Project after reopening")).toBeTruthy();
    view.rerender(<RunEvidence runId="run-two" initialArtifactId={"b".repeat(64)} />);
    await waitFor(() =>
      expect(apiBlob).toHaveBeenCalledWith("/runs/run-two/media/1", expect.any(AbortSignal)),
    );
  });
  it("aborts a pending media request when another item is selected", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(apiBlob).mockImplementationOnce(async (_path, input) => {
      signal = input;
      return await new Promise<Blob>(() => {});
    });
    render(<RunEvidence runId="run-one" />);
    await waitFor(() => expect(signal).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Project after reopening/ }));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByAltText("Project after reopening")).toBeTruthy();
  });
  it("connects observations to exact evidence and keeps limitations visible without rendering HTML", () => {
    const onEvidence = vi.fn(),
      ref = { runId: "attempt-one", artifactId: "a".repeat(64) };
    render(
      <ReportNarrative
        onEvidence={onEvidence}
        value={{
          presentation: {
            verified: ["Saved and reopened"],
            observations: [
              {
                title: "Recovered input",
                detail: "<script>not executable</script>",
                suggestion: "Inspect the original attempt.",
                evidence: [ref],
              },
            ],
            limitations: ["Other browsers were not tested"],
          },
        }}
      />,
    );
    expect(screen.getByText("Other browsers were not tested")).toBeTruthy();
    expect(screen.getByText("<script>not executable</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review supporting evidence" }));
    expect(onEvidence).toHaveBeenCalledWith(ref);
    expect(
      reportNarrative({ findings: [{ observation: "Historical observation." }] }).observations[0]
        ?.detail,
    ).toBe("Historical observation.");
  });
  it("does not claim all scenarios passed when a historical report lacks structured coverage", () => {
    render(<ReportNarrative onEvidence={() => {}} value={{ legacy: "Old report" }} />);
    expect(screen.getByText(/do not infer unrecorded coverage/)).toBeTruthy();
    expect(screen.getByText(/does not mean that every capability/)).toBeTruthy();
  });
});
