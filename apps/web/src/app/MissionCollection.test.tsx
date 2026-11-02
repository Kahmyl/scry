// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSelectBrowserApis } from "../../test/select-dom.js";
import { MissionCollection } from "./MissionCollection.js";

const missions = [
  {
    id: "private-id-one",
    title: "Checkout and payment",
    originalInstruction: "Save the delivery address",
    state: "completed",
    objectiveCount: 3,
    terminalObjectiveCount: 3,
    updatedAt: "2026-11-01T11:30:00Z",
    finalReportId: "private-report-id",
  },
  {
    id: "private-id-two",
    title: "Account preferences",
    originalInstruction: "Update the delivery address",
    state: "running",
    objectiveCount: 4,
    terminalObjectiveCount: 1,
    updatedAt: "2026-11-01T10:30:00Z",
  },
  {
    id: "private-id-three",
    title: "Search products",
    originalInstruction: "Try a long category name",
    state: "planning",
    objectiveCount: 0,
    terminalObjectiveCount: 0,
    updatedAt: "invalid",
  },
];
const setup = (items = missions, state: "ready" | "loading" | "error" = "ready") => {
  const callbacks = { onOpen: vi.fn(), onIntegrations: vi.fn(), onRetry: vi.fn() };
  const view = render(<MissionCollection missions={items} state={state} {...callbacks} />);
  return { ...view, ...callbacks };
};
beforeEach(mockSelectBrowserApis);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function chooseStatus(label: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Status" }), { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("missions list experience", () => {
  it("clamps the preview without shortening the stored request or its search coverage", () => {
    const instruction =
      "Review checkout and confirm delivery. ".repeat(60) + "Final special requirement";
    const { onOpen } = setup([{ ...missions[0]!, originalInstruction: instruction }]);
    const preview = document.querySelector(".sp-mission-preview")!;
    expect(preview.textContent!.length).toBeLessThanOrEqual(241);
    expect(preview.textContent).toMatch(/…$/);
    expect(preview.textContent).not.toContain("Final special requirement");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search missions" }), {
      target: { value: "Final special requirement" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Checkout and payment/ }));
    expect(onOpen).toHaveBeenCalledWith(missions[0]!.id);
  });
  it("groups the update date with the request and keeps progress free of arrows and dates", () => {
    setup();
    const row = screen.getByRole("button", { name: /Checkout and payment/ }).closest("article")!;
    expect(row.querySelector(".sp-row-copy time")?.getAttribute("datetime")).toBe(
      missions[0]!.updatedAt,
    );
    expect(row.querySelector(".sp-row-work time")).toBeNull();
    expect(row.querySelector(".tw-round-arrow")).toBeNull();
    expect(row.querySelector(".sp-row-work")?.textContent).toContain("3 of 3 objectives ended");
  });
  it("opens a custom labelled status list with an explicit selected option", async () => {
    setup();
    const select = screen.getByRole("combobox", { name: "Status" });
    expect(select.tagName).toBe("BUTTON");
    fireEvent.keyDown(select, { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "Status" })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "All statuses" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    fireEvent.click(screen.getByRole("option", { name: "Needs your input" }));
    expect(select.textContent).toBe("Needs your input");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "No matching missions" })).toBeTruthy();
  });
  it("opens the original mission without displaying IDs or inventing test results", () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Checkout and payment/ }));
    expect(onOpen).toHaveBeenCalledWith("private-id-one");
    expect(screen.getByText("Report ready")).toBeTruthy();
    expect(screen.getByText("3 of 3 objectives ended")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /private-id|private-report|evidence streams|passed|verified|100%/i,
    );
  });
  it("searches titles and requests without case or surrounding-space sensitivity", () => {
    setup();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search missions" }), {
      target: { value: "  DELIVERY  " },
    });
    expect(screen.getByRole("button", { name: /Checkout and payment/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Account preferences/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Search products/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("2 of 3 missions");
  });
  it("combines search and lifecycle filters, then clears both", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Search missions"), { target: { value: "delivery" } });
    chooseStatus("In progress");
    expect(screen.queryByRole("button", { name: /Checkout and payment/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Account preferences/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /Search products/ })).toBeTruthy();
    expect(screen.getByLabelText("Search missions")).toHaveProperty("value", "");
    expect(screen.getByRole("combobox", { name: "Status" }).textContent).toBe("All statuses");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
  it("distinguishes a filtered list with no matches from a new project", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Search missions"), {
      target: { value: "no such mission" },
    });
    expect(screen.getByRole("heading", { name: "No matching missions" })).toBeTruthy();
    expect(screen.queryByText("Start with something to test")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /Checkout and payment/ })).toBeTruthy();
  });
  it("provides a real integration destination for a new project", () => {
    const { onIntegrations } = setup([]);
    expect(
      screen.getByRole("heading", { name: "Your first mission starts with an agent" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect your agent" }));
    expect(onIntegrations).toHaveBeenCalledOnce();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
  it.each([
    ["planning", "Planning"],
    ["running", "In progress"],
    ["blocked", "On hold"],
    ["awaiting_user", "Needs your input"],
    ["completed", "Testing ended"],
    ["failed", "Ended"],
    ["ended", "Ended"],
    ["cancelled", "Cancelled"],
    ["PRIVATE_ENGINE_STATE", "Status unavailable"],
    ["__proto__", "Status unavailable"],
  ])("presents %s as progress, not an application verdict", (state, label) => {
    setup([{ ...missions[0]!, state }]);
    expect(
      screen.getByRole("button", { name: /Checkout and payment/ }).closest("article")!.textContent,
    ).toContain(label);
    expect(document.body.textContent).not.toContain("PRIVATE_ENGINE_STATE");
  });
  it("keeps unfamiliar lifecycle states discoverable", () => {
    setup([{ ...missions[0]!, state: "new_state" }]);
    chooseStatus("Status unavailable");
    expect(screen.getByRole("button", { name: /Checkout and payment/ })).toBeTruthy();
  });
  it("does not imply coverage from zero objectives or malformed counts/dates", () => {
    setup([
      { ...missions[0]!, objectiveCount: 0, terminalObjectiveCount: 0 },
      { ...missions[1]!, objectiveCount: 1, terminalObjectiveCount: 2 },
      missions[2]!,
    ]);
    expect(screen.getAllByText("No objectives yet")).toHaveLength(2);
    expect(screen.getByText("Progress unavailable")).toBeTruthy();
    expect(screen.getByText("Update time unavailable")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Invalid Date|100%/);
  });
  it("does not flash an empty state while loading", () => {
    setup([], "loading");
    expect(screen.getByRole("status").textContent).toContain("Loading missions");
    expect(screen.queryByText("Start with something to test")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
  it("offers retry without exposing an internal execution error", () => {
    const { onRetry } = setup([], "error");
    expect(screen.getByRole("alert").textContent).toContain("We couldn’t load missions");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText("Start with something to test")).toBeNull();
  });
});
