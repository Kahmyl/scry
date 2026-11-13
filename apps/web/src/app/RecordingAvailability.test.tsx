// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunEvidence } from "./RunEvidence.js";
import { api, apiBlob, videoPlayback } from "../infrastructure/api/client.js";

vi.mock("../infrastructure/api/client.js", () => ({
  api: vi.fn(),
  apiBlob: vi.fn(),
  videoPlayback: vi.fn(),
  API_BASE: "/api",
}));
const publication = (items: unknown[] = []) => ({
  warning: "Protection is best effort; review evidence before sharing.",
  playbackRate: 1,
  items,
  recordingAssessment: { state: "withheld" },
});
beforeEach(() => {
  vi.mocked(api).mockResolvedValue(publication());
  vi.mocked(apiBlob).mockResolvedValue(new Blob(["fictional image"]));
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:fictional-image"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("explains withheld footage without suggesting it is pending or polling another endpoint", async () => {
  render(<RunEvidence runId="withheld" />);
  expect(await screen.findByText(/recording evidence was withheld/i)).toBeTruthy();
  expect(screen.queryByText(/No recordings or screenshots are available.*yet/i)).toBeNull();
  expect(screen.queryByText(/refresh to check again/i)).toBeNull();
  expect(screen.getByText(/does not establish an application result/i)).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith("/runs/withheld/media");
  expect(apiBlob).not.toHaveBeenCalled();
  expect(videoPlayback).not.toHaveBeenCalled();
});

it("keeps independently admitted screenshots usable alongside a recording gap", async () => {
  vi.mocked(api).mockResolvedValue(
    publication([
      {
        index: 0,
        kind: "screenshot",
        timestamp: 1000,
        title: "Saved safe state",
        artifactId: "a".repeat(64),
      },
    ]),
  );
  render(<RunEvidence runId="safe-other-media" />);
  const image = await screen.findByAltText("Saved safe state");
  expect(screen.getByText(/recording evidence was withheld/i)).toBeTruthy();
  fireEvent.load(image);
  expect(screen.queryByText("Preparing screenshot…")).toBeNull();
  expect(apiBlob).toHaveBeenCalledTimes(1);
  expect(apiBlob).toHaveBeenCalledWith("/runs/safe-other-media/media/0", expect.any(AbortSignal));
  expect(api).toHaveBeenCalledTimes(1);
  expect(videoPlayback).not.toHaveBeenCalled();
});

it("does not carry a different Run's withholding claim into a pending legacy list", async () => {
  const view = render(<RunEvidence runId="old-withheld" />);
  await screen.findByText(/recording evidence was withheld/i);
  let finish: (v: unknown) => void = () => {};
  vi.mocked(api).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  view.rerender(<RunEvidence runId="legacy" />);
  expect(screen.queryByText(/recording evidence was withheld/i)).toBeNull();
  expect(screen.getByText("Loading recordings & screenshots…")).toBeTruthy();
  await act(async () => finish({ items: [], playbackRate: 1, warning: "Best effort" }));
  expect(screen.getByText(/No recordings or screenshots are available.*yet/i)).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(2);
});

it("does not hide a separately admitted recording when another capture was withheld", async () => {
  vi.mocked(api).mockResolvedValue(
    publication([
      {
        index: 0,
        kind: "video",
        timestamp: 1000,
        title: "Safe independent recording",
        artifactId: "b".repeat(64),
        coverage: "complete",
      },
    ]),
  );
  vi.mocked(videoPlayback).mockResolvedValue({
    id: "safe-grant",
    path: "/media-playback/safe-grant",
  });
  render(<RunEvidence runId="safe-recording" />);
  const video = await screen.findByLabelText("Browser recording");
  expect(screen.getByText(/recording evidence was withheld/i)).toBeTruthy();
  expect(video.getAttribute("src")).toBe("/api/media-playback/safe-grant");
  fireEvent.loadedData(video);
  expect(screen.queryByText("Preparing recording…")).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
  expect(apiBlob).not.toHaveBeenCalled();
});
