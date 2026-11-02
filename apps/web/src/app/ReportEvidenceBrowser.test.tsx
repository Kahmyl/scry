// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportEvidenceBrowser } from "./ReportEvidenceBrowser.js";
import type { EvidenceRef } from "./testing-design-types.js";

afterEach(cleanup);
const journeys = Array.from({ length: 9 }, (_, index) => ({
  id: `activity-${index}`,
  name: `Test activity ${index + 1}`,
  purpose: `Review saved outcome ${index + 1}`,
  attempts: [{ id: `run-${index}`, progress: "Ended" }],
}));

describe("report recording library", () => {
  it("starts at a bounded searchable activity library without presenting the latest attempt as the report", () => {
    render(
      <ReportEvidenceBrowser
        journeys={journeys}
        onSelect={vi.fn()}
        evidence={<p>Unselected media must not mount</p>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Browse by test activity" })).toBeTruthy();
    expect(screen.queryByText("Unselected media must not mount")).toBeNull();
    expect(document.querySelectorAll(".re-activities button")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Next activities" }));
    expect(screen.getByRole("button", { name: /Test activity 9/ })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "saved outcome 9" } });
    expect(document.querySelectorAll(".re-activities button")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no match" } });
    expect(screen.getByRole("status").textContent).toContain("No activities match");
  });
  it("opens exact references immediately and allows deliberate browsing and attempt changes", () => {
    const onSelect = vi.fn();
    const props = {
      journeys: [
        {
          ...journeys[0]!,
          attempts: [
            { id: "first", progress: "Ended" },
            { id: "second", progress: "Ended" },
          ],
        },
      ],
      onSelect,
      evidence: <p>Exact media</p>,
    };
    const request = { runId: "second", artifactId: "a".repeat(64) };
    const view = render(
      <ReportEvidenceBrowser {...props} selectedRunId="second" selectionRequest={request} />,
    );
    expect(screen.getByText("Exact media")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attempt 2" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Attempt 1" }));
    expect(onSelect).toHaveBeenLastCalledWith("first");
    fireEvent.click(screen.getByRole("button", { name: "All test activities" }));
    expect(screen.queryByText("Exact media")).toBeNull();
    view.rerender(
      <ReportEvidenceBrowser {...props} selectedRunId="second" selectionRequest={{ ...request }} />,
    );
    expect(screen.getByText("Exact media")).toBeTruthy();
  });
  it("shows empty activities honestly and restores a new exact link without substituting media", () => {
    const props = {
      journeys: [
        ...journeys,
        { id: "empty", name: "Not yet attempted", purpose: "No footage exists", attempts: [] },
      ],
      onSelect: vi.fn(),
      evidence: <p>Earlier media</p>,
    };
    const view = render(<ReportEvidenceBrowser {...props} selectedRunId="run-0" />);
    fireEvent.click(screen.getByRole("button", { name: "All test activities" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Not yet attempted" } });
    fireEvent.click(screen.getByRole("button", { name: /Not yet attempted/ }));
    expect(screen.queryByText("Earlier media")).toBeNull();
    expect(screen.getByText(/No attempt was recorded/)).toBeTruthy();
    view.rerender(
      <ReportEvidenceBrowser
        {...props}
        selectedRunId="foreign-run"
        selectionRequest={{ runId: "foreign-run" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "will not replace the missing evidence",
    );
    expect(screen.queryByText("Earlier media")).toBeNull();
  });
  it("keeps all attempts reachable after selecting a named activity", () => {
    function Library() {
      const [selection, setSelection] = useState<EvidenceRef>();
      return (
        <ReportEvidenceBrowser
          journeys={[
            {
              ...journeys[0]!,
              attempts: [
                { id: "first", progress: "Ended" },
                { id: "second", progress: "Ended" },
              ],
            },
          ]}
          {...(selection ? { selectedRunId: selection.runId, selectionRequest: selection } : {})}
          onSelect={(runId) => setSelection({ runId })}
          evidence={<p>Media for {selection?.runId}</p>}
        />
      );
    }
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: /Test activity 1/ }));
    expect(screen.getByText("Media for first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attempt 2" }));
    expect(screen.getByText("Media for second")).toBeTruthy();
  });
});
