// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunEvidence } from "./RunEvidence.js";
import { ReportNarrative, reportNarrative } from "./ReportNarrative.js";
import { api, apiBlob } from "../infrastructure/api/client.js";
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
  it("shows an obvious library placeholder while the media list is pending", () => {
    vi.mocked(api).mockReturnValueOnce(new Promise(() => {}));
    render(<RunEvidence runId="pending-list" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Loading recordings & screenshots");
    expect(status.querySelector(".ev-loading-spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(".ev-loading-cards > div")).toHaveLength(4);
    expect(apiBlob).not.toHaveBeenCalled();
  });
  it("shows download, browser preparation and buffering states, then clears them on ready or error", async () => {
    let finish: (blob: Blob) => void = () => {};
    vi.mocked(apiBlob).mockReturnValueOnce(
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
    );
    render(<RunEvidence runId="pending-video" />);
    expect(await screen.findByText("Loading recording…")).toBeTruthy();
    expect(document.querySelector(".ev-loading-spinner")).toBeTruthy();
    await act(async () => finish(new Blob(["fictional media"])));
    const video = await screen.findByLabelText("Browser recording");
    expect(screen.getByText("Preparing recording…")).toBeTruthy();
    fireEvent.loadedData(video);
    expect(screen.queryByText("Preparing recording…")).toBeNull();
    expect(document.querySelector(".ne-viewer")?.getAttribute("aria-busy")).toBe("false");
    fireEvent.waiting(video);
    expect(screen.getByText("Buffering recording…")).toBeTruthy();
    fireEvent.playing(video);
    expect(screen.queryByText("Buffering recording…")).toBeNull();
    fireEvent.waiting(video);
    fireEvent.error(video);
    expect(screen.getByRole("alert").textContent).toContain("cannot be played");
    expect(screen.queryByText("Buffering recording…")).toBeNull();
  });
  it("keeps the screenshot loader until the image loads and never reuses another item's readiness", async () => {
    render(<RunEvidence runId="image-ready" initialArtifactId={"b".repeat(64)} />);
    const image = await screen.findByAltText("Project after reopening");
    expect(screen.getByText("Preparing screenshot…")).toBeTruthy();
    fireEvent.load(image);
    expect(screen.queryByText("Preparing screenshot…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Recordings/ }));
    await screen.findByLabelText("Browser recording");
    expect(screen.getByText("Preparing recording…")).toBeTruthy();
    expect(screen.queryByAltText("Project after reopening")).toBeNull();
  });
  it("separates media types and bounds a large screenshot set without fetching unseen items", async () => {
    const images = Array.from({ length: 18 }, (_, index) => ({
      ...media[1]!,
      index: index + 1,
      title: `State ${index + 1}`,
      artifactId: String(index + 1).padStart(64, "0"),
    }));
    vi.mocked(api).mockResolvedValue({
      items: [media[0], ...images],
      warning: "Review before sharing.",
    });
    render(<RunEvidence runId="many" initialArtifactId={images[16]!.artifactId} />);
    expect(await screen.findByAltText("State 17")).toBeTruthy();
    expect(screen.getByText("Screenshot 17 of 18")).toBeTruthy();
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
    expect(document.querySelectorAll(".ne-items button")).toHaveLength(2);
    expect(apiBlob).toHaveBeenCalledTimes(1);
    expect(apiBlob).toHaveBeenCalledWith("/runs/many/media/17", expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Previous items" }));
    expect(document.querySelectorAll(".ne-items button")).toHaveLength(8);
    expect(apiBlob).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
    expect(await screen.findByAltText("State 18")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next screenshot" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: /Recordings/ }));
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(apiBlob).toHaveBeenLastCalledWith("/runs/many/media/0", expect.any(AbortSignal));
  });
  it("retries a media-list failure without dropping the warning or inventing a result", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_ERROR"));
    render(<RunEvidence runId="recover" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Refresh the evidence list");
    expect(screen.queryByText("PRIVATE_PROVIDER_ERROR")).toBeNull();
    expect(screen.getByText(/Automatic redaction is best effort/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("keeps unavailable media types disabled and preserves the partial-recording caveat", async () => {
    vi.mocked(api).mockResolvedValue({
      items: [{ ...media[0], coverage: "partial", durationMs: 65000 }],
      warning: "Masking is best effort.",
    });
    render(<RunEvidence runId="partial" />);
    expect(await screen.findByText("Recording 1 of 1 · 1:05")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Screenshots/ }).hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/covers only part of the attempt/)).toBeTruthy();
    expect(screen.queryByText(/all scenarios passed/i)).toBeNull();
  });
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
    expect(screen.getByRole("heading", { name: "All test results" })).toBeTruthy();
    expect(
      screen.getByText("All three revised lines remained visible", { selector: "dd" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Worked as expected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not tested").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Didn’t work as expected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Couldn’t confirm").length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getByRole("button", { name: /Screenshots/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Screenshots/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Screenshots/ }));
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
    fireEvent.click(screen.getByRole("button", { name: "View recordings & screenshots" }));
    expect(onEvidence).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ title: "Recovered input", section: "observations" }),
    );
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
