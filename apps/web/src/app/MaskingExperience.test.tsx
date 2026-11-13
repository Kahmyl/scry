// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MaskingReview } from "./MaskingReview.js";
afterEach(cleanup);
const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

it("explains review action with recording-relative intervals without certifying disclosure or safety", () => {
  const seek = vi.fn();
  render(
    <MaskingReview
      recordingStart={100_000}
      onSeek={seek}
      diagnostics={{
        truncated: false,
        events: [
          { pageId, at: 112_000, state: "degraded", reason: "maintenance_timeout" },
          { pageId, at: 128_000, state: "recovered", reason: "refresh_confirmed" },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText("Masking review intervals"));
  expect(screen.getByText(/Review these parts before sharing/)).toBeTruthy();
  expect(screen.getByText(/0:12–0:28/)).toBeTruthy();
  expect(screen.getByText(/does not establish that information was disclosed/)).toBeTruthy();
  expect(screen.getByText(/does not certify the rest of the recording/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review this interval" }));
  expect(seek).toHaveBeenCalledWith(112_000);
});

it("labels an unconfirmed tail and incomplete diagnostic history without claiming current masking failed", () => {
  render(
    <MaskingReview
      recordingStart={100_000}
      diagnostics={{
        truncated: true,
        events: [{ pageId, at: 113_000, state: "degraded", reason: "installation_pending" }],
      }}
    />,
  );
  fireEvent.click(screen.getByText("Masking review intervals"));
  expect(screen.getByText(/0:13–end not confirmed/)).toBeTruthy();
  expect(screen.getByText(/Additional intervals were not retained/)).toBeTruthy();
  expect(screen.queryByText(/your data was exposed/i)).toBeNull();
});

it("does not present a review control as usable before the recording is ready", () => {
  const seek = vi.fn();
  render(
    <MaskingReview
      canSeek={false}
      onSeek={seek}
      diagnostics={{
        truncated: false,
        events: [{ pageId, at: 1000, state: "degraded", reason: "installation_pending" }],
      }}
    />,
  );
  fireEvent.click(screen.getByText("Masking review intervals"));
  const button = screen.getByRole("button", { name: "Review this interval" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(seek).not.toHaveBeenCalled();
  expect(screen.getByText(/available when the recording has loaded/)).toBeTruthy();
});

it("does not imply a masking failure or privacy certification from an empty diagnostic history", () => {
  render(<MaskingReview diagnostics={{ events: [], truncated: false }} />);
  expect(screen.getByText(/No specific masking review intervals were recorded/)).toBeTruthy();
  expect(screen.getByText(/does not certify the rest of the recording/)).toBeTruthy();
  expect(screen.queryByText(/could not be confirmed during these parts/)).toBeNull();
});
